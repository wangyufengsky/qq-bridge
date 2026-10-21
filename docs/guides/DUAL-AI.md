# DeepSeek / Codex 双 AI 开发版

此分支复用现有 QQ Bridge，引入 Codex app-server 适配器和多账号管理台。
当前大肥鱼可作为外部 DSH 实例接入管理台；Codex 使用独立实例目录。

## 启动管理台

```bash
npm ci
cp multi-bot.example.json multi-bot.json
npm run start:multi
```

访问 `http://127.0.0.1:3110`，输入本地 `state/manager-token` 的管理令牌。
管理台启动时不会自动启动任何机器人，也不会改动已有 QQ 容器。

- `external:true`：连接现有 DSH Bridge，`instanceDir` 指向其真实目录，`consolePort` 匹配原控制台；支持状态、暂停/恢复与独立设置入口。它的进程/容器继续由原启动方式管理。
- Codex 实例：使用独立目录与控制台端口；填好 `accountId`、OneBot HTTP/WS 地址、令牌和群白名单后，才允许启动。
- 两个账号的 ID、目录、端口与 OneBot 地址不能重复。
- `multi-bot.json`、`instances/`、凭据和聊天状态已加入忽略规则。不要提交个人配置。

实例初始化只创建缺失的人格/状态目录，保留已有角色文件；可以在该账号的设置页添加人格。管理台令牌不能调用内部机器人协调接口，协调接口使用独立随机令牌。

## Codex 登录与模型

每个 Codex 实例使用自己的 `state/codex-home`，不会加载日常工作账号目录中的插件、项目指令和聊天历史。
在实例目录运行 `env CODEX_HOME="$PWD/state/codex-home" codex login` 完成该实例的登录。
认证留在本机，不将密码或登录令牌填入人格。

`codex.model` 可省略，由本机模型目录确定默认值；`codex.effort` 默认 medium。
只有模型实际完成一次回合，才证明该账号对所选模型有可用额度。

工具通过本地 MCP 读取 schema，再注册到 app-server 的 dynamicTools。
回调校验会话与回合归属，未知工具、终端审批和外部线程请求被拒绝。
Codex 使用 read-only 沙箱，关闭 shell、unified exec、multi-agent、plugins、memories、skill search、原生 web search 和本地看图工具。
仍须在真实账号联调时核对最终模型工具面；“协议接受配置”不等于已完成真实模型隔离验收。

Codex 实例保存或还原仿真提示词只作用于自身目录，新建或重置会话后载入，不会同步写入全局 DSH 预设。

回合按会话串行；中断撤销排队工作。RPC 回执超时不自动重发，不把不确定结果当成完成。

## QQ 容器

`compose.multi-bot.example.yml` 使用现有镜像版本的实际内部端口和三个持久化数据目录。
两个服务都有 profile，分别显式启动：

```bash
docker compose -f compose.multi-bot.example.yml --profile codex up -d qq-codex
docker compose -f compose.multi-bot.example.yml stop qq-codex
```

第二个容器登录入口为 `http://127.0.0.1:6902`，OneBot 端口为 3010/3011。
第一只的可选新容器使用 3300/3301，以免与现有容器冲突；迁移第一只时需要同步配置，不能覆盖现有登录卷。
示例 2 GiB / 2 CPU 是试跑起点，可通过环境变量调整，尚未经过双开峰值测试。
当前管理台启动/停止的是桥接 worker，容器启停仍使用 Compose；尚未实现管理台直接控制容器。

## 互聊和浏览器

允许配置的机器人互相接话。管理端协调器按群统计、去重，默认连续接受 6 条机器人消息后冷却 60 秒；人类发言可开启新一轮。
实际是否接话仍受账号自己的唤醒条件控制，并非每条必答。
接入的外部旧 DSH 实例不经过新协调器；首版对 Codex 一侧限制机器人触发，旧实例的主动发言仍由原设置控制。完整双向统一控制需要迁移第一只后验收。

平台工具置于 `packages/social-reader`，复用搜索、读帖、评论、首页与热榜。
所有使用新版读取器的 MCP 进程共享同一个浏览器锁，串行调用 OpenCLI；读取失败也释放锁。
等待超时明确返回失败，不用搜索结果冒充首页。持锁进程异常退出时报告孤儿锁，需管理端确认没有浏览器任务后清理；不会擅自抢占仍活跃的锁。
现有生产 DSH 插件也需要升级到该读取器后，才能参与同一把锁。
本版实现跨进程互斥；统一服务的公平队列、按 botId 取消与缓存隔离属于后续阶段。

## 验证

```bash
npm run test:dual
npm run test:social
node scripts/probe-codex-bridge.mjs
npm run test:regressions
```

协议探针不调用模型、不发送 QQ 消息。离线测试覆盖隔离、回调、串行、中断、未知回执、浏览器锁和管理端鉴权。
尚需真实联调：第二 QQ 登录、Codex 推理及可见工具核对、QQ→Codex→QQ、双机器人互聊、图片、双开峰值资源。

## 初期开发验证记录（2026-10-20，历史快照）

- `npm run test:dual`：16/16，通过账号/端点隔离、串行/中断/未知回执、管理端鉴权、跨进程浏览器锁、真实控制台保存/还原路由的 DSH 隔离测试。
- `npm run test:preset-prompt`：13/13，覆盖 CRLF 与 LF。
- `npm run test:social`：12/12；`npm run test:regressions`：16/16。
- 回复等待测试：10/10；QQ 模型视图测试：8/8。
- 本机 Codex `0.163.0-alpha.10.2`：初始化、模型目录查询、带真实平台 MCP schema 的 thread/start 成功。动态工具使用 `qq__` / `web__` / `social__` 别名；app-server 拒绝保留的 `mcp__` 前缀。
- 协议探针在临时、未登录的 CODEX_HOME 中运行，未请求模型推理，未发送 QQ 消息。
- 管理台浏览器检查：现有大肥鱼显示在线；Codex 伙伴显示未配置；实例设置链接正常打开。旧控制台禁止 iframe，因此使用独立设置页面。
- Compose 语法、Node 语法与 `git diff --check` 通过。第二容器未启动，未测量双开资源峰值。

以下为初期联调时的验收边界，后续进展见本文末尾。完整双向互聊协调、生产 DSH 读取器升级和真实 Codex 工具面验收须在后续部署联调中完成。Codex 用量事件与现有花费账本的适配也尚待补齐。

### 首次独立实例联调补充

第二 QQ 实例已完成扫码登录，OneBot get_login_info 与绑定账号一致，WebSocket 心跳正常。专用 CODEX_HOME 已完成 ChatGPT 授权；使用实际 Codex 适配器注册 41 个 MCP 动态工具后，默认模型 gpt-6.1-sol 完成最小推理并返回 CODEX_QQ_READY，整个测试没有工具调用或 QQ 发送。此结果验证模型连通和工具注册，尚不证明 QQ 往返或所有工具执行成功。

首次启动修复：创建独立 CODEX_HOME；保留 Codex medium 档位；配置 HTTP/WS 两套令牌；固定端点模式禁止扫描到其他实例，并验证账号一致。18 项双 AI 测试和 16 项原桥接回归通过。人格页已显示 Codex 引擎及实例内预设保存说明。

容器镜像 Node 文件带 cap_sys_ptrace=ep，必须添加 SYS_PTRACE 才能执行；Compose 已补齐该能力，保留默认 seccomp。新实例保持暂停、白名单为空，等待独立人格及后续群聊验收。


## Codex 生成图片发送

Codex 生图后调用 `qq__qq_send_generated_image({key, token, filePath})`，其中路径来自本轮生图结果。Bridge 只允许当前映射线程的 `generated_images/<threadId>/` 中的 PNG/JPEG/WebP，最大 10 MiB；拒绝其他会话、任意文件、符号链接和硬链接。Bridge 读取后以 OneBot 图片段的 base64 发送，QQ 容器无需访问宿主机路径。

复用会话令牌、白名单、暂停、静默、发送队列及限流。`socialV2.tools.sendGeneratedImage=false` 可禁用（MCP 工具清单需重启加载）。成功返回 `messageId`；同一会话同一图片再次调用会返回已有回执，不再发送。未知回执保存在实例 `state/generated-image-sends.json`，应先核对 QQ，不能盲目重发。

增加动态工具后，既有 Codex 会话需通过管理台重置以加载新清单；先保留需要的会话记录。管理员补发旧图片应在旧会话映射仍有效时进行。测试：`node --test test/dual/*.test.mjs`。

## 发布整理（2026-10-21）

双 AI 源码、平台读取器、图片发送修复、统一启动入口与人格模板在本分支统一保存。统一入口位于 `launcher/`，人格模板位于 `personas/`。源仓库与外部 DSH 实例仍分别部署，本次整理不迁移在线实例。

此前本机已验证两只 QQ 同时在线、专用 Codex 推理和实际群聊回复，以及一次经管理员授权的生成图片发送与 QQ 消息回读。2026-10-21 观察到 DSH 看图工具成功返回图片并实际回群。上述是历史运行证据，不代表新环境克隆后无需配置即可用；本次发布不发送新的 QQ 测试消息。

账号、群号与管理员身份通过本地配置绑定，模板只提供占位符。登录文件、聊天状态、图片素材、工具日志和本机配置不入库。完整双向互聊协调、DSH 读取器统一部署、资源峰值和 Codex 花费账本适配仍按前述边界处理。

发布前离线验证：双 AI 21/21、平台读取器 12/12、桥接回归 16/16、预设 13/13、Fake-IP DNS 14/14、隐私扫描回归 1/1。统一启动脚本完成 Node / shell 语法检查；本次发布不重启现有实例，不把语法检查当作全新部署端到端验收。
