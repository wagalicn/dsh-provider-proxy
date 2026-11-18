window.__ModuleLoader__.load({
  id: '@wagalicn/dsh-provider-proxy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PROVIDER_CARD_SLOT = 'settings.models.provider-card';
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
      empty: '还没有配置。点「添加一行」，把要代理的接口地址和代理填上。',
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

    /* ---------- per-provider card field ---------- */

    function ProviderProxyField(props) {
      const ctx = props?.ctx;
      const entry = props?.provider ?? {};
      const providerId = String(entry.provider ?? entry.id ?? '');
      const defaultBaseURL = String(entry.defaultBaseURL ?? '');
      const { form } = useConfigForm(ctx);
      const snapshot = useFormSnapshot(form);
      const serverRows = React.useMemo(() => readRows(form), [form, snapshot]);
      const serverKey = signatureOf(serverRows);

      const [baseURL, setBaseURL] = React.useState('');
      const [proxy, setProxy] = React.useState('');
      const [dirty, setDirty] = React.useState(false);
      const [status, setStatus] = React.useState('');

      const current = React.useMemo(() => {
        const exact = serverRows.find((row) => row.provider === providerId);
        if (exact !== undefined) return exact;
        const host = hostOf(defaultBaseURL);
        if (host !== '') return serverRows.find((row) => hostOf(row.baseURL) === host);
        return undefined;
      }, [serverRows, providerId, defaultBaseURL]);

      React.useEffect(() => {
        if (dirty) return;
        setBaseURL(current?.baseURL ?? defaultBaseURL);
        setProxy(current?.proxy ?? '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [serverKey, providerId, defaultBaseURL]);

      const commit = React.useCallback(async () => {
        if (form === undefined) return;
        setStatus(text.saving);
        const next = serverRows.filter((row) => row.provider !== providerId);
        const cleanBase = String(baseURL || '').trim();
        if (cleanBase !== '') next.push({ provider: providerId, baseURL: cleanBase, proxy: String(proxy || '').trim() });
        try {
          const ok = await form.mutate([{ op: 'set', path: ['providers'], value: cleanRows(next) }]);
          setDirty(false);
          setStatus(ok === false ? text.failed : text.saved);
        } catch (error) {
          setStatus(`${text.failed}（${String(error?.message ?? error)}）`);
        }
      }, [form, serverRows, providerId, baseURL, proxy]);

      if (providerId === '' || form === undefined) return null;

      return h(
        'div',
        {
          style: {
            marginTop: 10,
            paddingTop: 8,
            borderTop: '1px dashed rgba(127,127,127,.28)',
            display: 'flex',
            flexDirection: 'column',
          },
        },
        h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.85 } }, text.cardTitle),
        h(
          'div',
          { style: rowStyle },
          h('span', { style: labelStyle }, text.baseURL),
          h('input', {
            style: inputStyle,
            value: baseURL,
            spellCheck: false,
            placeholder: text.baseURLPlaceholder,
            onChange: (event) => {
              setDirty(true);
              setBaseURL(event.target.value);
            },
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            },
          }),
        ),
        h(
          'div',
          { style: rowStyle },
          h('span', { style: labelStyle }, text.proxy),
          h('input', {
            style: inputStyle,
            value: proxy,
            spellCheck: false,
            placeholder: text.proxyPlaceholder,
            onChange: (event) => {
              setDirty(true);
              setProxy(event.target.value);
            },
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            },
          }),
        ),
        h(
          'div',
          { style: { marginTop: 4, fontSize: 11, opacity: 0.6, display: 'flex', gap: 8 } },
          h('span', null, text.cardHint),
          status === '' ? null : h('span', null, status),
        ),
      );
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
        for (const namespace of ['llm-pi-ai', 'llm-deepseek']) {
          ctx.slots.inject(PROVIDER_CARD_SLOT, () =>
            ctx.slots.register({ name: PROVIDER_CARD_SLOT, key: namespace }, (props) => h(ProviderProxyField, { ...props, ctx })),
          );
        }
      },
    };
  },
});
