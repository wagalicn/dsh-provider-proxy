/**
 * bili (billion-context) config mirroring: only the keys this plugin wrote may
 * be rewritten, and foreign entries must survive untouched.
 *
 *   node test/bili-sync.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), `bili-config-${process.pid}-${Date.now()}.json`);
fs.writeFileSync(
  tmp,
  JSON.stringify({ providers: { "https://other.example": { proxy: "http://keep:1" } }, modelContextLimit: 12345 }, null, 2),
);

const { apply } = await import("../index.js");

const config = {
  providers: [
    { provider: "bedrock", baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic", proxy: "http://127.0.0.1:7890" },
    { provider: "deepseek", baseURL: "https://api.deepseek.com", proxy: "" },
  ],
  biliMode: "mirror",
  biliConfigPath: tmp,
  debug: true,
};

const dispose = apply({}, config);
await new Promise((resolve) => setTimeout(resolve, 80));

const doc = JSON.parse(fs.readFileSync(tmp, "utf8"));
const providerKeys = Object.keys(doc.providers).sort();

assert.deepEqual(
  providerKeys,
  [
    "https://bedrock-runtime.us-east-1.amazonaws.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
    "https://other.example",
  ],
  "only the mirrored bedrock keys should be added",
);
assert.equal(doc.providers["https://bedrock-runtime.us-east-1.amazonaws.com"].proxy, "http://127.0.0.1:7890");
assert.equal(doc.providers["https://bedrock-runtime.us-east-1.amazonaws.com/anthropic"].proxy, "http://127.0.0.1:7890");
assert.equal(doc.providers["https://other.example"].proxy, "http://keep:1", "foreign entry must survive");
assert.equal(doc.modelContextLimit, 12345, "unrelated config keys must survive");
assert.deepEqual(
  doc.providerProxyManaged.sort(),
  ["https://bedrock-runtime.us-east-1.amazonaws.com", "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic"],
  "managed key list must be recorded",
);

assert.equal(doc.providers["https://api.deepseek.com"], undefined, "a row without a proxy must not be mirrored");

await dispose();
fs.unlinkSync(tmp);
console.log("bili-sync.test.mjs: all checks passed");
