/**
 * Verifies the fetch-wrapper path: a host that has a proxy configured must be
 * re-issued through that proxy (observable as a CONNECT on the proxy), a host
 * without one must stay untouched, and disposing must restore global fetch.
 *
 * Run from the plugin directory:
 *   ELECTRON_RUN_AS_NODE=1 "<DSH install>/DeepSeek Harness.exe" test/fetch-route.test.mjs
 */
import net from 'node:net';
import http from 'node:http';

const { apply } = await import('../index.js');

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/* a proxy that records CONNECT targets */
const seen = [];
const proxy = net.createServer((socket) => {
  socket.once('data', (chunk) => {
    const first = chunk.toString('utf8').split('\r\n')[0];
    seen.push(first);
    socket.destroy();
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

/* a plain origin used to prove unmapped hosts are not touched */
const origin = http.createServer((req, res) => res.end('local-ok'));
await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
const originPort = origin.address().port;

const originalFetch = globalThis.fetch;

const config = {
  providers: [
    { provider: 'mapped', baseURL: 'https://proxy-target.test/v1', proxy: `http://127.0.0.1:${proxyPort}` },
    { provider: 'direct', baseURL: 'http://127.0.0.1', proxy: '' },
  ],
};

const dispose = apply({}, config);

try {
  check('global fetch is wrapped', globalThis.fetch !== originalFetch);

  /* 1. mapped host: must reach the proxy as CONNECT */
  await globalThis.fetch('https://proxy-target.test/models', { signal: AbortSignal.timeout(1500) }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('mapped host goes through proxy', seen.some((line) => line.startsWith('CONNECT proxy-target.test:443')), JSON.stringify(seen));

  /* 2. unmapped loopback host: must hit the local server directly */
  const before = seen.length;
  const response = await globalThis.fetch(`http://127.0.0.1:${originPort}/x`);
  const body = await response.text();
  check('unmapped host stays direct', body === 'local-ok', body);
  check('no proxy traffic for unmapped host', seen.slice(before).every((line) => !line.includes('127.0.0.1')), JSON.stringify(seen.slice(before)));

  /* 3. live config change is picked up */
  config.providers.push({ provider: 'late', baseURL: 'https://late-added.test/v2', proxy: `http://127.0.0.1:${proxyPort}` });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await globalThis.fetch('https://late-added.test/v2/models', { signal: AbortSignal.timeout(1500) }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('newly added route is used', seen.some((line) => line.startsWith('CONNECT late-added.test:443')), JSON.stringify(seen));
} finally {
  await dispose();
  proxy.close();
  origin.close();
}

check('dispose restores global fetch', globalThis.fetch === originalFetch);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nfetch-route.test.mjs: all checks passed');
}
