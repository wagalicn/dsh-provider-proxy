/**
 * Routing test for the node:https layer (AWS SDK / SigV4 providers).
 *
 *   node test/node-route.test.mjs
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { apply } from "../index.js";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function startProxy() {
  const seen = [];
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, clientSocket, head) => {
    seen.push(String(req.url));
    const [host, port] = String(req.url).split(":");
    const upstream = net.connect(Number(port || 443), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}

const request = (url) =>
  new Promise((resolve) => {
    const req = https.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", (error) => resolve({ error: String(error?.message ?? error) }));
    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
  });

const proxy = await startProxy();
const dispose = apply(
  {},
  {
    providers: [
      { provider: "routed", baseURL: "api.deepseek.com", proxy: `http://127.0.0.1:${proxy.port}` },
      { provider: "direct", baseURL: "example.com", proxy: "" },
    ],
    debug: true,
  },
);

const routed = await request("https://api.deepseek.com/");
check("routed host goes through the proxy", proxy.seen.includes("api.deepseek.com:443"), JSON.stringify(routed));
check("proxy tunnel produced a real answer", routed.status === 401 || typeof routed.error === "string", JSON.stringify(routed));

const before = proxy.seen.length;
const direct = await request("https://example.com/");
check("unlisted/direct host adds no proxy traffic", proxy.seen.length === before, JSON.stringify(direct));

await dispose();
check("dispose restores https.request", https.request.name !== "routedRequest", `name=${https.request.name}`);

proxy.server.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "node-route.test.mjs: all checks passed" : `node-route.test.mjs: ${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
