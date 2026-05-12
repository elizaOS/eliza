---
title: "Slack 插件"
sidebarTitle: "Slack"
description: "Eliza 的 Slack 连接器 — 工作区机器人、频道监控、斜杠命令和交互式组件。"
---

Slack 插件将 Eliza 代理作为机器人应用连接到 Slack 工作区，处理频道、私信和线程中的消息，支持斜杠命令和交互式组件。

**Package:** `@elizaos/plugin-slack`

<div id="installation">
## 安装
</div>

```bash
eliza plugins install @elizaos/plugin-slack
```

<div id="setup">
## 设置
</div>

<div id="1-create-a-slack-app">
### 1. 创建 Slack 应用
</div>

1. 前往 [api.slack.com/apps](https://api.slack.com/apps)
2. 点击 **Create New App → From scratch**
3. 命名应用并选择你的工作区

<div id="2-configure-bot-permissions">
### 2. 配置机器人权限
</div>

导航到 **OAuth & Permissions → Scopes → Bot Token Scopes** 并添加：

| Scope | 用途 |
|-------|------|
| `app_mentions:read` | 接收 @提及 |
| `channels:history` | 读取频道消息 |
| `channels:read` | 列出频道 |
| `chat:write` | 发布消息 |
| `groups:history` | 读取私有频道消息 |
| `im:history` | 读取私信历史 |
| `im:read` | 访问私信信息 |
| `im:write` | 发送私信 |
| `mpim:history` | 读取群组私信历史 |
| `reactions:write` | 添加表情回应 |
| `users:read` | 查找用户信息 |

<div id="3-enable-socket-mode-recommended-for-development">
### 3. 启用 Socket Mode（推荐用于开发）
</div>

导航到 **Socket Mode** 并将其开启。生成一个具有 `connections:write` 范围的应用级别令牌。

<div id="4-enable-event-subscriptions">
### 4. 启用事件订阅
</div>

导航到 **Event Subscriptions** 并订阅机器人事件：

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

<div id="5-install-to-workspace">
### 5. 安装到工作区
</div>

导航到 **OAuth & Permissions** 并点击 **Install to Workspace**。复制 **Bot User OAuth Token**（`xoxb-...`）。

<div id="6-configure-eliza">
### 6. 配置 Eliza
</div>

```json
{
  "connectors": {
    "slack": {
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

<div id="configuration">
## 配置
</div>

| 字段 | 必需 | 描述 |
|------|------|------|
| `botToken` | 是 | Bot User OAuth Token（`xoxb-...`） |
| `appToken` | 否 | 用于 Socket Mode 的应用级别令牌（`xapp-...`） |
| `signingSecret` | 否 | 用于 webhook 验证的签名密钥 |
| `enabled` | 否 | 设置 `false` 以禁用（默认值：`true`） |
| `allowedChannels` | 否 | 允许响应的频道 ID 数组 |

<div id="features">
## 功能
</div>

- **斜杠命令** — 注册和响应 `/commands`
- **@提及** — 在频道中被提及时进行响应
- **私信** — 完整的私人对话支持
- **线程** — 参与线程回复
- **表情回应** — 为消息添加表情回应
- **Socket Mode** — 无需公共 URL 即可实时传递事件
- **Webhook 模式** — 生产环境 webhook 端点支持
- **交互式组件** — Block Kit 按钮和模态框

<div id="message-flow">
## 消息流程
</div>

```
Slack 事件（通过 Socket Mode 或 webhook）
       ↓
插件验证事件签名
       ↓
确定响应上下文：
  - app_mention → 在频道线程中响应
  - message.im → 在私信中响应
       ↓
AgentRuntime 处理消息
       ↓
响应发布到 Slack 频道/私信
```

<div id="auto-enable">
## 自动启用
</div>

当 `connectors.slack.botToken` 被设置时，插件会自动启用。

<div id="thread-behavior">
## 线程行为
</div>

默认情况下，响应以线程回复的形式发布，以保持频道整洁。要发布顶级回复：

```json
{
  "connectors": {
    "slack": {
      "botToken": "<SLACK_BOT_TOKEN>",
      "replyInThread": false
    }
  }
}
```

<div id="related">
## 相关
</div>

- [Discord 插件](/plugin-registry/platform/discord) — Discord 机器人集成
- [Telegram 插件](/plugin-registry/platform/telegram) — Telegram 机器人集成
- [连接器指南](/zh/guides/connectors) — 连接器通用文档
