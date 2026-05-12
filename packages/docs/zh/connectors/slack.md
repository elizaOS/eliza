---
title: Slack 连接器
sidebarTitle: Slack
description: 使用 @elizaos/plugin-slack 包将你的代理连接到 Slack 工作区。
---

<div id="overview">

## 概述

</div>

Slack 连接器是一个外部 elizaOS 插件，将你的代理桥接到 Slack 工作区。它支持两种传输模式（Socket Mode 和 HTTP webhooks）、按频道配置、私信策略、斜杠命令、多账户支持以及细粒度操作权限。当在连接器配置中检测到有效令牌时，运行时会自动启用该连接器。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|------|----|
| 包 | `@elizaos/plugin-slack` |
| 配置键 | `connectors.slack` |
| 自动启用触发器 | 连接器配置中 `botToken`、`token` 或 `apiKey` 为真值 |

<div id="minimal-configuration">

## 最小配置

</div>

在 `~/.eliza/eliza.json` 中：

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token"
    }
  }
}
```

<div id="disabling">

## 禁用

</div>

即使存在令牌，也可以显式禁用连接器：

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">

## 自动启用机制

</div>

`plugin-auto-enable.ts` 模块会检查配置中的 `connectors.slack`。如果 `botToken`、`token` 或 `apiKey` 中任何一个字段为真值（且 `enabled` 未显式设为 `false`），运行时会自动加载 `@elizaos/plugin-slack`。

触发自动启用不需要任何环境变量——它完全由连接器配置对象驱动。

<div id="environment-variables">

## 环境变量

</div>

当连接器加载时，运行时会将以下密钥从你的配置推送到 `process.env` 中供插件使用：

| 变量 | 来源 | 描述 |
|------|------|------|
| `SLACK_BOT_TOKEN` | `botToken` | Bot 令牌（`xoxb-...`） |
| `SLACK_APP_TOKEN` | `appToken` | 应用级令牌（`xapp-...`），用于 Socket Mode |
| `SLACK_USER_TOKEN` | `userToken` | 用户令牌（`xoxp-...`），用于用户范围的操作 |

<div id="transport-modes">

## 传输模式

</div>

Slack 支持两种传输模式：

<div id="socket-mode-default">

### Socket Mode（默认）

</div>

通过 Slack 的 Socket Mode API 使用 WebSocket。需要应用级令牌（`xapp-...`）。

```json
{
  "connectors": {
    "slack": {
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

<div id="http-mode">

### HTTP 模式

</div>

通过 HTTP webhooks 接收事件。需要签名密钥用于请求验证。

```json
{
  "connectors": {
    "slack": {
      "mode": "http",
      "botToken": "<SLACK_BOT_TOKEN>",
      "signingSecret": "your-signing-secret",
      "webhookPath": "/slack/events"
    }
  }
}
```

当 `mode` 为 `"http"` 时，`signingSecret` 是必需的（由 schema 验证）。

<div id="full-configuration-reference">

## 完整配置参考

</div>

`connectors.slack` 下的所有字段：

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `botToken` | string | — | Bot 令牌（`xoxb-...`） |
| `appToken` | string | — | 应用级令牌（`xapp-...`），用于 Socket Mode |
| `userToken` | string | — | 用户令牌（`xoxp-...`），用于用户范围的 API 调用 |
| `userTokenReadOnly` | boolean | `true` | 将用户令牌限制为只读操作 |
| `mode` | `"socket"` \| `"http"` | `"socket"` | 传输模式 |
| `signingSecret` | string | — | HTTP 模式的签名密钥（当 mode 为 `"http"` 时必需） |
| `webhookPath` | string | `"/slack/events"` | HTTP webhook 端点路径 |
| `name` | string | — | 账户显示名称 |
| `enabled` | boolean | — | 显式启用/禁用 |
| `capabilities` | string[] | — | 能力标志 |
| `allowBots` | boolean | `false` | 允许 bot 消息触发响应 |
| `requireMention` | boolean | — | 仅在被 @ 提及时响应 |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | 群组/频道加入策略 |
| `historyLimit` | integer >= 0 | — | 对话上下文中的最大消息数 |
| `dmHistoryLimit` | integer >= 0 | — | 私信的历史记录限制 |
| `dms` | Record\<string, \{historyLimit?\}\> | — | 每条私信的历史记录覆盖 |
| `textChunkLimit` | integer > 0 | — | 每个消息片段的最大字符数 |
| `chunkMode` | `"length"` \| `"newline"` | — | 长消息分割策略 |
| `blockStreaming` | boolean | — | 禁用流式响应 |
| `blockStreamingCoalesce` | object | — | 合并：`minChars`、`maxChars`、`idleMs` |
| `mediaMaxMb` | number > 0 | — | 最大媒体文件大小（MB） |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | 回复线程模式 |
| `configWrites` | boolean | `true` | 允许从 Slack 事件进行配置写入 |
| `markdown` | object | — | 表格渲染：`tables` 可以是 `"off"`、`"bullets"` 或 `"code"` |
| `commands` | object | — | `native` 和 `nativeSkills` 开关 |

<div id="reply-to-mode-by-chat-type">

### 按聊天类型的回复模式

</div>

按聊天类型覆盖 `replyToMode`：

```json
{
  "connectors": {
    "slack": {
      "replyToModeByChatType": {
        "direct": "all",
        "group": "first",
        "channel": "off"
      }
    }
  }
}
```

<div id="actions">

### 操作

</div>

| 字段 | 类型 | 描述 |
|------|------|------|
| `actions.reactions` | boolean | 添加表情回应 |
| `actions.messages` | boolean | 发送消息 |
| `actions.pins` | boolean | 置顶消息 |
| `actions.search` | boolean | 搜索消息 |
| `actions.permissions` | boolean | 管理权限 |
| `actions.memberInfo` | boolean | 查看成员信息 |
| `actions.channelInfo` | boolean | 查看频道信息 |
| `actions.emojiList` | boolean | 列出可用 emoji |

<div id="reaction-notifications">

### 表情回应通知

</div>

| 字段 | 类型 | 描述 |
|------|------|------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | 哪些表情回应触发通知 |
| `reactionAllowlist` | (string\|number)[] | 要通知的表情回应名称（使用 `"allowlist"` 时） |

<div id="dm-policy">

### 私信策略

</div>

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `dm.enabled` | boolean | — | 启用/禁用私信 |
| `dm.policy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | 私信访问策略 |
| `dm.allowFrom` | (string\|number)[] | — | 允许的用户 ID。`"open"` 策略必须包含 `"*"` |
| `dm.groupEnabled` | boolean | — | 启用群组私信 |
| `dm.groupChannels` | (string\|number)[] | — | 允许的群组私信频道 ID |
| `dm.replyToMode` | `"off"` \| `"first"` \| `"all"` | — | 私信专用的回复线程模式 |

<div id="thread-configuration">

### 线程配置

</div>

| 字段 | 类型 | 描述 |
|------|------|------|
| `thread.historyScope` | `"thread"` \| `"channel"` | `"thread"` 按线程隔离历史记录。`"channel"` 复用频道对话历史 |
| `thread.inheritParent` | boolean | 线程会话是否继承父频道的对话记录（默认：false） |

<div id="slash-commands">

### 斜杠命令

</div>

```json
{
  "connectors": {
    "slack": {
      "slashCommand": {
        "enabled": true,
        "name": "agent",
        "sessionPrefix": "slash",
        "ephemeral": true
      }
    }
  }
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `slashCommand.enabled` | boolean | 启用斜杠命令处理 |
| `slashCommand.name` | string | 斜杠命令名称（例如 `/agent`） |
| `slashCommand.sessionPrefix` | string | 斜杠命令对话的会话 ID 前缀 |
| `slashCommand.ephemeral` | boolean | 以临时消息发送响应（仅对调用者可见） |

<div id="channel-configuration">

### 频道配置

</div>

`channels.<channel-id>` 下的每频道设置：

| 字段 | 类型 | 描述 |
|------|------|------|
| `enabled` | boolean | 启用/禁用此频道 |
| `allow` | boolean | 允许 bot 在此频道中运行 |
| `requireMention` | boolean | 仅在被 @ 提及时响应 |
| `tools` | ToolPolicySchema | 工具访问策略 |
| `toolsBySender` | Record\<string, ToolPolicySchema\> | 按发送者的工具策略 |
| `allowBots` | boolean | 允许 bot 消息在此频道中触发 |
| `users` | (string\|number)[] | 允许的用户 ID |
| `skills` | string[] | 允许的技能 |
| `systemPrompt` | string | 频道专用系统提示 |

<div id="heartbeat">

### Heartbeat

</div>

```json
{
  "connectors": {
    "slack": {
      "heartbeat": {
        "showOk": true,
        "showAlerts": true,
        "useIndicator": true
      }
    }
  }
}
```

<div id="multi-account-support">

### 多账户支持

</div>

```json
{
  "connectors": {
    "slack": {
      "accounts": {
        "workspace-1": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" },
        "workspace-2": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" }
      }
    }
  }
}
```

<div id="related">

## 相关内容

</div>

- [Slack 插件参考](/zh/plugin-registry/platform/slack)
- [连接器概述](/zh/guides/connectors)
- [配置参考](/zh/configuration)
