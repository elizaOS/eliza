---
title: Signal 连接器
sidebarTitle: Signal
description: 使用 @elizaos/plugin-signal 包将你的代理连接到 Signal。
---

通过 signal-cli 将你的代理连接到 Signal，支持私聊和群组消息。

<div id="overview">

## 概述

</div>

Signal 连接器是一个外部 elizaOS 插件，通过以 HTTP 或 JSON-RPC 模式运行的 signal-cli 将你的代理桥接到 Signal。当检测到有效的账户配置时，运行时会自动启用该连接器。

<div id="package-info">

## 包信息

</div>

| 字段 | 值 |
|-------|-------|
| 包 | `@elizaos/plugin-signal` |
| 配置键 | `connectors.signal` |
| 自动启用触发条件 | `token`/`botToken`/`apiKey`，或 `authDir`/`account`/`httpUrl`/`httpHost`/`httpPort`/`cliPath` 中的任意一个，或包含已配置条目的 `accounts` |

<div id="minimal-configuration">

## 最小配置

</div>

在 `~/.eliza/eliza.json` 中：

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="setup">

## 设置

</div>

<div id="1-install-signal-cli">

### 1. 安装 signal-cli

</div>

安装 [signal-cli](https://github.com/AsamK/signal-cli) 并注册或链接一个 Signal 账户：

```bash
signal-cli -a +1234567890 register
signal-cli -a +1234567890 verify CODE
```

<div id="2-start-signal-cli-in-http-mode">

### 2. 以 HTTP 模式启动 signal-cli

</div>

```bash
signal-cli -a +1234567890 daemon --http localhost:8080
```

<div id="3-configure-eliza">

### 3. 配置 Eliza

</div>

将 `connectors.signal` 块添加到 `eliza.json` 中，如上述最小配置所示。

<div id="disabling">

## 禁用

</div>

即使已配置账户，也可以显式禁用连接器：

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">

## 自动启用机制

</div>

`plugin-auto-enable.ts` 模块会检查配置中的 `connectors.signal`。当满足以下任一条件（且 `enabled` 未显式设置为 `false`）时，插件会自动启用：

- `account` 与 `httpUrl` 同时设置
- `cliPath` 已设置（signal-cli 二进制文件路径，用于自动启动）
- `accounts` 包含至少一个已配置的条目

无需设置环境变量即可触发自动启用——它完全由连接器配置对象驱动。

<div id="environment-variables">

## 环境变量

</div>

运行时会通过 `CHANNEL_ENV_MAP` 将 `connectors.signal` 配置中的以下环境变量注入 `process.env`，以便插件在启动时读取：

| 环境变量 | 源配置字段 | 描述 |
|---|---|---|
| `SIGNAL_AUTH_DIR` | `authDir` | signal-cli 数据目录路径 |
| `SIGNAL_ACCOUNT_NUMBER` | `account` | Signal 电话号码（E.164 格式） |
| `SIGNAL_HTTP_URL` | `httpUrl` | signal-cli 守护进程的 HTTP URL |
| `SIGNAL_CLI_PATH` | `cliPath` | signal-cli 二进制文件路径 |

你无需手动设置这些变量——它们在运行时从连接器配置中自动派生。

<div id="full-configuration-reference">

## 完整配置参考

</div>

所有字段定义在 `eliza.json` 的 `connectors.signal` 下。

<div id="core-fields">

### 核心字段

</div>

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `account` | string | — | E.164 格式的 Signal 电话号码（例如 `+1234567890`） |
| `httpUrl` | string | — | signal-cli 守护进程的 HTTP URL（例如 `http://localhost:8080`） |
| `httpHost` | string | — | 替代 `httpUrl` 的主机名 |
| `httpPort` | integer > 0 | — | 替代 `httpUrl` 的端口 |
| `cliPath` | string | — | signal-cli 二进制文件路径，用于自动启动 |
| `autoStart` | boolean | — | 连接器加载时自动启动 signal-cli |
| `startupTimeoutMs` | integer (1000-120000) | — | 等待 CLI 启动的毫秒数（1-120 秒） |
| `receiveMode` | `"on-start"` \| `"manual"` | `"on-start"` | 开始接收消息的时机 |
| `name` | string | — | 账户显示名称 |
| `enabled` | boolean | — | 显式启用/禁用 |
| `capabilities` | string[] | — | 功能标志 |
| `configWrites` | boolean | — | 允许从 Signal 事件写入配置 |

<div id="message-handling">

### 消息处理

</div>

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `ignoreAttachments` | boolean | — | 忽略传入的附件（默认行为包含附件） |
| `ignoreStories` | boolean | — | 忽略故事消息（默认行为排除故事） |
| `sendReadReceipts` | boolean | — | 为收到的消息发送已读回执 |
| `historyLimit` | integer >= 0 | — | 上下文中的最大消息数 |
| `dmHistoryLimit` | integer >= 0 | — | 私聊的历史记录限制 |
| `dms` | object | — | 按私聊 ID 键控的每个私聊历史记录覆盖。每个值：`{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | 每个消息块的最大字符数 |
| `chunkMode` | `"length"` \| `"newline"` | — | 长消息拆分策略 |
| `mediaMaxMb` | integer > 0 | — | 最大媒体文件大小（MB） |
| `markdown` | object | — | 表格渲染：`tables` 可以是 `"off"`、`"bullets"` 或 `"code"` |

<div id="access-policies">

### 访问策略

</div>

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | 私聊访问策略。`"open"` 要求 `allowFrom` 包含 `"*"` |
| `allowFrom` | (string\|number)[] | — | 允许发送私聊的用户 ID |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | 群组加入策略 |
| `groupAllowFrom` | (string\|number)[] | — | 允许加入群组的用户 ID |

<div id="streaming-configuration">

### 流式传输配置

</div>

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `blockStreaming` | boolean | — | 完全禁用流式传输 |
| `blockStreamingCoalesce` | object | — | 合并设置：`minChars`、`maxChars`、`idleMs` |

<div id="actions">

### 操作

</div>

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `actions.reactions` | boolean | 发送表情回应 |

<div id="reaction-notifications">

### 表情回应通知

</div>

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | 哪些表情回应触发通知 |
| `reactionAllowlist` | (string\|number)[] | 当 `reactionNotifications` 为 `"allowlist"` 时，哪些用户 ID 的表情回应触发通知 |
| `reactionLevel` | `"off"` \| `"ack"` \| `"minimal"` \| `"extensive"` | 表情回应响应的详细程度 |

<div id="heartbeat">

### 心跳检测

</div>

```json
{
  "connectors": {
    "signal": {
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

`accounts` 字段允许从单个代理运行多个 Signal 账户：

```json
{
  "connectors": {
    "signal": {
      "accounts": {
        "personal": {
          "account": "+1234567890",
          "httpUrl": "http://localhost:8080",
          "dmPolicy": "pairing"
        },
        "work": {
          "account": "+0987654321",
          "httpUrl": "http://localhost:8081",
          "dmPolicy": "allowlist",
          "allowFrom": ["+1111111111"]
        }
      }
    }
  }
}
```

每个账户条目接受与顶层 `connectors.signal` 配置相同的所有字段。顶层字段作为默认值，各个账户可以覆盖这些默认值。

<div id="validation">

## 验证

</div>

- 当 `dmPolicy` 为 `"open"` 时，`allowFrom` 数组必须包含 `"*"`。
- `startupTimeoutMs` 必须在 1000 到 120000 之间（1-120 秒）。

<div id="related">

## 相关内容

</div>

- [Signal 插件参考](/zh/plugin-registry/platform/signal)
- [连接器概述](/zh/guides/connectors)
- [配置参考](/zh/configuration)
