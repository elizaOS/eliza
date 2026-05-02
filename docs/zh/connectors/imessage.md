---
title: iMessage 连接器
sidebarTitle: iMessage
description: 使用 @elizaos/plugin-imessage 包将你的代理连接到 iMessage。
---

将你的代理连接到 iMessage，用于 macOS 上的私聊和群组对话。

<div id="overview">
## 概述
</div>

iMessage 连接器是一个外部 elizaOS 插件，可将你的代理桥接到 macOS 上的 iMessage 和短信。它直接访问原生 iMessage 数据库，并支持通过 SSH 连接远程主机。当在连接器配置中检测到 CLI 路径时，运行时会自动启用它。

<div id="package-info">
## 包信息
</div>

| 字段 | 值 |
|------|-----|
| 包 | `@elizaos/plugin-imessage` |
| 配置键 | `connectors.imessage` |
| 自动启用触发条件 | 连接器配置中 `cliPath` 为真 |

<div id="prerequisites">
## 先决条件
</div>

- 已配置并登录 iMessage 的 macOS
- 已向运行 Eliza 的终端或应用程序授予完全磁盘访问权限（用于访问 `~/Library/Messages/chat.db` 的聊天数据库）
- 用于访问 iMessage 的 CLI 工具（例如 `imessage-exporter`）

<div id="minimal-configuration">
## 最小配置
</div>

在 `~/.eliza/eliza.json` 中：

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="disabling">
## 禁用
</div>

即使存在 CLI 路径，也可以显式禁用连接器：

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">
## 自动启用机制
</div>

`plugin-auto-enable.ts` 模块会检查配置中的 `connectors.imessage`。如果 `cliPath` 字段为真（且 `enabled` 未显式设为 `false`），运行时会自动加载 `@elizaos/plugin-imessage`。

无需环境变量来触发自动启用 — 完全由连接器配置对象驱动。

<div id="full-configuration-reference">
## 完整配置参考
</div>

所有字段都定义在 `eliza.json` 的 `connectors.imessage` 下。

<div id="core-fields">
### 核心字段
</div>

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `cliPath` | string | — | iMessage CLI 工具可执行文件的路径 |
| `dbPath` | string | — | iMessage 数据库路径（默认：`~/Library/Messages/chat.db`） |
| `remoteHost` | string | — | 用于通过 SSH 访问 iMessage 的远程 Mac 主机名 |
| `service` | `"imessage"` \| `"sms"` \| `"auto"` | — | 消息服务选择。`"auto"` 自动检测合适的服务 |
| `region` | string | — | 电话号码格式化的区域配置 |
| `name` | string | — | 账户显示名称 |
| `enabled` | boolean | — | 显式启用/禁用 |
| `capabilities` | string[] | — | 能力标志 |
| `includeAttachments` | boolean | — | 在消息中包含附件 |
| `configWrites` | boolean | — | 允许从 iMessage 事件写入配置 |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | 私信访问策略。`"open"` 要求 `allowFrom` 包含 `"*"` |
| `allowFrom` | (string\|number)[] | — | 允许发送私信的用户 ID |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | 群组加入策略 |
| `groupAllowFrom` | (string\|number)[] | — | 允许加入群组的用户 ID |
| `historyLimit` | integer >= 0 | — | 上下文中的最大消息数 |
| `dmHistoryLimit` | integer >= 0 | — | 私信的历史记录限制 |
| `dms` | object | — | 按私信 ID 索引的每个私信历史记录覆盖。每个值：`{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | 每个消息片段的最大字符数 |
| `chunkMode` | `"length"` \| `"newline"` | — | 长消息分割策略 |
| `mediaMaxMb` | integer > 0 | — | 最大媒体文件大小（MB） |
| `markdown` | object | — | 表格渲染：`tables` 可以是 `"off"`、`"bullets"` 或 `"code"` |

<div id="streaming-configuration">
### 流式配置
</div>

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `blockStreaming` | boolean | — | 完全禁用流式传输 |
| `blockStreamingCoalesce` | object | — | 合并设置：`minChars`、`maxChars`、`idleMs` |

<div id="group-configuration">
### 群组配置
</div>

每组设置定义在 `groups.<group-id>` 下：

| 字段 | 类型 | 描述 |
|------|------|------|
| `requireMention` | boolean | 仅在被 @ 提及时回复 |
| `tools` | ToolPolicySchema | 工具访问策略 |
| `toolsBySender` | object | 按发送者的工具策略（按发送者 ID 索引） |

<div id="heartbeat">
### 心跳
</div>

```json
{
  "connectors": {
    "imessage": {
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

`accounts` 字段允许从单个代理运行多个 iMessage 账户：

```json
{
  "connectors": {
    "imessage": {
      "accounts": {
        "personal": {
          "cliPath": "/usr/local/bin/imessage",
          "service": "imessage",
          "groups": {}
        },
        "work": {
          "cliPath": "/usr/local/bin/imessage",
          "remoteHost": "work-mac.local",
          "service": "auto",
          "groups": {}
        }
      }
    }
  }
}
```

每个账户条目支持与顶级 `connectors.imessage` 配置相同的字段（不包括 `accounts` 字段本身）。

<div id="remote-host-access">
## 远程主机访问
</div>

要通过 SSH 连接到远程 Mac 上的 iMessage，设置 `remoteHost` 字段：

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "remoteHost": "mac-mini.local"
    }
  }
}
```

确保本地机器和远程主机之间已配置基于 SSH 密钥的认证。

<div id="troubleshooting">
## 故障排除
</div>

<div id="full-disk-access">
### 完全磁盘访问
</div>

如果消息检索失败，请确保已授予完全磁盘访问权限：

1. 打开 **系统设置 > 隐私与安全 > 完全磁盘访问**
2. 添加终端应用程序或 Eliza 进程

<div id="database-path">
### 数据库路径
</div>

默认的 iMessage 数据库位于 `~/Library/Messages/chat.db`。如果使用非标准位置，请显式设置 `dbPath`。

<div id="macos-only">
### 仅限 macOS
</div>

iMessage 连接器需要 macOS。它无法在 Linux 或 Windows 上运行。

<div id="related">
## 相关链接
</div>

- [iMessage 插件参考](/zh/plugin-registry/platform/imessage)
- [连接器概述](/zh/guides/connectors)
- [配置参考](/zh/configuration)
