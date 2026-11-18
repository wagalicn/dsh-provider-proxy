// Render-test the client module's section component without a browser.
// Run: ELECTRON_RUN_AS_NODE=1 "<DSH install>/DeepSeek Harness.exe" test/render.test.mjs
import fs from 'node:fs';
import path from 'node:path';

// --- tiny React shim: enough hooks to run one render pass --------------------
const hooks = [];
const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(20).filter((c) => c !== null && c !== undefined && c !== false);
    return { type, props: { ...(props ?? {}), ...(kids.length ? { children: kids } : {}) } };
  },
  useState(initial) {
    const v = typeof initial === 'function' ? initial() : initial;
    const slot = { value: v };
    hooks.push(slot);
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useEffect(fn) { hooks.push({ effect: fn }); },
  useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
  useRef(v) { return { current: v }; },
};

let mod;
const sandbox = { __ModuleLoader__: { load(def) { mod = def; } } };
globalThis.window = sandbox;

const src = fs.readFileSync(path.resolve('client.js'), 'utf8');
const fn = new Function('window', 'module', 'exports', 'require', src);
fn(sandbox, { exports: {} }, {}, (name) => (name === 'react' ? React : null));

if (!mod) throw new Error('client module did not register with __ModuleLoader__');
console.log('module id:', mod.id);

const mirror = {
  getSnapshot() {
    return {
      status: 'ready',
      view: {
        namespaces: [
          {
            ns: 'include:provider-proxy',
            revision: 1,
            value: { providers: [{ provider: 'OpenAI', baseURL: 'https://api.openai.com/v1', proxy: 'http://127.0.0.1:7890' }], debug: false },
            base: {}, user: {}, writable: true,
          },
        ],
      },
    };
  },
  subscribe() { return () => {}; },
  ensure() {},
  load() {},
};

const registrations = [];
const ctx = {
  configForms: { get: () => mirror, describe: () => mirror },
  get: () => undefined,
  locale: { bind: () => (k) => k },
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
  slots: {
    inject(slot, build) { build(); },
    register(spec, Component) { registrations.push({ spec, Component }); return () => {}; },
  },
};

const exported = mod.factory((name) => (name === 'react' ? React : null));
console.log('inject:', JSON.stringify(exported.inject));
exported.apply(ctx);
console.log('registrations:', registrations.map((r) => `${r.spec.name}#${r.spec.id ?? r.spec.key ?? ''}`).join(', '));

const section = registrations.find((r) => r.spec.name === 'settings.section');
if (!section) throw new Error('no settings.section registration');

const injectFace = typeof section.spec.inject === 'function' ? section.spec.inject() : undefined;
console.log('spec.inject present:', injectFace !== undefined);

const tree = section.Component({ close() {}, ...(injectFace ?? {}) });

const walk = (node, depth = 0) => {
  if (node === null || node === undefined) return `${'  '.repeat(depth)}<empty>`;
  if (typeof node === 'string' || typeof node === 'number') return `${'  '.repeat(depth)}"${node}"`;
  if (Array.isArray(node)) return node.map((n) => walk(n, depth)).join('\n');
  const { type, props = {} } = node;
  if (typeof type === 'function') {
    console.log(`${'  '.repeat(depth)}-> render ${type.name || 'anonymous'}`);
    return walk(type({ ...props }), depth + 1);
  }
  const attrs = Object.entries(props).filter(([k]) => k !== 'children').map(([k, v]) => `${k}=${typeof v === 'function' ? 'fn' : JSON.stringify(v)}`).join(' ');
  return `${'  '.repeat(depth)}<${type}${attrs ? ' ' + attrs : ''}>` + (props.children ? '\n' + walk(props.children, depth + 1) : '');
};

console.log('--- tree ---');
console.log(walk(tree).slice(0, 2000));
console.log('--- ok ---');
