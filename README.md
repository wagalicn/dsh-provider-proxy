# @wagalicn/dsh-provider-proxy

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**每个模型提供商**单独设定出口代理：配了代理的走代理，没配的直连，没列出来的也直连。

> Per-provider HTTP proxy routing for DeepSeek Harness model providers. Rows with a proxy are routed through it; rows without one — and any host not listed — go direct. The ambient `HTTP_PROXY` / `HTTPS_PROXY` environment is **not** inherited, so enabling one proxy for one provider never hijacks the rest.

---

## 为什么需要它

DSH 自带的代理是**进程级**的：启动时读一次 `HTTPS_PROXY`，所有出站请求都走它。可现实里常常是"只有某一家需要翻墙"，或者"每家用不同的落地"，甚至"某家必须直连才有低延迟"。只靠环境变量做不到，只能靠一个能按 **host** 分流的调度器。

这个插件做的就是这件事：在 DSH 进程里装一个自己的 dispatcher，按请求的 hostname 查表，命中就换代理，没命中就直连。

## 安装

```bash
# 从 npm（推荐）
dsh plugin add @wagalicn/dsh-provider-proxy

# 或直接从 GitHub
dsh plugin add github:wagalicn/dsh-provider-proxy

# 或从打包好的 tgz
dsh plugin add file:D:/path/to/wagalicn-dsh-provider-proxy-1.2.1.tgz
```

装完重启一次 DSH。

## 配置

只有一处入口：**设置 → 提供商代理**。

列表式，三块：**① 已生效的代理规则 / ② 快速添加（检测到的提供商）/ ③ 高级选项**。

| 字段 | 说明 |
| --- | --- |
| 名称 | 只是标签，建议写 **设置 → 模型** 里的 provider id（如 `bedrock`） |
| 接口地址 | 该 provider 的 API 地址，如 `https://api.openai.com/v1`；**只取 hostname** 做匹配 |
| 代理 | `http://127.0.0.1:7890`；**留空表示直连** |

页面会自动列出你**已经添加的模型提供商**（读的是「设置 → 模型」里的 provider 配置），接口地址自动带出、可以直接改；右边填上代理就会加进 ①，留空表示这家直连。新增 provider 后点一下「刷新」即可重新检测。

**③ 列表外的地址**默认直连；勾选页面上的「列表外的地址跟随系统代理」，未列出的域名就会走 Windows 系统代理（或 `HTTPS_PROXY`/`HTTP_PROXY`）。

改完即时生效（约 1 秒轮询），不用重启。

也支持直接写 YAML（`cordis.patch.yml` 里本插件的 `config`）：

```yaml
providers:
  - provider: openai
    baseURL: https://api.openai.com/v1
    proxy: http://127.0.0.1:7890
  - provider: deepseek
    baseURL: https://api.deepseek.com
    proxy: ""            # 直连
biliMode: mirror         # off | mirror | system
```

### 通配符

`baseURL` 里的 `*` 匹配一段主机名（`bedrock-runtime.*.amazonaws.com`、`*.api.aws` 都能用）。AWS Bedrock 的 endpoint 是分区/区域拼出来的，用通配符最省事：

```yaml
- provider: bedrock
  baseURL: https://bedrock-runtime.*.amazonaws.com/anthropic
  proxy: http://127.0.0.1:7890
```

## 路由规则

| 请求的 host | 该行配了代理 | 结果 |
| --- | --- | --- |
| 命中 | 非空 | 走该代理 |
| 命中 | 空 | 直连 |
| 未命中 | — | 直连（勾选「跟随系统代理」时改走系统代理） |

## 兼容 billion-context（bili）

如果你在用 bili 做 LLM 中转，**只在本插件里配代理是不够的**：DSH 把请求交给 bili 之后，真正出网的是 bili 自己的 node 进程，而本插件只装在 DSH 进程里，拦不到那一跳。

所以插件页底部有「billion-context（bili）」一栏：

| 选项 | 行为 |
| --- | --- |
| **同步本页的代理**（默认 `mirror`） | 把每一行的「接口地址 + 代理」写进 bili 的 `providers.<url>.proxy`，与 bili 共用一份配置 |
| **让 bili 走系统代理**（`system`） | 写 `upstreamProxyMode: "auto"`，由 bili 自己发现系统/环境代理 |
| **不动 bili 的配置**（`off`） | 完全不碰 bili |

写的是 `%USERPROFILE%\.config\billion-context\billion-context.json`（可用 `biliConfigPath` 覆盖）。插件只删改自己写过的 key（记录在 `providerProxyManaged` 里），你手写的条目和其它字段原样保留。bili 启动时读配置，改完需重启一次。

bili 的上游代理优先级：`providers.<url>.proxy` → `BILI_UPSTREAM_PROXY` → Web UI 手动代理 → 顶层 `proxy` → `HTTPS_PROXY`/`HTTP_PROXY` → 系统代理。

## 三层拦截

DSH 里的出站请求走三条不同的路，插件三条都接了：

| 层 | 覆盖什么 | 做法 |
| --- | --- | --- |
| `globalThis.fetch` | 大多数适配器（pi-ai、deepseek 等） | 替换 global fetch，命中则改走代理 |
| undici dispatcher | 直接用 undici 的库、Node 内置 fetch | 换掉全局 dispatcher |
| `node:https` | AWS SDK / SigV4 这类自己拼签名的客户端（如 Bedrock） | 包装 `https.request` / `https.get`，命中走 `CONNECT` 隧道 |

SOCKS5 不支持（`socks5://` 会告警并按直连处理）；`node:https` 隧道只支持 `http://` 代理。

## 排查

日志在 `~/.dsh/provider-proxy.log`：

```
apply   v1.1.0 pid=4956 node=v24.21.0
routes  (1)
host    bedrock-runtime.us-east-1.amazonaws.com -> http://127.0.0.1:7890
node    https.request api.deepseek.com/chat/completions -> http://127.0.0.1:7890
```

- 有 `host` / `route` / `node` 行 → 请求确实被拦到了，看它去没去代理；
- 一条都没有 → 那个请求不是从 DSH 进程发出的（典型：走了 bili 之类的外部进程）。

## 限制

- 只支持 HTTP(S) 正向代理，不支持 SOCKS5；
- 按 hostname 匹配，不看路径/模型名；
- 需要重启 DSH 才能让新增的拦截层装上。

## 贡献 / Contributing

- **Issue 欢迎**：bug、兼容性、文档问题都可以提。
- **不接受 Pull Request**：外部改动不合并进 `main`，有用的话请在 issue 里说明，我自己实现。
- **可以 Fork 二开**：MIT 许可，随意改、改名、私有部署，保留 `LICENSE` 的版权声明即可，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
