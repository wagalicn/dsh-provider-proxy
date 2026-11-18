# 参与方式 / Contributing

## 中文

这个插件是**单人维护**的。为了保证行为可预期、避免半成品改动进入主线，采用下面的规则：

### 欢迎
- **提 Issue**：bug、兼容性问题、文档错误、想做但不确定的需求，都请开 issue。请带上：DSH 版本、系统、`~/.dsh/provider-proxy.log` 里的相关行（记得先去掉自己的代理地址和域名）。
- **Fork 与二开**：仓库是 MIT 许可证，你可以在自己的机器上任意修改、改名、私有部署，甚至内部分发。只要求保留 `LICENSE` 里的版权声明，并且不要用原作者名义发布。

### 不接受
- **Pull Request 不会被合并**。不是不欢迎你的代码，而是我一个人没有精力 review 与长期维护外部提交的改动；如果你改了有用的东西，请在 issue 里描述思路或贴关键代码，我会自己实现。
- **不要申请写入权限，也不要直接推 `main`**。`main` 分支受保护：禁止强推、禁止删除。

### 自己发布二开版本
1. Fork 后改 `package.json` 的 `name`（避免和 `@wagalicn/dsh-provider-proxy` 冲突）；
2. 同步修改 `cordis.patch.yml` 里的 `name`，以及 `client.js` 里 `__ModuleLoader__.load({ id: ... })` 的 id —— 三者必须一致，否则客户端模块不会被加载；
3. `pnpm pack` 后 `dsh plugin add file:<tgz 绝对路径>` 即可安装到自己机器。

## English

This plugin is maintained by a **single author**. To keep behaviour predictable:

- **Issues are welcome** — bugs, compatibility reports, doc fixes, feature ideas. Please include your DSH version, OS, and the relevant lines from `~/.dsh/provider-proxy.log` (strip your proxy address and hostnames first).
- **Pull requests will not be merged.** It is not about your code: I do not have the bandwidth to review and maintain external contributions. If your change is useful, describe it in an issue and I will implement it myself.
- **Do not request write access.** The `main` branch is protected against force-pushes and deletion.
- **Forks and private builds are fine.** The project is MIT licensed: modify it, rename it, ship it internally — just keep the copyright notice in `LICENSE` and do not publish under the original author's name.

When renaming a fork, change all three identifiers together: `package.json` `name`, the `name` in `cordis.patch.yml`, and the id in `client.js`'s `window.__ModuleLoader__.load({ id })`.
