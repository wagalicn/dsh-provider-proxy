window.__ModuleLoader__.load({
  id: '@wagalicn/dsh-provider-proxy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SECTION_SLOT = 'settings.section';
    /** Our own bundle entry id contains this token; used to recognise the right namespace. */
    const NS_HINT = 'provider-proxy';

    const text = {
      nav: '提供商代理',
      title: '提供商代理',
      intro: '给每个模型提供商单独指定出口代理：填了代理的走代理，留空的直连，列表里没有的地址也直连。改完即时生效，不用重启。',
      baseURL: '接口地址',
      baseURLPlaceholder: 'https://api.openai.com/v1（支持 * 通配，如 bedrock-runtime.*.amazonaws.com）',
      proxy: '代理',
      proxyPlaceholder: 'http://127.0.0.1:7890（留空直连）',
      labelField: '名称',
      add: '+ 添加一行',
      remove: '删除',
      empty: '还没有代理规则。在下面「检测到的模型提供商」里给需要的填上代理即可，不用手抄接口地址。',
      section1: '① 已生效的代理规则',
      detectedTitle: '② 快速添加：检测到的模型提供商',
      detectedHint: '接口地址可改；右边填上代理后自动加进 ①，留空表示这家直连。',
      detectedNone: '没有可添加的提供商（都已配置，或「设置 → 模型」里还没有提供商）。',
      detectedCount: (total, pending) => (total === 0 ? '未检测到' : `检测到 ${total} 个，待添加 ${pending} 个`),
      refresh: '刷新',
      baseURLPlaceholder2: 'https://api.example.com/v1',
      advanced: '③ 高级选项（一般不用改）',
      sysProxyLabel: '列表外的地址跟随系统代理',
      sysProxyHint:
        '勾选后，未出现在上表的域名会走系统代理（Windows「Internet 选项」里的代理，或 HTTPS_PROXY/HTTP_PROXY）；不勾选则一律直连。',
      loading: '正在读取插件配置…',
      saved: '已保存',
      saving: '保存中…',
      failed: '保存失败',
      note: '只支持 http:// 与 https:// 代理；socks5 会被忽略并按直连处理。接口地址支持 * 通配（如 *.api.aws）。',
      cardTitle: '出口代理',
      cardHint: '留空则直连。',
      diag: '诊断信息',
      biliLabel: 'billion-context（bili）',
      biliMirror: '同步本页的代理（推荐）',
      biliSystem: '让 bili 走系统代理',
      biliOff: '不动 bili 的配置',
      biliHint:
        '模型请求如果经过 bili（本机 127.0.0.1 上的上下文代理），真正出网的是 bili 那个进程，本插件拦不到。选「同步」会把上面的接口地址与代理写进 bili 的配置文件；选「系统代理」会让 bili 用系统/环境代理。改完重启 DSH 生效。',
      biliAbsent: '未安装 billion-context（bili）时此项无效果，也不会报错。',
    };

    /* ---------- helpers ---------- */

    function hostOf(raw) {
      const value = String(raw || '').trim();
      if (value === '') return '';
      try {
        return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
      } catch {
        return '';
      }
    }

    function readRows(form) {
      try {
        const snapshot = form?.getSnapshot?.();
        const rows = snapshot?.value?.providers;
        if (!Array.isArray(rows)) return [];
        return rows.map((row) => ({
          provider: String(row?.provider ?? ''),
          baseURL: String(row?.baseURL ?? ''),
          proxy: String(row?.proxy ?? ''),
        }));
      } catch {
        return [];
      }
    }

    function signatureOf(rows) {
      return rows.map((row) => `${row.provider}\u0000${row.baseURL}\u0000${row.proxy}`).join('\u0001');
    }

    function readBiliMode(form) {
      try {
        const mode = form?.getSnapshot?.()?.value?.biliMode;
        return typeof mode === 'string' && mode !== '' ? mode : 'mirror';
      } catch {
        return 'mirror';
      }
    }

    function readSystemProxy(form) {
      try {
        return form?.getSnapshot?.()?.value?.systemProxy === true;
      } catch {
        return false;
      }
    }

    function cleanRows(rows) {
      return rows
        .map((row) => ({
          provider: String(row.provider ?? '').trim(),
          baseURL: String(row.baseURL ?? '').trim(),
          proxy: String(row.proxy ?? '').trim(),
        }))
        .filter((row) => row.baseURL !== '' || row.proxy !== '');
    }

    /** Everything we learn while looking for our config namespace, for on-screen diagnosis. */
    function serviceOf(ctx) {
      try {
        return ctx?.configForms ?? ctx?.get?.('configForms');
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    }

    function namespacesOf(forms) {
      const notes = [];
      if (!forms) return { namespaces: [], notes: ['configForms 服务不可用'] };
      let mirror;
      try {
        mirror = forms.describe?.();
      } catch (error) {
        return { namespaces: [], notes: [`describe() 抛错: ${String(error?.message ?? error)}`] };
      }
      if (!mirror) return { namespaces: [], notes: ['describe() 返回空'] };
      try {
        mirror.ensure?.();
        mirror.load?.();
      } catch (error) {
        notes.push(`ensure/load 抛错: ${String(error?.message ?? error)}`);
      }
      let snapshot;
      try {
        snapshot = mirror.getSnapshot?.();
      } catch (error) {
        return { namespaces: [], notes: [...notes, `getSnapshot() 抛错: ${String(error?.message ?? error)}`] };
      }
      const view = snapshot?.view;
      const namespaces = Array.isArray(view?.namespaces) ? view.namespaces : [];
      if (namespaces.length === 0) {
        notes.push(`状态=${String(snapshot?.status ?? '?')}，命名空间 0 个`);
      }
      return { namespaces, notes };
    }

    function pickNamespace(ctx) {
      const forms = serviceOf(ctx);
      if (!forms || forms.error) return { ns: undefined, notes: [forms?.error ? `configForms: ${forms.error}` : 'configForms 不可用'] };
      const { namespaces, notes } = namespacesOf(forms);
      let fallback;
      for (const entry of namespaces) {
        const value = entry?.value;
        if (!value || typeof value !== 'object' || !Array.isArray(value.providers)) continue;
        const ns = String(entry.ns ?? '');
        if (ns.includes(NS_HINT)) return { ns, notes, forms };
        if (fallback === undefined) fallback = ns;
      }
      if (fallback === undefined && namespaces.length > 0) {
        notes.push(`有 ${namespaces.length} 个命名空间，但没有带 providers 数组的：${namespaces.map((e) => String(e?.ns ?? '')).join(', ')}`);
      }
      return { ns: fallback, notes, forms };
    }

    function resolveForm(ctx) {
      const { ns, notes, forms } = pickNamespace(ctx);
      if (!forms || forms.error) return { form: undefined, notes };
      if (ns === undefined) return { form: undefined, notes };
      try {
        return { form: forms.get(ns), notes, ns };
      } catch (error) {
        return { form: undefined, notes: [...notes, `get(${ns}) 抛错: ${String(error?.message ?? error)}`], ns };
      }
    }

    /* ---------- provider discovery ---------- */

    const FALLBACK_BASE_URLS = {
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com',
      google: 'https://generativelanguage.googleapis.com',
      deepseek: 'https://api.deepseek.com',
      xai: 'https://api.x.ai',
      moonshot: 'https://api.moonshot.cn',
      zhipu: 'https://open.bigmodel.cn',
      qwen: 'https://dashscope.aliyuncs.com',
      mistral: 'https://api.mistral.ai',
      groq: 'https://api.groq.com',
      openrouter: 'https://openrouter.ai',
    };

    /** Read one settings namespace from the mirror, e.g. "llm-pi-ai". */
    function valueOfNamespace(ctx, ns) {
      const forms = serviceOf(ctx);
      if (!forms || forms.error) return undefined;
      const { namespaces } = namespacesOf(forms);
      for (const entry of namespaces) {
        if (String(entry?.ns ?? '') === ns) return entry?.value;
      }
      return undefined;
    }

    /** Providers this app already knows about: [{ provider, baseURL }]. */
    function detectedProviders(ctx) {
      const out = [];
      const seen = new Set();
      const push = (id, baseURL) => {
        const key = baseURL !== '' ? hostOf(baseURL) : `id:${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ provider: id, baseURL });
      };
      const forms = serviceOf(ctx);
      if (!forms || forms.error) return out;
      const { namespaces } = namespacesOf(forms);
      for (const entry of namespaces) {
        const ns = String(entry?.ns ?? '');
        if (ns.includes('provider-proxy')) continue;
        const value = entry?.value;
        if (!value || typeof value !== 'object') continue;
        const dict = value.providers;
        if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
          for (const [id, profile] of Object.entries(dict)) {
            if (profile !== null && typeof profile === 'object') {
              const baseURL = String(profile.baseURL ?? '') || FALLBACK_BASE_URLS[id] || '';
              push(id, baseURL);
            } else if (typeof profile === 'string' && profile !== '') {
              push(id, profile);
            } else if (profile === null || typeof profile === 'object') {
              push(id, FALLBACK_BASE_URLS[id] ?? '');
            }
          }
          continue;
        }
        if (typeof value.baseURL === 'string' && value.baseURL !== '') {
          push(ns.replace(/^llm-/, '') || ns, value.baseURL);
        }
      }
      return out;
    }

    /* ---------- hooks ---------- */

    function useConfigForm(ctx) {
      const [state, setState] = React.useState(() => resolveForm(ctx));
      React.useEffect(() => {
        if (state.form !== undefined) return undefined;
        const timer = setInterval(() => {
          const found = resolveForm(ctx);
          if (found.form !== undefined) {
            clearInterval(timer);
            setState(found);
          }
        }, 500);
        return () => clearInterval(timer);
      }, [ctx, state.form]);
      return state;
    }

    function useFormSnapshot(form) {
      const read = React.useCallback(() => {
        try {
          return form === undefined ? undefined : form.getSnapshot();
        } catch {
          return undefined;
        }
      }, [form]);
      const [snapshot, setSnapshot] = React.useState(read);
      React.useEffect(() => {
        setSnapshot(read());
        if (form === undefined) return undefined;
        let dispose;
        try {
          dispose = form.subscribe(() => setSnapshot(read()));
        } catch {
          dispose = undefined;
        }
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, [form, read]);
      return snapshot;
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '5px 8px',
      fontSize: 12,
      lineHeight: '18px',
      borderRadius: 6,
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
      outline: 'none',
    };
    const labelStyle = { width: 62, flex: '0 0 auto', fontSize: 12, opacity: 0.7 };
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 };
    const buttonStyle = {
      padding: '4px 10px',
      fontSize: 12,
      lineHeight: '18px',
      borderRadius: 6,
      border: '1px solid rgba(127,127,127,.35)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    };

    /* ---------- settings page ---------- */

    function ProviderProxyBody(ctx) {
      const { form, notes } = useConfigForm(ctx);
      const snapshot = useFormSnapshot(form);
      const serverRows = React.useMemo(() => readRows(form), [form, snapshot]);
      const serverKey = signatureOf(serverRows);

      const [rows, setRows] = React.useState(serverRows);
      const [dirty, setDirty] = React.useState(false);
      const [status, setStatus] = React.useState('');
      const serverMode = React.useMemo(() => readBiliMode(form), [form, snapshot]);
      const [biliMode, setBiliMode] = React.useState(serverMode);
      const serverSys = React.useMemo(() => readSystemProxy(form), [form, snapshot]);
      const [sysProxy, setSysProxy] = React.useState(serverSys);
      const [tick, setTick] = React.useState(0);
      const detected = React.useMemo(() => detectedProviders(ctx), [ctx, snapshot, tick]);
      const [drafts, setDrafts] = React.useState({});
      const rowsRef = React.useRef(rows);
      rowsRef.current = rows;
      const sentRef = React.useRef('');

      React.useEffect(() => {
        if (dirty) {
          if (sentRef.current !== '' && sentRef.current === serverKey) {
            sentRef.current = '';
            setDirty(false);
          }
          return;
        }
        setRows(serverRows);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [serverKey, dirty]);

      const persist = React.useCallback(
        async (next) => {
          if (form === undefined) return;
          setStatus(text.saving);
          try {
            const payload = cleanRows(next);
            sentRef.current = signatureOf(payload);
            const ok = await form.mutate([{ op: 'set', path: ['providers'], value: payload }]);
            if (ok === false) sentRef.current = '';
            setStatus(ok === false ? text.failed : text.saved);
          } catch (error) {
            sentRef.current = '';
            setStatus(`${text.failed}（${String(error?.message ?? error)}）`);
          }
        },
        [form],
      );

      const edit = (index, field, value) => {
        setDirty(true);
        setRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
      };

      React.useEffect(() => {
        setBiliMode(serverMode);
      }, [serverMode]);

      React.useEffect(() => {
        setSysProxy(serverSys);
      }, [serverSys]);

      const changeBili = React.useCallback(
        async (value) => {
          setBiliMode(value);
          if (form === undefined) return;
          try {
            await form.mutate([{ op: 'set', path: ['biliMode'], value }]);
            setStatus(text.saved);
          } catch (error) {
            setStatus(`${text.failed}（${String(error?.message ?? error)}）`);
          }
        },
        [form],
      );

      const changeSystemProxy = React.useCallback(
        async (value) => {
          setSysProxy(value);
          if (form === undefined) return;
          setStatus(text.saving);
          try {
            const ok = await form.mutate([{ op: 'set', path: ['systemProxy'], value }]);
            setStatus(ok === false ? text.failed : text.saved);
          } catch (error) {
            setStatus(`${text.failed}（${String(error?.message ?? error)}）`);
          }
        },
        [form],
      );

      const suggestions = React.useMemo(
        () =>
          detected.filter(
            (item) =>
              !rows.some((row) => row.provider === item.provider || (item.baseURL !== '' && hostOf(row.baseURL) === hostOf(item.baseURL))),
          ),
        [detected, rows],
      );

      const refreshDetection = React.useCallback(() => {
        try {
          const forms = serviceOf(ctx);
          const mirror = forms?.describe?.();
          mirror?.invalidate?.();
          mirror?.load?.();
          mirror?.ensure?.();
        } catch {
          /* a failed refresh must not break the page */
        }
        setTick((value) => value + 1);
      }, [ctx]);

      const commitSuggestion = React.useCallback(
        (item) => {
          const draft = drafts[item.provider] ?? {};
          const proxy = String(draft.proxy ?? '').trim();
          const baseURL = String(draft.baseURL ?? '').trim() || item.baseURL;
          if (proxy === '' || baseURL === '') return;
          const next = [...rowsRef.current, { provider: item.provider, baseURL, proxy }];
          setRows(next);
          setDrafts((current) => {
            const copy = { ...current };
            delete copy[item.provider];
            return copy;
          });
          setDirty(true);
          persist(next);
        },
        [drafts, persist],
      );

      const children = [
        h('h2', { key: 'title', style: { margin: 0, fontSize: 15, fontWeight: 600 } }, text.title),
        h('p', { key: 'intro', style: { margin: 0, fontSize: 12, opacity: 0.7, lineHeight: '18px' } }, text.intro),
      ];

      if (form === undefined) {
        children.push(h('p', { key: 'loading', style: { margin: 0, fontSize: 12, opacity: 0.75 } }, text.loading));
        if (notes.length > 0) {
          children.push(
            h(
              'div',
              { key: 'diag', style: { margin: 0, padding: '8px 10px', borderRadius: 6, background: 'rgba(127,127,127,.08)', fontSize: 11, opacity: 0.75, whiteSpace: 'pre-wrap' } },
              `${text.diag}：\n${notes.join('\n')}`,
            ),
          );
        }
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px 16px' } }, children);
      }

      children.push(
        h('p', { key: 'sec1', style: { margin: '6px 0 0', fontSize: 12, fontWeight: 600 } }, text.section1),
      );
      children.push(
        rows.length === 0
          ? h('p', { key: 'empty', style: { margin: 0, fontSize: 12, opacity: 0.6 } }, text.empty)
          : h(
              'div',
              { key: 'rows', style: { display: 'flex', flexDirection: 'column' } },
              rows.map((row, index) =>
                h(
                  'div',
                  { key: index, style: { padding: '8px 0', borderTop: index === 0 ? 'none' : '1px solid rgba(127,127,127,.18)' } },
                  h(
                    'div',
                    { style: rowStyle },
                    h('span', { style: labelStyle }, text.labelField),
                    h('input', {
                      style: { ...inputStyle, maxWidth: 180 },
                      value: row.provider,
                      spellCheck: false,
                      placeholder: 'openai',
                      onChange: (event) => edit(index, 'provider', event.target.value),
                      onBlur: () => persist(rowsRef.current),
                    }),
                  ),
                  h(
                    'div',
                    { style: rowStyle },
                    h('span', { style: labelStyle }, text.baseURL),
                    h('input', {
                      style: inputStyle,
                      value: row.baseURL,
                      spellCheck: false,
                      placeholder: text.baseURLPlaceholder,
                      onChange: (event) => edit(index, 'baseURL', event.target.value),
                      onBlur: () => persist(rowsRef.current),
                    }),
                  ),
                  h(
                    'div',
                    { style: rowStyle },
                    h('span', { style: labelStyle }, text.proxy),
                    h('input', {
                      style: inputStyle,
                      value: row.proxy,
                      spellCheck: false,
                      placeholder: text.proxyPlaceholder,
                      onChange: (event) => edit(index, 'proxy', event.target.value),
                      onBlur: () => persist(rowsRef.current),
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...buttonStyle, flex: '0 0 auto' },
                        onClick: () => {
                          const next = rows.filter((_, i) => i !== index);
                          setRows(next);
                          persist(next);
                        },
                      },
                      text.remove,
                    ),
                  ),
                ),
              ),
            ),
      );
      children.push(
        h(
          'div',
          { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              onClick: () => {
                setDirty(true);
                setRows((current) => [...current, { provider: '', baseURL: '', proxy: '' }]);
              },
            },
            text.add,
          ),
          status === '' ? null : h('span', { style: { fontSize: 12, opacity: 0.7 } }, status),
        ),
      );
      children.push(h('p', { key: 'note', style: { margin: 0, fontSize: 11, opacity: 0.55, lineHeight: '16px' } }, text.note));
      children.push(
        h(
          'div',
          { key: 'detected', style: { paddingTop: 10, borderTop: '1px solid rgba(127,127,127,.18)', display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('p', { style: { margin: 0, fontSize: 12, fontWeight: 600 } }, text.detectedTitle),
            h('span', { style: { fontSize: 11, opacity: 0.55 } }, text.detectedCount(detected.length, suggestions.length)),
            h(
              'button',
              { type: 'button', style: { ...buttonStyle, marginLeft: 'auto' }, onClick: refreshDetection },
              text.refresh,
            ),
          ),
          h('p', { style: { margin: 0, fontSize: 11, opacity: 0.6, lineHeight: '16px' } }, text.detectedHint),
          suggestions.length === 0
            ? h('p', { style: { margin: 0, fontSize: 11, opacity: 0.55 } }, text.detectedNone)
            : suggestions.map((item) =>
                h(
                  'div',
                  { key: item.provider, style: { ...rowStyle, paddingTop: 6 } },
                  h('span', { style: { width: 108, flex: '0 0 auto', fontSize: 12, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.provider),
                  h('input', {
                    style: { ...inputStyle, flex: '1 1 auto', minWidth: 160 },
                    value: drafts[item.provider]?.baseURL ?? item.baseURL,
                    spellCheck: false,
                    placeholder: text.baseURLPlaceholder2,
                    onChange: (event) =>
                      setDrafts((current) => ({ ...current, [item.provider]: { ...current[item.provider], baseURL: event.target.value } })),
                  }),
                  h('input', {
                    style: { ...inputStyle, width: 200, flex: '0 0 auto' },
                    value: drafts[item.provider]?.proxy ?? '',
                    spellCheck: false,
                    placeholder: text.proxyPlaceholder,
                    onChange: (event) =>
                      setDrafts((current) => ({ ...current, [item.provider]: { ...current[item.provider], proxy: event.target.value } })),
                    onBlur: () => commitSuggestion(item),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') commitSuggestion(item);
                    },
                  }),
                ),
              ),
        ),
      );
      const advancedBlocks = [];
      advancedBlocks.push(
        h(
          'div',
          { key: 'sysproxy', style: { paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
            h('input', { type: 'checkbox', checked: sysProxy, onChange: (event) => changeSystemProxy(event.target.checked) }),
            text.sysProxyLabel,
          ),
          h('p', { style: { margin: 0, fontSize: 11, opacity: 0.55, lineHeight: '16px' } }, text.sysProxyHint),
        ),
      );
      advancedBlocks.push(
        h(
          'div',
          { key: 'bili', style: { paddingTop: 10, borderTop: '1px solid rgba(127,127,127,.18)', display: 'flex', flexDirection: 'column', gap: 6 } },
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, text.biliLabel),
            h(
              'select',
              {
                style: { ...inputStyle, maxWidth: 280, flex: '0 0 auto' },
                value: biliMode,
                onChange: (event) => changeBili(event.target.value),
              },
              h('option', { key: 'mirror', value: 'mirror' }, text.biliMirror),
              h('option', { key: 'system', value: 'system' }, text.biliSystem),
              h('option', { key: 'off', value: 'off' }, text.biliOff),
            ),
          ),
          h('p', { style: { margin: 0, fontSize: 11, opacity: 0.55, lineHeight: '16px' } }, text.biliHint),
          h('p', { style: { margin: 0, fontSize: 11, opacity: 0.45, lineHeight: '16px' } }, text.biliAbsent),
        ),
      );
      children.push(
        h(
          'details',
          { key: 'advanced', style: { paddingTop: 10, borderTop: '1px solid rgba(127,127,127,.18)' } },
          h('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: 0.85 } }, text.advanced),
          ...advancedBlocks,
        ),
      );

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px 16px' } }, children);
    }

    /** Never let a render error blank the whole settings page. */
    function ProviderProxyPage(props) {
      const ctx = props?.ctx;
      try {
        return ProviderProxyBody(ctx);
      } catch (error) {
        return h(
          'div',
          { style: { padding: 16, fontSize: 12, whiteSpace: 'pre-wrap', color: '#c0392b' } },
          `提供商代理页渲染失败：${String(error?.message ?? error)}\n`,
          String(error?.stack ?? '').slice(0, 800),
        );
      }
    }


    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.slots.inject(SECTION_SLOT, () =>
          ctx.slots.register(
            {
              name: SECTION_SLOT,
              id: 'provider-proxy',
              order: 30,
              label: () => text.nav,
              inject: () => ({}),
            },
            (props) => h(ProviderProxyPage, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
