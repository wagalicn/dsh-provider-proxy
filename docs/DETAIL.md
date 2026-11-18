# 提供商代理（@wagalicn/dsh-provider-proxy）

为每个模型提供商单独指定接口地址和 HTTP 代理。列表里有代理的走代理，没填代理的直连，**不在列表里的地址也直连**——不继承系统或 DSH 启动时的 `HTTP_PROXY` / `HTTPS_PROXY`。

## 配置

插件页会自动列出「设置 → 模型」里已经添加的模型提供商（接口地址自动带出），右边填代理即自动加入列表；也可点「+ 添加一行」手动填任意接口地址。
页面底部可勾选「列表外的地址跟随系统代理」：未列出的域名走 Windows「Internet 选项」里的代理（或 `HTTPS_PROXY`/`HTTP_PROXY`），不勾选则一律直连。

设置 → 插件 → 提供商代理，给每个提供商加一行：

| 字段 | 说明 |
| --- | --- |
| 名称（`provider`） | 仅作标签，建议与 设置 → 模型 里的提供商 id 一致，方便对照 |
| 接口地址（`baseURL`） | 该提供商的接口地址，例如 `https://api.openai.com/v1`。插件只取其中的域名做匹配 |
| 代理（`proxy`） | 该提供商使用的 HTTP 代理，例如 `http://127.0.0.1:7890`；留空即直连 |

```yaml
providers:
  - provider: openai
    baseURL: https://api.openai.com/v1
    proxy: http://127.0.0.1:7890
  - provider: anthropic
    baseURL: https://api.anthropic.com
    proxy: http://127.0.0.1:7890
  - provider: deepseek
    baseURL: https://api.deepseek.com
    proxy: ""
```

改完立即生效（约 1 秒内），不需要重启。

## 匹配规则

- 按请求 URL 的**域名**精确匹配（大小写不敏感）；同一域名出现多行时，后一行覆盖前一行。
- 命中且代理非空 → 走该代理。
- 命中但代理为空 → 直连。
- 未命中 → 直连；勾选「列表外的地址跟随系统代理」时改走系统代理。
- 代理地址只支持 `http://` 与 `https://`；写成 `socks5://` 会被忽略并按直连处理，同时在终端提示。

## 注意

- 插件替换的是进程级的全局 HTTP 调度器，影响所有出站请求（模型调用、网页抓取等），不限于模型调用。
- 禁用或卸载插件会恢复原来的调度器。
- 代理地址若含账号密码（`http://user:pass@host:port`），请自行确认安全；插件日志只输出域名与是否走代理，不打印代理地址本身。
