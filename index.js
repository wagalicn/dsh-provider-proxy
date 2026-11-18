/**
 * dsh-provider-proxy — per-provider HTTP proxy routing for DeepSeek Harness.
 *
 * The plugin owns a fully independent table of provider endpoints:
 *
 *   providers:
 *     - provider: bedrock
 *       baseURL: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1
 *       proxy:   http://127.0.0.1:7890
 *     - provider: deepseek
 *       baseURL: https://api.deepseek.com
 *       proxy:   ""            # empty = direct
 *
 * Every outbound request is matched by hostname against that table: a row with
 * a proxy goes through that proxy, a row without one goes direct, and a host
 * that is not listed also goes direct. Nothing is inherited from the ambient
 * HTTP_PROXY / HTTPS_PROXY environment.
 *
 * Two layers are installed, because harness builds differ in which `fetch`
 * they expose (plain undici, or an Electron wrapper that ignores the undici
 * global dispatcher):
 *
 *   1. `globalThis.fetch` is wrapped: requests whose host matches a row with a
 *      proxy are re-issued through `undici.fetch` with a ProxyAgent; every
 *      other request falls through to the original fetch untouched.
 *   2. The undici global dispatcher is swapped as well, so code that uses
 *      undici directly (not `fetch`) gets the same routing.
 *
 * `providers` is a volatile config field: it resolves to a live handle
 * (`{ get() }`), so the table is rebuilt whenever its content changes (on
 * `settings/document-updated`, and on a slow poll as a fallback).
 *
 * Diagnostics are appended to `~/.dsh/provider-proxy.log` (capped) — that file
 * records the fetch identity seen at apply time and one line per routed
 * request, which is what to read when a proxy "does not seem to work".
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import z from "@deepseek-ai/schemastery";
import {
  Agent,
  Pool,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

const SUPPORTED_PROXY = /^https?:\/\//i;
const POLL_MS = 1000;
const LOG_PATH = path.join(os.homedir(), ".dsh", "provider-proxy.log");
const LOG_MAX_BYTES = 256 * 1024;

const ProviderEndpoint = z.object({
  provider: z
    .string()
    .default("")
    .description("名称，仅作标签，建议与设置 → 模型 里的提供商 id 一致"),
  baseURL: z
    .string()
    .required()
    .description("该提供商的接口地址，例如 https://api.openai.com/v1"),
  proxy: z
    .string()
    .default("")
    .description("该提供商使用的 HTTP 代理，例如 http://127.0.0.1:7890；留空表示直连"),
});

export const Config = z.object({
  providers: z
    .array(ProviderEndpoint)
    .default([])
    .volatile()
    .description("每个提供商一行：接口地址 + 可选代理"),
  biliMode: z
    .union(["off", "mirror", "system"])
    .default("mirror")
    .volatile()
    .description(
      "同时配置 billion-context（bili）代理：off=不动；mirror=把本页的接口地址+代理写进 bili 配置；system=让 bili 走系统代理",
    ),
  biliConfigPath: z
    .string()
    .default("")
    .volatile()
    .description("bili 配置文件路径，留空用默认 %USERPROFILE%\\.config\\billion-context\\billion-context.json"),
  debug: z
    .boolean()
    .default(false)
    .volatile()
    .description("在 ~/.dsh/provider-proxy.log 里记录每次路由决策"),
  systemProxy: z
    .boolean()
    .default(false)
    .volatile()
    .description("未命中列表的地址改为跟随系统代理（Windows 注册表 / HTTPS_PROXY），不勾选则一律直连"),
});

/* ------------------------------------------------------------------ log -- */

function logLine(text) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, "");
    } catch {
      /* missing file is fine */
    }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`);
  } catch {
    /* logging must never break routing */
  }
}

/* -------------------------------------------------------- system proxy -- */

const SYSTEM_PROXY_TTL_MS = 30_000;
let systemProxyCache = { at: 0, url: undefined };

function readWindowsProxy() {
  if (process.platform !== "win32") return undefined;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const run = (name) =>
    execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true });
  try {
    if (!/0x1\b/.test(run("ProxyEnable"))) return undefined;
  } catch {
    return undefined;
  }
  let raw;
  try {
    const out = run("ProxyServer");
    const match = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (match === null) return undefined;
    raw = match[1].trim();
  } catch {
    return undefined;
  }
  if (raw.includes("=")) {
    const parts = new Map();
    for (const piece of raw.split(";")) {
      const [scheme, value] = piece.split("=");
      if (value !== undefined) parts.set(scheme.trim().toLowerCase(), value.trim());
    }
    raw = parts.get("https") ?? parts.get("http") ?? "";
  }
  if (raw === "") return undefined;
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

/** System-wide proxy, refreshed at most every 30s; undefined means “none”. */
function detectSystemProxy(force) {
  const now = Date.now();
  if (!force && now - systemProxyCache.at < SYSTEM_PROXY_TTL_MS) return systemProxyCache.url;
  let url = readWindowsProxy();
  if (url === undefined) {
    const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (typeof env === "string" && /^https?:\/\//i.test(env.trim())) url = env.trim();
  }
  systemProxyCache = { at: now, url };
  return url;
}

/* -------------------------------------------------------------- helpers -- */

/** Read a config field that may be a plain value or a volatile live handle. */
function readLive(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** Turn an endpoint address into an exact host or a wildcard host matcher. */
function matcherOf(baseURL) {
  let raw = String(baseURL ?? "").trim();
  if (raw === "") return undefined;
  raw = raw.replace(/^[a-z]+:\/\//i, "").split("/")[0].split(":")[0].toLowerCase();
  if (raw === "") return undefined;
  if (raw.includes("*")) {
    const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+");
    return { raw, regex: new RegExp(`^${escaped}$`) };
  }
  return { raw, host: raw };
}

/** Proxy URL when it is usable by undici, otherwise undefined (meaning direct). */
function normalizeProxy(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return undefined;
  return SUPPORTED_PROXY.test(raw) ? raw : undefined;
}

/** Build the routing rules plus a list of configuration problems. */
function buildRoutes(providers) {
  const routes = [];
  const problems = [];
  for (const endpoint of Array.isArray(providers) ? providers : []) {
    const label = String(endpoint?.provider ?? "").trim() || String(endpoint?.baseURL ?? "");
    const matcher = matcherOf(endpoint?.baseURL);
    if (matcher === undefined) {
      problems.push(`${label}: 接口地址为空或无法解析（"${endpoint?.baseURL ?? ""}"），已跳过`);
      continue;
    }
    const rawProxy = String(endpoint?.proxy ?? "").trim();
    const proxy = normalizeProxy(rawProxy);
    if (rawProxy !== "" && proxy === undefined) {
      problems.push(`${label}: 代理 "${rawProxy}" 不受支持（仅支持 http:// 与 https://），已按直连处理`);
    }
    routes.push({ ...matcher, proxy });
  }
  return { routes, problems };
}

/** Cheap content signature, so the table is only rebuilt when it changes. */
function signatureOf(providers) {
  return (Array.isArray(providers) ? providers : [])
    .map((endpoint) => `${endpoint?.provider ?? ""}\u0000${endpoint?.baseURL ?? ""}\u0000${endpoint?.proxy ?? ""}`)
    .join("\u0001");
}

/** Where billion-context keeps its config. */
function biliConfigPathOf(configured) {
  const raw = String(configured ?? "").trim();
  if (raw !== "") return raw;
  return path.join(process.env.USERPROFILE || os.homedir(), ".config", "billion-context", "billion-context.json");
}

/**
 * Mirror this plugin's table into billion-context's own config.
 *
 * bili is an LLM proxy: DSH talks to it on 127.0.0.1, and bili's own node
 * process makes the real upstream request. The routing installed in this
 * process therefore never sees that hop. bili accepts a per-provider
 * `providers.<url>.proxy` and a global `upstreamProxyMode`, which is what this
 * writes; the keys it wrote are remembered in `providerProxyManaged` so they
 * can be replaced or removed again.
 */
function syncBili(providers, mode, configuredPath) {
  if (mode !== "mirror" && mode !== "system") return;
  const file = biliConfigPathOf(configuredPath);
  let doc;
  try {
    if (!fs.existsSync(file)) return;
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return;
  } catch (error) {
    logLine(`bili sync: cannot read ${file} (${error?.message ?? error})`);
    return;
  }

  const before = JSON.stringify(doc);
  const managed = new Set(Array.isArray(doc.providerProxyManaged) ? doc.providerProxyManaged : []);
  const providersDoc =
    doc.providers !== null && typeof doc.providers === "object" && !Array.isArray(doc.providers) ? { ...doc.providers } : {};
  for (const key of managed) delete providersDoc[key];
  managed.clear();

  if (mode === "system") {
    doc.upstreamProxyMode = "auto";
  } else {
    for (const endpoint of Array.isArray(providers) ? providers : []) {
      const base = String(endpoint?.baseURL ?? "").trim();
      const proxy = normalizeProxy(endpoint?.proxy);
      if (base === "" || proxy === undefined) continue;
      const keys = new Set([base.replace(/\/+$/, "")]);
      try {
        keys.add(new URL(/^[a-z]+:\/\//i.test(base) ? base : `https://${base}`).origin);
      } catch {
        /* not a URL — the trimmed base is enough */
      }
      for (const key of keys) {
        if (key === "") continue;
        providersDoc[key] = { ...(providersDoc[key] ?? {}), proxy };
        managed.add(key);
      }
    }
  }

  if (managed.size > 0) {
    doc.providers = providersDoc;
    doc.providerProxyManaged = [...managed];
  } else {
    if (Object.keys(providersDoc).length === 0) delete doc.providers;
    else doc.providers = providersDoc;
    delete doc.providerProxyManaged;
  }

  if (JSON.stringify(doc) === before) return;
  try {
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    logLine(`bili sync (${mode}): ${managed.size} provider entr${managed.size === 1 ? "y" : "ies"} -> ${file}`);
  } catch (error) {
    logLine(`bili sync: cannot write ${file} (${error?.message ?? error})`);
  }
}

/** URL string of whatever was handed to fetch. */
function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return String(input ?? "");
}

/** Merge a Request object into an init the way undici's fetch expects. */
function initOf(input, init) {
  if (input && typeof input === "object" && typeof input.url === "string" && typeof input.method === "string") {
    return {
      method: input.method,
      headers: input.headers,
      body: input.body ?? undefined,
      duplex: "half",
      signal: init?.signal ?? input.signal,
      ...(init ?? {}),
    };
  }
  return init ?? {};
}

/* ---------------------------------------------------------------- plugin -- */

export function apply(ctx, config) {
  const previousDispatcher = getGlobalDispatcher();
  const previousFetch = globalThis.fetch;
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

  logLine(
    `apply v1.0.0 pid=${process.pid} node=${process.version} ` +
      `fetch=${typeof previousFetch} name=${previousFetch?.name ?? "-"} ` +
      `descriptor=${fetchDescriptor ? `get:${typeof fetchDescriptor.get} writable:${fetchDescriptor.writable}` : "none"} ` +
      `dispatcher=${previousDispatcher?.constructor?.name ?? "-"}`,
  );

  let routes = [];
  let signature;
  let biliSignature;
  let systemFallback = false;
  let agent;
  const proxyAgents = new Map();
  let installedFetch;

  function proxyAgentFor(proxy) {
    let created = proxyAgents.get(proxy);
    if (created === undefined) {
      created = new ProxyAgent({ uri: proxy });
      proxyAgents.set(proxy, created);
    }
    return created;
  }

  const seenHosts = new Set();

  /** Resolve a request host against the rules; exact hosts win over wildcards. */
  function proxyFor(url) {
    const host = String(url.hostname ?? "").toLowerCase();
    let wildcard;
    for (const rule of routes) {
      if (rule.host !== undefined) {
        if (rule.host === host) return rule.proxy;
        continue;
      }
      if (rule.regex !== undefined && rule.regex.test(host)) wildcard = rule.proxy;
    }
    if (wildcard !== undefined) return wildcard;
    if (systemFallback) {
      const system = detectSystemProxy(false);
      if (system !== undefined) return system;
    }
    return undefined;
  }

  /** Is this host covered by any rule (even a direct one)? */
  function covers(url) {
    const host = String(url.hostname ?? "").toLowerCase();
    return routes.some((rule) => (rule.host !== undefined ? rule.host === host : rule.regex?.test(host) === true));
  }

  /** Record each distinct host once, so a missing rule can be diagnosed. */
  function noteHost(url, proxy) {
    if (seenHosts.size >= 200) return;
    const key = `${url.hostname}|${proxy ?? "direct"}`;
    if (seenHosts.has(key)) return;
    seenHosts.add(key);
    logLine(`host ${url.hostname} -> ${proxy ?? "direct"}${covers(url) ? "" : " (未命中任何规则，直连)"}`);
  }

  function rebuild(toRoutes) {
    const old = agent;
    routes = toRoutes;
    agent = new Agent({
      factory(origin, passedOptions) {
        const options = passedOptions ?? {};
        const proxy = proxyFor(new URL(origin.toString()));
        if (typeof proxy === "string") return new ProxyAgent({ ...options, uri: proxy });
        return new Pool(origin, options);
      },
    });
    setGlobalDispatcher(agent);
    if (old) old.close().catch(() => {});
  }

  /** Wrap global fetch so every host with a proxy is re-issued through it. */
  function installFetchWrapper() {
    if (typeof previousFetch !== "function") {
      logLine("apply: global fetch is not a function — fetch wrapper skipped");
      return;
    }
    installedFetch = function routedFetch(input, init) {
      try {
        const url = new URL(urlOf(input));
        const proxy = proxyFor(url);
        noteHost(url, proxy);
        if (typeof proxy === "string") {
          logLine(`route ${url.hostname}${url.pathname.slice(0, 60)} -> ${proxy}`);
          return undiciFetch(input, { ...initOf(input, init), dispatcher: proxyAgentFor(proxy) });
        }
      } catch (error) {
        logLine(`fetch wrapper error: ${error?.message ?? error}`);
      }
      return previousFetch.call(globalThis, input, init);
    };
    try {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: installedFetch,
      });
      logLine("apply: fetch wrapper installed");
    } catch (error) {
      logLine(`apply: cannot install fetch wrapper: ${error?.message ?? error}`);
      installedFetch = undefined;
    }
  }

  /**
   * Some providers (AWS Bedrock above all) sign with SigV4 and go out through
   * the AWS SDK's Node HTTP handler — plain `node:https`, no fetch and no
   * undici. Wrapping `https.request` with a CONNECT-tunnel agent is the only
   * level that catches them.
   */
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalHttpRequest = http.request;
  const tunnelAgents = new Map();

  function tunnelAgentFor(proxy) {
    let created = tunnelAgents.get(proxy);
    if (created !== undefined) return created;
    let proxyUrl;
    try {
      proxyUrl = new URL(proxy);
    } catch {
      return undefined;
    }
    if (proxyUrl.protocol !== "http:") {
      logLine(`apply: ${proxy} is not an http:// proxy — https targets keep going direct`);
      return undefined;
    }
    const proxyHost = proxyUrl.hostname;
    const proxyPort = Number(proxyUrl.port || 80);
    const authHeader =
      proxyUrl.username === ""
        ? undefined
        : `Basic ${Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
          ).toString("base64")}`;
    const agent = new https.Agent({ keepAlive: true });
    agent.createConnection = function createTunnelConnection(options, callback) {
      const targetHost = options.host || options.hostname || "";
      const targetPort = Number(options.port || 443);
      const connectReq = originalHttpRequest({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:${targetPort}`,
        headers: {
          host: `${targetHost}:${targetPort}`,
          ...(authHeader === undefined ? {} : { "proxy-authorization": authHeader }),
        },
      });
      connectReq.once("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          callback(new Error(`proxy CONNECT ${res.statusCode}`));
          return;
        }
        const secured = tls.connect({ socket, servername: targetHost });
        secured.once("error", (error) => callback(error));
        callback(null, secured);
      });
      connectReq.once("error", (error) => callback(error));
      connectReq.end();
    };
    tunnelAgents.set(proxy, agent);
    return agent;
  }

  /** Options of an https.request(...) call, however it was invoked. */
  function optionsOf(args) {
    const [first, second] = args;
    if (typeof first === "string" || first instanceof URL) {
      const url = new URL(String(first));
      const extra = typeof second === "object" && second !== null ? second : {};
      return {
        ...extra,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        ...(url.username === ""
          ? {}
          : {
              auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
            }),
      };
    }
    return { ...(first ?? {}) };
  }

  /** Host name of normalized request options. */
  function hostOfOptions(options) {
    const raw = String(options.hostname ?? options.host ?? "").toLowerCase();
    if (raw === "") return undefined;
    return raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  }

  function wrapRequest(original, label) {
    return function routedRequest(...args) {
      let next = args;
      try {
        const options = optionsOf(args);
        const host = hostOfOptions(options);
        if (host !== undefined && options.socketPath === undefined) {
          const proxy = proxyFor({ hostname: host });
          noteHost({ hostname: host }, proxy);
          const tunnel = typeof proxy === "string" ? tunnelAgentFor(proxy) : undefined;
          if (tunnel !== undefined) {
            const merged = { ...options, hostname: host, agent: tunnel };
            delete merged.host;
            logLine(`node ${label} ${host}${String(options.path ?? "/").slice(0, 40)} -> ${proxy}`);
            next = typeof args[0] === "string" || args[0] instanceof URL ? [merged, ...args.slice(1)] : [merged, ...args.slice(1)];
          }
        }
      } catch (error) {
        logLine(`node ${label} wrapper error: ${error?.message ?? error}`);
      }
      return original.apply(this, next);
    };
  }

  function installNodeRequestWrapper() {
    try {
      https.request = wrapRequest(originalHttpsRequest, "https.request");
      https.get = wrapRequest(originalHttpsGet, "https.get");
      logLine("apply: node https.request wrapper installed");
    } catch (error) {
      logLine(`apply: cannot install node request wrapper: ${error?.message ?? error}`);
    }
  }

  /** Re-read the live config and rebuild only when its content changed. */
  function sync() {
    const providers = readLive(config?.providers) ?? [];
    const biliMode = readLive(config?.biliMode);
    const biliPath = readLive(config?.biliConfigPath);
    const next = signatureOf(providers);
    const biliKey = `${biliMode ?? ""}\u0000${biliPath ?? ""}`;
    if (next !== signature) {
      signature = next;
      const { routes: built, problems } = buildRoutes(providers);
      for (const problem of problems) logLine(`config: ${problem}`);
      rebuild(built);
      const summary = built.map((rule) => `${rule.raw} -> ${rule.proxy ?? "direct"}`);
      logLine(`routes (${summary.length}): ${summary.join(", ") || "(none)"}`);
    }
    if (biliKey !== biliSignature) {
      biliSignature = biliKey;
      syncBili(providers, biliMode, biliPath);
    }
    const wantFallback = readLive(config?.systemProxy) === true;
    if (wantFallback !== systemFallback) {
      systemFallback = wantFallback;
      const detected = wantFallback ? detectSystemProxy(true) : undefined;
      logLine(
        wantFallback
          ? `system proxy fallback: on${detected === undefined ? " (未检测到系统代理)" : ` -> ${detected}`}`
          : "system proxy fallback: off",
      );
    }
  }

  installFetchWrapper();
  installNodeRequestWrapper();
  sync();

  const off = ctx?.on?.("settings/document-updated", () => sync());
  const timer = setInterval(sync, POLL_MS);
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    if (typeof off === "function") off();
    if (installedFetch !== undefined && globalThis.fetch === installedFetch) {
      try {
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: previousFetch,
        });
      } catch {
        /* leave it in place */
      }
    }
    try {
      https.request = originalHttpsRequest;
      https.get = originalHttpsGet;
    } catch {
      /* leave it in place */
    }
    for (const created of tunnelAgents.values()) created.destroy();
    tunnelAgents.clear();
    if (agent && getGlobalDispatcher() === agent) setGlobalDispatcher(previousDispatcher);
    await agent?.close().catch(() => {});
    for (const created of proxyAgents.values()) await created.close().catch(() => {});
    proxyAgents.clear();
  };
}
