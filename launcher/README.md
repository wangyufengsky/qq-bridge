# 双 AI 机器人统一入口

双击 `启动两个机器人.command`：检查本地 DSH 和 Docker、启动已有 QQ 容器、核对两个登录账号，再启动大肥鱼、大肥龙及管理服务，最后打开两个管理台。

- 大肥鱼管理台：http://127.0.0.1:3100/
- 大肥龙管理台：http://127.0.0.1:3112/
- 双机器人管理服务：http://127.0.0.1:3110/

启动器自动读取控制台令牌，不在终端输出令牌。重复启动会复用现有进程。

默认已经打开 DSH 和 Docker；保留日常 Codex 桌面端。大肥龙沿用专用登录的 Codex CLI app-server，不连接 Codex 桌面端。QQ 容器存在但停止时会自动启动；需要扫码时会提示。

双击 `停止两个机器人.command` 停止两个桥接和统一管理服务，保留 DSH、Codex 桌面端及 QQ 容器。下次启动恢复停止前各机器人的发言暂停状态。人格、模型、白名单从实例当前配置读取，不用旧管理配置覆盖。

```sh
node scripts/robots.mjs status
node scripts/robots.mjs start --no-open
node scripts/robots.mjs stop
```

首次使用：复制 `launcher.example.json` 为 `launcher.json`，填写现有大肥鱼 Bridge 目录、当前双 AI 仓库目录及 QQ 容器名。路径相对本 `launcher/` 目录解析，也可以填写绝对路径；本机配置被 Git 忽略。

本启动器接管的是已经完成登录和配置的两只机器人，不负责首次安装：先按 [双 AI 指南](../docs/guides/DUAL-AI.md) 准备 `multi-bot.json`、现有大肥鱼实例及 Codex 实例，完成两只 QQ 和专用 Codex 登录，并启动过管理台以生成管理令牌。`multi-bot.json` 中使用 `deepseek`（external DSH）和 `codex` 这两个 ID；deepseek 的 instanceDir 必须与 fishRoot 指向同一目录，两个实例的端口与账号信息要匹配。设置正确后再使用统一入口。

路径和容器名称在 `launcher.json`。源代码和机器人数据仍在各实例原目录，本目录负责统一启动管理。不要同时使用原项目的旧启动、停止脚本；它们有按名称批量结束进程的行为。

运行日志：`.runtime/supervisor.log`、`.runtime/fish-process.log`，以及各实例原有日志。`.runtime` 中可能有配置备份，仅供本机使用，不提交到 Git。
