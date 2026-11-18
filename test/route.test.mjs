/**
 * Routing test for dsh-provider-proxy.
 *
 * Needs `undici` and `@deepseek-ai/schemastery` resolvable from the package
 * (in a DSH profile they are hoisted; in a plain checkout run `pnpm install`).
 *
 * Run: node test/route.test.mjs
 */
import http from "node:http";
import assert from "node:assert/strict";
import { getGlobalDispatcher } from "undici";
import { apply } from "../index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connects = [];
const proxy = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok");
});
proxy.on("connect", (req, socket) => {
  connects.push(req.url);
  socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  socket.destroy();
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

let providers = [{ provider: "ai", baseURL: "https://api.example.com/v1", proxy: proxyUrl }];
const config = {
  providers: { get: () => providers },
  debug: { get: () => false },
};

const before = getGlobalDispatcher();
const dispose = apply({}, config);

// 1) a configured host goes through its proxy
await fetch("https://api.example.com/v1/models").catch(() => {});
assert.deepEqual(connects, ["api.example.com:443"], "configured host should be proxied");

// 2) editing the live config re-routes without a remount
providers = [{ provider: "ai", baseURL: "https://second.example.net/v1", proxy: proxyUrl }];
await sleep(1300);
await fetch("https://second.example.net/v1/models").catch(() => {});
assert.equal(connects.at(-1), "second.example.net:443", "edited endpoint should be proxied");

// 3) a host that is no longer listed goes direct
const proxied = connects.length;
await fetch("https://api.example.com/v1/models").catch(() => {});
assert.equal(connects.length, proxied, "unlisted host must go direct");

// 4) an empty proxy value means direct
providers = [{ provider: "ai", baseURL: "https://third.example.org/v1", proxy: "  " }];
await sleep(1300);
await fetch("https://third.example.org/v1/models").catch(() => {});
assert.equal(connects.length, proxied, "empty proxy must go direct");

// 5) an unsupported proxy scheme means direct
providers = [{ provider: "ai", baseURL: "https://fourth.example.org/v1", proxy: "socks5://127.0.0.1:1080" }];
await sleep(1300);
await fetch("https://fourth.example.org/v1/models").catch(() => {});
assert.equal(connects.length, proxied, "socks5 must be ignored");

// 6) dispose restores the previous dispatcher
await dispose();
assert.equal(getGlobalDispatcher(), before, "dispose must restore the previous dispatcher");

proxy.close();
console.log("route.test.mjs: all checks passed");

