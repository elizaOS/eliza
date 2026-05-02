---
title: "平台连接器"
sidebarTitle: "Connectors"
description: "28 个消息平台的平台桥接器 — 18 个通过配置自动启用（Discord、Telegram、Slack、WhatsApp、Signal、iMessage、Blooio、MS Teams、Google Chat、Twitter、Farcaster、Twitch、Mattermost、Matrix、Feishu、Nostr、Lens、WeChat），另有 10 个可从注册表安装（BlueBubbles、Bluesky、Instagram、LINE、Zalo、Twilio、GitHub、Gmail Watch、Nextcloud Talk、Tlon）。"
---

连接器是平台桥接器，允许你的代理在不同消息平台和社交网络之间进行通信。每个连接器负责处理身份验证、消息路由、会话管理和平台特定功能。

<div id="table-of-contents">
## 目录
</div>

1. [支持的平台](#supported-platforms)
2. [通用配置](#general-configuration)
3. [Discord](#discord)
4. [Telegram](#telegram)
5. [Slack](#slack)
6. [WhatsApp](#whatsapp)
7. [Signal](#signal)
8. [iMessage](#imessage)
9. [BlueBubbles](#bluebubbles)
10. [Blooio](#blooio)
11. [Microsoft Teams](#microsoft-teams)
11. [Google Chat](#google-chat)
12. [Twitter](#twitter)
13. [Farcaster](#farcaster)
14. [Bluesky](#bluesky)
15. [Instagram](#instagram)
16. [Twitch](#twitch)
17. [Mattermost](#mattermost)
18. [WeChat](#wechat)
19. [Matrix](#matrix)
20. [Feishu / Lark](#feishu--lark)
21. [Nostr](#nostr)
22. [LINE](#line)
23. [Zalo](#zalo)
24. [Twilio](#twilio)
25. [GitHub](#github)
26. [Gmail Watch](#gmail-watch)
27. [Nextcloud Talk](#nextcloud-talk)
28. [Tlon](#tlon)
29. [Lens](#lens)
30. [连接器生命周期](#connector-lifecycle)
31. [多账户支持](#multi-account-support)
32. [会话管理](#session-management)

---

<div id="supported-platforms">
## 支持的平台
</div>

标记为 **Auto** 的连接器在 `eliza.json` 中存在相应配置时会自动加载。标记为 **Registry** 的连接器需要先使用 `eliza plugins install <package>` 进行安装。

| 平台 | 认证方式 | 私聊支持 | 群组支持 | 多账户 | 可用性 |
|----------|------------|------------|---------------|---------------|-------------|
| Discord | Bot token | 是 | 是（服务器/频道） | 是 | Auto |
| Telegram | Bot token | 是 | 是（群组/话题） | 是 | Auto |
| Slack | Bot + App tokens | 是 | 是（频道/线程） | 是 | Auto |
| WhatsApp | 二维码（Baileys）或 Cloud API | 是 | 是 | 是 | Auto |
| Signal | signal-cli HTTP API | 是 | 是 | 是 | Auto |
| iMessage | 原生 CLI（macOS） | 是 | 是 | 是 | Auto |
| BlueBubbles | 服务器密码 | 是 | 是 | 否 | Auto |
| Blooio | API key + webhook | 是 | 是 | 否 | Auto |
| Microsoft Teams | App ID + password | 是 | 是（团队/频道） | 否 | Auto |
| Google Chat | 服务账户 | 是 | 是（空间） | 是 | Auto |
| Twitter | API keys + tokens | 私信 | 不适用 | 否 | Registry |
| Farcaster | Neynar API key + signer | Casts | 是（频道） | 否 | Auto |
| Twitch | Client ID + access token | 是（聊天） | 是（频道） | 否 | Auto |
| Mattermost | Bot token | 是 | 是（频道） | 否 | Auto |
| WeChat | Proxy API key + 二维码 | 是 | 是 | 是 | Registry |
| Matrix | Access token | 是 | 是（房间） | 否 | Auto |
| Feishu / Lark | App ID + secret | 是 | 是（群聊） | 否 | Auto |
| Nostr | 私钥（nsec/hex） | 是（NIP-04） | 不适用 | 否 | Auto |
| Lens | API key | 是 | 不适用 | 否 | Registry |
| Bluesky | 账户凭证 | 帖子 | 不适用 | 否 | Registry |
| Instagram | 用户名 + 密码 | 私信 | 不适用 | 否 | Registry |
| LINE | Channel access token + secret | 是 | 是 | 否 | Registry |
| Zalo | Access token | 是 | 是 | 否 | Registry |
| Twilio | Account SID + auth token | 短信/语音 | 不适用 | 否 | Registry |
| GitHub | API token | Issues/PRs | 是（仓库） | 否 | Registry |
| Gmail Watch | 服务账户 / OAuth | 不适用 | 不适用 | 否 | Registry |
| Nextcloud Talk | 服务器凭证 | 是 | 是（房间） | 否 | Registry |
| Tlon | Ship 凭证 | 是 | 是（Urbit 聊天） | 否 | Registry |

---

<div id="general-configuration">
## 通用配置
</div>

连接器在 `eliza.json` 的 `connectors` 部分进行配置。大多数连接器共享以下通用字段：

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `enabled` | boolean | 启用或禁用连接器 |
| `dmPolicy` | string | 私信接受策略：`"pairing"`（默认）、`"open"` 或 `"closed"` |
| `allowFrom` | string[] | 用户 ID 白名单（当 `dmPolicy: "open"` 时必需） |
| `groupPolicy` | string | 群组消息策略：`"allowlist"`（默认）或 `"open"` |
| `groupAllowFrom` | string[] | 群组 ID 白名单 |
| `historyLimit` | number | 从对话历史中加载的最大消息数 |
| `dmHistoryLimit` | number | 私信历史的最大消息数 |
| `textChunkLimit` | number | 每条消息块的最大字符数 |
| `chunkMode` | string | `"length"` 或 `"newline"` -- 如何分割长消息 |
| `blockStreaming` | boolean | 禁用流式响应 |
| `mediaMaxMb` | number | 最大媒体附件大小（MB） |
| `configWrites` | boolean | 允许代理修改自身配置 |
| `capabilities` | string[] | 此连接器的功能标志 |
| `markdown` | object | Markdown 渲染设置 |
| `heartbeat` | object | 频道心跳可见性设置 |

---

<div id="discord">
## Discord
</div>

<div id="setup-requirements">
### 配置要求
</div>

- Discord bot token（来自 Discord 开发者门户）
- Bot 必须被邀请到目标服务器并拥有适当权限

<div id="key-configuration">
### 关键配置
</div>

```json
{
  "connectors": {
    "discord": {
      "enabled": true,
      "token": "BOT_TOKEN",
      "groupPolicy": "allowlist",
      "guilds": {
        "SERVER_ID": {
          "requireMention": true,
          "channels": {
            "CHANNEL_ID": {
              "allow": true,
              "requireMention": false
            }
          }
        }
      },
      "dm": {
        "enabled": true,
        "policy": "pairing"
      }
    }
  }
}
```

<div id="features">
### 功能特性
</div>

- 按服务器和按频道配置
- 带白名单的私信策略
- 回应通知（`off`、`own`、`all`、`allowlist`）
- 带指定审批用户的执行审批
- PluralKit 集成
- 回复模式配置
- Intent 配置（在线状态、服务器成员）
- 操作：回应、贴纸、表情包上传、投票、权限、消息、线程、置顶、搜索、成员/角色/频道信息、语音状态、事件、管理、在线状态

---

<div id="telegram">
## Telegram
</div>

<div id="setup-requirements-1">
### 配置要求
</div>

- 来自 @BotFather 的 Bot token

<div id="key-configuration-1">
### 关键配置
</div>

```json
{
  "connectors": {
    "telegram": {
      "enabled": true,
      "botToken": "BOT_TOKEN",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groups": {
        "GROUP_ID": {
          "requireMention": true,
          "topics": {
            "TOPIC_ID": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

<div id="features-1">
### 功能特性
</div>

- 按群组和按话题配置
- 带验证的自定义斜杠命令
- 内联按钮（范围：`off`、`dm`、`group`、`all`、`allowlist`）
- Webhook 模式（含 webhook URL、密钥和路径）
- 流模式（`off`、`partial`、`block`）
- 回应通知和回应级别
- 链接预览控制
- 网络配置（自动选择协议族）
- 代理支持

---

<div id="slack">
## Slack
</div>

<div id="setup-requirements-2">
### 配置要求
</div>

- Bot token（`xoxb-...`）
- App token（`xapp-...`）用于 Socket Mode
- Signing secret（用于 HTTP 模式）

<div id="key-configuration-2">
### 关键配置
</div>

```json
{
  "connectors": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>",
      "groupPolicy": "allowlist",
      "channels": {
        "CHANNEL_ID": {
          "allow": true,
          "requireMention": true
        }
      }
    }
  }
}
```

<div id="features-2">
### 功能特性
</div>

- Socket Mode 或 HTTP 模式
- 带白名单的按频道配置
- 线程感知历史记录（线程或频道范围）
- 用户 token 支持（默认只读）
- 斜杠命令集成（带临时响应选项）
- 按聊天类型（直接、群组、频道）的回复模式
- 私信群组频道支持
- 操作：回应、消息、置顶、搜索、权限、成员信息、频道信息、表情列表

---

<div id="whatsapp">
## WhatsApp
</div>

<div id="setup-requirements-3">
### 配置要求
</div>

- Baileys：无需外部凭证（扫描二维码）
- Cloud API：WhatsApp Business API access token 和电话号码 ID

<div id="key-configuration-3">
### 关键配置
</div>

```json
{
  "connectors": {
    "whatsapp": {
      "accounts": {
        "default": {
          "enabled": true,
          "authDir": "./auth/whatsapp"
        }
      },
      "dmPolicy": "pairing",
      "sendReadReceipts": true,
      "debounceMs": 0
    }
  }
}
```

<div id="features-3">
### 功能特性
</div>

- 按账户的认证目录，用于 Baileys 会话持久化
- 自聊天模式，用于测试
- 发出消息的消息前缀
- 确认回应（可配置表情符号、私信/群组行为）
- 快速消息防抖
- 带提及要求的按群组配置
- 操作：回应、发送消息、投票

详细的设置说明请参阅 [WhatsApp 集成指南](/zh/guides/whatsapp)。

---

<div id="signal">
## Signal
</div>

<div id="setup-requirements-4">
### 配置要求
</div>

- 以 HTTP/JSON-RPC 模式运行的 signal-cli
- 已注册的 Signal 账户

<div id="key-configuration-4">
### 关键配置
</div>

```json
{
  "connectors": {
    "signal": {
      "enabled": true,
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="features-4">
### 功能特性
</div>

- HTTP URL 或 host/port 配置
- CLI 路径及可选的自动启动
- 启动超时配置（1-120 秒）
- 接收模式（`on-start` 或 `manual`）
- 附件和动态处理选项
- 已读回执支持
- 回应通知和级别

---

<div id="imessage">
## iMessage
</div>

<div id="setup-requirements-5">
### 配置要求
</div>

- 配置了 iMessage 的 macOS
- 用于 iMessage 访问的 CLI 工具（如 `imessage-exporter`）

<div id="key-configuration-5">
### 关键配置
</div>

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "cliPath": "/usr/local/bin/imessage-exporter",
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

> **自动启用说明：** 当设置了 `cliPath` 时，连接器会自动启用。没有设置时，插件将不会加载。

<div id="features-5">
### 功能特性
</div>

- 服务选择：`imessage`、`sms` 或 `auto`
- CLI 路径和数据库路径配置
- 远程主机支持
- 区域配置
- 附件包含开关
- 按群组的提及和工具配置

---

<div id="bluebubbles">
## BlueBubbles
</div>

通过在 macOS 上运行的本地 [BlueBubbles](https://bluebubbles.app) 服务器连接到 iMessage。与直接 iMessage 连接器不同，BlueBubbles 可通过网络访问 — 代理无需在运行 iMessage 的同一台 Mac 上运行。

### 设置要求

- 一台已登录 iMessage 并安装了 [BlueBubbles 服务器](https://bluebubbles.app) 的 Mac
- 服务器密码和从运行 Eliza 的机器可访问的 URL

### 关键配置

```json
{
  "connectors": {
    "bluebubbles": {
      "password": "你的_BLUEBUBBLES_密码",
      "serverUrl": "http://192.168.1.50:1234"
    }
  }
}
```

**环境变量：** `BLUEBUBBLES_PASSWORD`、`BLUEBUBBLES_SERVER_URL`

### 功能

- 通过本地 BlueBubbles 服务器发送和接收 iMessage 和 SMS
- Tapback 反应（添加和移除）
- 回复线程中的特定消息
- 编辑和撤回已发送的消息（取决于 macOS 版本）
- 发送带标题和 iMessage 效果的附件
- 群聊参与者管理
- 已读回执支持
- 基于 webhook 的入站消息处理

请参阅 [BlueBubbles 连接器参考](/connectors/bluebubbles) 获取完整配置参考。

---

<div id="blooio">
## Blooio
</div>

通过 Blooio 服务连接到 iMessage 和短信消息，使用签名 webhook。

<div id="setup-requirements-6">
### 配置要求
</div>

- Blooio API key
- 用于接收消息的 Webhook URL

<div id="key-configuration-6">
### 关键配置
</div>

```json
{
  "connectors": {
    "blooio": {
      "enabled": true,
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "webhookUrl": "https://your-domain.com/blooio/webhook"
    }
  }
}
```

**环境变量：** `BLOOIO_API_KEY`、`BLOOIO_WEBHOOK_URL`

<div id="features-6">
### 功能特性
</div>

- 通过 Blooio 桥接的 iMessage 和短信消息
- 入站消息的签名 webhook 验证
- 出站消息发送
- 配置了 `apiKey` 时自动启用

---

<div id="microsoft-teams">
## Microsoft Teams
</div>

<div id="setup-requirements-7">
### 配置要求
</div>

- Azure Bot 注册（App ID 和 App Password）
- Tenant ID

<div id="key-configuration-7">
### 关键配置
</div>

```json
{
  "connectors": {
    "msteams": {
      "enabled": true,
      "botToken": "APP_PASSWORD",
      "appId": "APP_ID",
      "appPassword": "APP_PASSWORD",
      "tenantId": "TENANT_ID",
      "dmPolicy": "pairing"
    }
  }
}
```

> **自动启用说明：** 当配置中存在 `botToken`、`token` 或 `apiKey` 时，连接器会自动启用。将 `botToken` 设置为 app password 以触发自动启用。

<div id="features-7">
### 功能特性
</div>

- 按团队和按频道配置
- 回复样式配置
- Webhook 端口和路径设置
- 媒体主机白名单（用于下载和认证）
- 群聊文件上传的 SharePoint site ID
- 最大 100MB 媒体支持（OneDrive 上传）

---

<div id="google-chat">
## Google Chat
</div>

<div id="setup-requirements-8">
### 配置要求
</div>

- 具有 Chat API 访问权限的 Google Cloud 服务账户
- 服务账户 JSON 密钥文件或内联配置

<div id="key-configuration-8">
### 关键配置
</div>

```json
{
  "connectors": {
    "googlechat": {
      "enabled": true,
      "apiKey": "placeholder",
      "serviceAccountFile": "./service-account.json",
      "audienceType": "project-number",
      "audience": "123456789",
      "webhookPath": "/google-chat"
    }
  }
}
```

> **自动启用说明：** Google Chat 使用服务账户认证，而非传统 API key。包含 `"apiKey": "placeholder"` 以触发自动启用 — 实际认证使用服务账户文件。

<div id="features-8">
### 功能特性
</div>

- 服务账户认证（文件路径或内联 JSON）
- Audience 类型配置（`app-url` 或 `project-number`）
- Webhook 路径和 URL 配置
- 带提及要求的按群组配置
- 输入指示器模式（`none`、`message`、`reaction`）
- 支持群聊的私信策略

---

<div id="twitter">
## Twitter
</div>

<div id="setup-requirements-9">
### 配置要求
</div>

- Twitter API v2 凭证（API key、API secret key、access token、access token secret）

<div id="key-configuration-9">
### 关键配置
</div>

```json
{
  "connectors": {
    "twitter": {
      "enabled": true,
      "apiKey": "...",
      "apiSecretKey": "...",
      "accessToken": "...",
      "accessTokenSecret": "...",
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

<div id="features-9">
### 功能特性
</div>

- 可配置间隔和变化量的自动发帖
- 立即发帖选项
- 搜索和提及监控
- 时间线算法选择（`weighted` 或 `latest`）
- 自动回复提及
- 操作处理开关
- 用于测试的模拟运行模式
- 可配置最大推文长度（默认：4000）

---

<div id="farcaster">
## Farcaster
</div>

<div id="setup-requirements-10">
### 配置要求
</div>

- Neynar API key（来自 [neynar.com](https://neynar.com)）
- 拥有 Neynar signer UUID 的 Farcaster 账户
- 代理账户的 Farcaster ID（FID）

<div id="key-configuration-10">
### 关键配置
</div>

```json
{
  "connectors": {
    "farcaster": {
      "enabled": true,
      "apiKey": "YOUR_NEYNAR_API_KEY",
      "signerUuid": "YOUR_SIGNER_UUID",
      "fid": 12345,
      "channels": ["ai", "agents"],
      "castIntervalMin": 120,
      "castIntervalMax": 240
    }
  }
}
```

<div id="features-10">
### 功能特性
</div>

- 可配置间隔的自主发布（casting）
- 回复 @提及和 cast 回复
- 频道监控和参与
- 回应（点赞和转发）
- 直接 casts（私信）
- 绑定以太坊地址的链上身份
- 超过 320 字符的消息自动 cast 线程分割

---

<div id="bluesky">
## Bluesky
</div>

<div id="setup-requirements-11">
### 配置要求
</div>

- Bluesky 账户凭证（handle 和 app password）

<div id="key-configuration-11">
### 关键配置
</div>

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true,
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

**环境变量：** `BLUESKY_ENABLED`、`BLUESKY_DRY_RUN`、`BLUESKY_USERNAME`、`BLUESKY_PASSWORD`、`BLUESKY_HANDLE`

<div id="features-11">
### 功能特性
</div>

- 可配置间隔的帖子创建
- 提及和回复监控
- 用于测试的模拟运行模式
- 基于 AT Protocol 的去中心化社交网络

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-bluesky` 安装。

---

<div id="instagram">
## Instagram
</div>

<div id="setup-requirements-12">
### 配置要求
</div>

- Instagram 账户凭证（用户名和密码）

<div id="key-configuration-12">
### 关键配置
</div>

```json
{
  "connectors": {
    "instagram": {
      "enabled": true
    }
  }
}
```

**环境变量：** `INSTAGRAM_USERNAME`、`INSTAGRAM_PASSWORD`、`INSTAGRAM_DRY_RUN`、`INSTAGRAM_POLL_INTERVAL`、`INSTAGRAM_POST_INTERVAL_MIN`、`INSTAGRAM_POST_INTERVAL_MAX`

<div id="features-12">
### 功能特性
</div>

- 带描述文字生成的媒体发布
- 评论监控和回复
- 私信处理
- 用于测试的模拟运行模式
- 可配置的发布和轮询间隔

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-instagram` 安装。

---

<div id="twitch">
## Twitch
</div>

<div id="setup-requirements-13">
### 配置要求
</div>

- Twitch 应用 Client ID 和 access token
- 要连接的 Twitch 频道

<div id="key-configuration-13">
### 关键配置
</div>

```json
{
  "connectors": {
    "twitch": {
      "enabled": true,
      "clientId": "YOUR_CLIENT_ID",
      "accessToken": "YOUR_ACCESS_TOKEN"
    }
  }
}
```

<div id="features-13">
### 功能特性
</div>

- 实时聊天监控和回复
- 频道事件处理
- 观众互动管理
- 配置了 `clientId` 或 `accessToken` 时自动启用

---

<div id="mattermost">
## Mattermost
</div>

<div id="setup-requirements-14">
### 配置要求
</div>

- Mattermost bot token（来自系统控制台 > 集成 > Bot 账户）
- Mattermost 服务器 URL

<div id="key-configuration-14">
### 关键配置
</div>

```json
{
  "connectors": {
    "mattermost": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "baseUrl": "https://chat.example.com",
      "chatmode": "all",
      "requireMention": false
    }
  }
}
```

**环境变量：** `MATTERMOST_BOT_TOKEN`、`MATTERMOST_SERVER_URL`

<div id="features-14">
### 功能特性
</div>

- 频道和私信消息
- 聊天模式限制（`dm-only`、`channel-only` 或 `all`）
- 提及过滤（可选择要求 @提及）
- 自定义命令前缀触发器
- 自托管服务器支持

---

<div id="wechat">
## WeChat
</div>

通过第三方代理服务使用个人账户登录连接到微信。

<div id="setup-requirements-15">
### 配置要求
</div>

1. 从微信代理服务获取 API key
2. 配置代理 URL 和 webhook 端口
3. 首次启动时扫描终端中显示的二维码

<div id="privacy-notice">
### 隐私声明
</div>

微信连接器依赖于用户提供的代理服务。该代理会接收你的连接器 API key 以及转发微信入站和出站流量所需的消息负载和元数据。请仅将 `proxyUrl` 指向你自己运营或明确信任的基础设施。

<div id="key-configuration-15">
### 关键配置
</div>

```json
{
  "connectors": {
    "wechat": {
      "apiKey": "<key>",
      "proxyUrl": "https://...",
      "webhookPort": 18790,
      "deviceType": "ipad"
    }
  }
}
```

| 字段 | 描述 |
|-------|------------|
| `apiKey` | **必需** -- 代理服务 API key |
| `proxyUrl` | **必需** -- 代理服务 URL |
| `webhookPort` | Webhook 监听端口（默认：18790） |
| `deviceType` | 设备模拟类型：`ipad` 或 `mac`（默认：`ipad`） |

**环境变量：** `WECHAT_API_KEY`

**多账户：** 通过 `accounts` 映射支持（与 WhatsApp 相同的模式）。

<div id="features-15">
### 功能特性
</div>

- 私信文本消息（默认启用）
- 群聊支持（使用 `features.groups: true` 启用）
- 图片发送/接收（使用 `features.images: true` 启用）
- 二维码登录及自动会话持久化
- 通过 accounts 映射的多账户支持

---

<div id="matrix">
## Matrix
</div>

<div id="setup-requirements-16">
### 配置要求
</div>

- 任意 homeserver 上的 Matrix 账户（如 matrix.org 或自托管）
- Bot 账户的 access token

<div id="key-configuration-16">
### 关键配置
</div>

```json
{
  "env": {
    "MATRIX_ACCESS_TOKEN": "syt_your_access_token"
  },
  "connectors": {
    "matrix": {
      "enabled": true,
      "token": "syt_your_access_token"
    }
  }
}
```

> **自动启用说明：** 当连接器配置中存在 `token`、`botToken` 或 `apiKey` 时，连接器会自动启用。仅设置 `"enabled": true` 是不够的 — 需要包含 `token` 字段。

**环境变量：** `MATRIX_ACCESS_TOKEN`、`MATRIX_HOMESERVER`、`MATRIX_USER_ID`、`MATRIX_DEVICE_ID`、`MATRIX_ROOMS`、`MATRIX_AUTO_JOIN`、`MATRIX_ENCRYPTION`、`MATRIX_REQUIRE_MENTION`

<div id="features-16">
### 功能特性
</div>

- 在任何符合规范的 homeserver 上进行房间和私信消息
- 收到房间邀请时自动加入
- 端到端加密（Olm）支持
- 房间中的提及过滤
- 跨 homeserver 的联邦支持

---

<div id="feishu--lark">
## Feishu / Lark
</div>

<div id="setup-requirements-17">
### 配置要求
</div>

- 具有 App ID 和 App Secret 的飞书/Lark 自定义应用
- 应用上启用了 Bot 功能

<div id="key-configuration-17">
### 关键配置
</div>

```json
{
  "env": {
    "FEISHU_APP_ID": "cli_your_app_id",
    "FEISHU_APP_SECRET": "your_app_secret"
  },
  "connectors": {
    "feishu": {
      "enabled": true,
      "apiKey": "your_app_secret"
    }
  }
}
```

> **自动启用说明：** 当连接器配置中存在 `apiKey`、`token` 或 `botToken` 时，连接器会自动启用。将 `apiKey` 设置为 app secret 以触发自动启用。

**环境变量：** `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DOMAIN`、`FEISHU_ALLOWED_CHATS`

<div id="features-17">
### 功能特性
</div>

- 直接 bot 消息和群聊
- 聊天白名单用于访问控制
- 中国（`feishu.cn`）和全球（`larksuite.com`）域名支持
- 事件订阅用于实时消息

---

<div id="nostr">
## Nostr
</div>

<div id="setup-requirements-18">
### 配置要求
</div>

- Nostr 私钥（nsec 或 hex 格式）

<div id="key-configuration-18">
### 关键配置
</div>

```json
{
  "env": {
    "NOSTR_PRIVATE_KEY": "nsec1your_private_key"
  },
  "connectors": {
    "nostr": {
      "enabled": true,
      "token": "placeholder"
    }
  }
}
```

> **自动启用说明：** Nostr 使用基于密钥的认证，而非传统 token。在连接器配置中包含 `"token": "placeholder"` 以触发自动启用 — 实际认证使用 `NOSTR_PRIVATE_KEY` 环境变量。

**环境变量：** `NOSTR_PRIVATE_KEY`、`NOSTR_RELAYS`、`NOSTR_DM_POLICY`、`NOSTR_ALLOW_FROM`、`NOSTR_ENABLED`

<div id="features-18">
### 功能特性
</div>

- 多中继连接
- Note 发布（kind 1 事件）
- NIP-04 加密私信
- 私信访问策略（allow、deny、allowlist）
- 通过中继网络实现完全去中心化

---

<div id="line">
## LINE
</div>

<div id="setup-requirements-19">
### 配置要求
</div>

- LINE Channel access token
- LINE Channel secret

<div id="key-configuration-19">
### 关键配置
</div>

```json
{
  "connectors": {
    "line": {
      "enabled": true
    }
  }
}
```

**环境变量：** `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_CUSTOM_GREETING`

<div id="features-19">
### 功能特性
</div>

- Bot 消息和客户对话
- 丰富消息类型（文本、贴纸、图片、视频）
- 群聊支持
- 基于 Webhook 的事件处理

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-line` 安装。

---

<div id="zalo">
## Zalo
</div>

<div id="setup-requirements-20">
### 配置要求
</div>

- Zalo Official Account (OA) access token

<div id="key-configuration-20">
### 关键配置
</div>

```json
{
  "connectors": {
    "zalo": {
      "enabled": true
    }
  }
}
```

**环境变量：** `ZALO_ACCESS_TOKEN`、`ZALO_REFRESH_TOKEN`、`ZALO_APP_ID`、`ZALO_APP_SECRET`

<div id="features-20">
### 功能特性
</div>

- 官方账户消息和支持工作流
- 基于 Webhook 的消息处理
- 客户互动管理

个人账户变体也可作为 `@elizaos/plugin-zalouser` 使用，用于在官方账户系统之外的一对一消息。

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-zalo` 安装。

---

<div id="twilio">
## Twilio
</div>

<div id="setup-requirements-21">
### 配置要求
</div>

- Twilio Account SID 和 Auth Token
- 一个 Twilio 电话号码

<div id="key-configuration-21">
### 关键配置
</div>

```json
{
  "connectors": {
    "twilio": {
      "enabled": true
    }
  }
}
```

**环境变量：** `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`、`TWILIO_PHONE_NUMBER`

<div id="features-21">
### 功能特性
</div>

- 短信消息（发送和接收）
- 语音通话功能
- 基于 Webhook 的入站消息处理

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-twilio` 安装。

---

<div id="github">
## GitHub
</div>

<div id="setup-requirements-22">
### 配置要求
</div>

- GitHub API token（个人访问令牌或细粒度令牌）

<div id="key-configuration-22">
### 关键配置
</div>

```json
{
  "connectors": {
    "github": {
      "enabled": true
    }
  }
}
```

**环境变量：** `GITHUB_API_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO`

<div id="features-22">
### 功能特性
</div>

- 仓库管理
- Issue 追踪和创建
- Pull request 工作流（创建、审查、合并）
- 代码搜索和文件访问

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-github` 安装。

---

<div id="gmail-watch">
## Gmail Watch
</div>

<div id="setup-requirements-23">
### 配置要求
</div>

- 具有 Gmail API 访问权限的 Google Cloud 服务账户或 OAuth 凭证

<div id="key-configuration-23">
### 关键配置
</div>

Gmail Watch 通过 `features.gmailWatch` 标志或环境变量启用，而非 `connectors` 部分。

<div id="features-23">
### 功能特性
</div>

- Gmail Pub/Sub 消息监听
- 监听订阅的自动续期
- 入站邮件事件处理

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-gmail-watch` 安装。

---

<div id="nextcloud-talk">
## Nextcloud Talk
</div>

<div id="setup-requirements-24">
### 配置要求
</div>

- Nextcloud 服务器 URL 和凭证

<div id="key-configuration-24">
### 关键配置
</div>

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="features-24">
### 功能特性
</div>

- 基于房间的消息
- 私信和群组对话支持
- 自托管协作平台集成

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-nextcloud-talk` 安装。

---

<div id="tlon">
## Tlon
</div>

<div id="setup-requirements-25">
### 配置要求
</div>

- Tlon ship 凭证（Urbit ship 名称和访问代码）

<div id="key-configuration-25">
### 关键配置
</div>

```json
{
  "connectors": {
    "tlon": {
      "enabled": true
    }
  }
}
```

**环境变量：** `TLON_SHIP`、`TLON_CODE`、`TLON_URL`

<div id="features-25">
### 功能特性
</div>

- 基于 Urbit 的聊天和社交互动
- Ship 间消息传递
- 群聊参与

**注意：** 此连接器可从插件注册表获取。使用 `eliza plugins install @elizaos/plugin-tlon` 安装。

---

<div id="lens">
## Lens
</div>

**插件：** `@elizaos/plugin-lens`

```json5
{
  connectors: {
    lens: {
      apiKey: "<LENS_API_KEY>",
    }
  }
}
```

| 环境变量 | 配置路径 |
|-------------|-------------|
| `LENS_API_KEY` | `connectors.lens.apiKey` |

**自动启用触发器：** `apiKey`、`token` 或 `botToken`。

**功能特性：**
- Lens Protocol 社交互动
- 帖子发布和互动

---

<div id="connector-lifecycle">
## 连接器生命周期
</div>

典型的连接器生命周期遵循以下模式：

1. **安装插件** -- 连接器插件以 `@elizaos/plugin-{platform}` 包的形式安装
2. **配置** -- 将平台配置添加到 `eliza.json` 的 `connectors` 部分
3. **启用** -- 在连接器配置中设置 `enabled: true`
4. **认证** -- 提供凭证（token、密钥）或完成认证流程（扫描二维码）
5. **运行** -- 运行时启动连接器、建立连接并开始消息处理
6. **监控** -- 状态探测验证连接性；失败时自动重连

---

<div id="multi-account-support">
## 多账户支持
</div>

大多数连接器通过 `accounts` 键支持多账户。每个账户有自己的配置、认证和会话状态：

```json
{
  "connectors": {
    "telegram": {
      "dmPolicy": "pairing",
      "accounts": {
        "main-bot": {
          "enabled": true,
          "botToken": "TOKEN_1"
        },
        "support-bot": {
          "enabled": true,
          "botToken": "TOKEN_2",
          "dmPolicy": "open",
          "allowFrom": ["*"]
        }
      }
    }
  }
}
```

账户级别的设置会覆盖基础连接器设置。每个账户使用自己的连接、凭证和会话状态独立运行。

---

<div id="session-management">
## 会话管理
</div>

所有连接器管理跨平台跟踪对话状态的会话：

- **私信会话** -- 每个用户一个会话，由 `dmPolicy` 控制
- **群组会话** -- 每个群组/频道一个会话，由 `groupPolicy` 控制
- **历史记录** -- 每种会话类型的可配置消息历史深度（`historyLimit`、`dmHistoryLimit`）
- **私信配置** -- 通过 `dms` 记录的按用户私信覆盖

`dmPolicy` 选项如下：

| 策略 | 行为 |
|--------|----------|
| `pairing` | 默认。代理在配对/引导流程后响应。 |
| `open` | 代理响应所有私信。需要 `allowFrom: ["*"]`。 |
| `closed` | 代理不响应私信。 |

---

<div id="connector-operations-runbook">
## 连接器运维手册
</div>

<div id="setup-checklist">
### 设置清单
</div>

1. 在 `connectors.<name>` 下配置连接器凭证。
2. 通过连接器配置或插件白名单启用连接器插件加载。
3. 在启用 `open` 策略之前，验证私信/群组策略值和白名单。
4. 对于每个连接器，确认平台 bot/应用已创建且 token 有效（请参阅下面的平台特定说明）。
5. 在切换到 `open` 模式之前，先在 `pairing` 模式下测试连接性。

<div id="failure-modes">
### 故障模式
</div>

**通用连接器故障：**

- 连接器插件未加载：
  检查 `eliza/packages/agent/src/config/plugin-auto-enable.ts`（在上游 elizaOS 子模块中）中的连接器 ID 映射、插件可用性以及 `plugins.entries` 覆盖。自动启用层将连接器配置键映射到插件包名 — 不匹配意味着插件被静默跳过。
- 认证成功但没有消息到达：
  检查平台 webhook/socket 设置和策略门控（`dmPolicy`、`groupPolicy`）。对于基于 webhook 的连接器，确认回调 URL 可公开访问。
- 连接器密钥路由错误：
  确认预期的环境变量从配置中填充且未被过期的环境变量覆盖。配置模式将环境变量与文件配置合并 — 环境变量优先。

**Discord：**

- Bot token 被拒绝（`401 Unauthorized`）：
  在 Discord 开发者门户中重新生成 bot token。当 bot 的密码被重置或 token 泄露并被自动撤销时，token 会失效。
- Bot 在线但不在频道中回复：
  检查 bot 是否在开发者门户中启用了 `MESSAGE_CONTENT` intent，以及 `groupPolicy` 是否不是 `closed`。确认 bot 在目标频道中有 `Send Messages` 权限。
- 被限流（`429 Too Many Requests`）：
  Discord 限流是按路由的。连接器应自动退避。如果持续发生，请减少消息频率或检查消息循环（bot 回复自己）。

**Telegram：**

- Webhook 未接收更新：
  Telegram 需要具有有效证书的 HTTPS。使用 `getWebhookInfo` 检查状态。如果使用长轮询，确认没有其他进程在轮询同一 bot token（Telegram 只允许一个消费者）。
- Bot token 过期或被撤销：
  通过 BotFather 重新创建 bot 并更新 `TELEGRAM_BOT_TOKEN`。Telegram token 不会自动过期，但可以被撤销。
- 消息延迟或丢失：
  如果 webhook 不可达，Telegram 会缓冲更新最多 24 小时。恢复连接后，可能会收到一批积压的消息。

**Slack：**

- `invalid_auth` 或 `token_revoked`：
  重新将 Slack 应用安装到工作区。当应用被卸载或工作区权限更改时，Bot token 会被撤销。
- 事件未到达：
  确认 Events API 订阅包含所需的事件类型（`message.im`、`message.channels`）。检查 Slack 应用的 Request URL 是否已验证并正在接收质询响应。

**WhatsApp：**

- 二维码配对失败或会话断开：
  WhatsApp Web 会话在长时间不活动后会过期。通过 `POST /api/whatsapp/pair` 扫描新二维码重新配对。`whatsapp-pairing` 服务管理会话状态。
- 消息未送达：
  WhatsApp 执行严格的反垃圾信息策略。如果号码被标记，消息会被静默丢弃。确认商业账户处于良好状态。
- 多账户认证目录问题：
  每个 WhatsApp 账户需要自己的 `authDir`（Baileys 多文件认证状态）。如果多个账户共享目录，会话会互相损坏。

**Signal：**

- Signal CLI 未找到：
  连接器需要 PATH 中的 `signal-cli` 或配置的 `cliPath`。对于 HTTP 模式，设置 `httpUrl` 或 `httpHost`/`httpPort` 指向运行中的 signal-cli REST API。
- 账户注册失败：
  Signal 需要已验证的电话号码。使用 `signal-cli register` 或通过 `connectors.signal.account` 提供预注册的账户号码。
- 多账户配置：
  Signal 通过 `accounts` 映射支持多账户。每个账户必须设置 `account`、`httpUrl` 或 `cliPath`，且不能为 `enabled: false`。

**Twitter：**

- API key 被拒绝：
  确认 `connectors.twitter.apiKey` 是有效的 Twitter/X API key。免费层密钥有严格的速率限制。
- 推文获取失败：
  FxTwitter API（`api.fxtwitter.com`）用于推文验证。如果被限流，验证请求会静默失败。

**iMessage（直接）：**

- CLI 路径未找到：
  需要 `cliPath` 指向有效的 iMessage CLI 工具。仅限 macOS — 需要辅助功能权限。

**Farcaster：**

- API key 无效：
  确认 `connectors.farcaster.apiKey` 已设置。Farcaster hub 访问需要有效的 API key。

**Lens：**

- API key 无效：
  确认 `connectors.lens.apiKey` 已设置且 Lens API 可达。

**MS Teams：**

- Bot token 被拒绝：
  Teams bot 需要 Azure AD 注册。确认 bot token 有效且应用在 Azure 门户中具有所需权限。

**Mattermost：**

- Token 认证失败：
  确认 `connectors.mattermost.botToken`（环境变量：`MATTERMOST_BOT_TOKEN`）是有效的个人访问令牌或 bot token。检查 Mattermost 服务器 URL 是否已配置。

**Google Chat / Feishu：**

- Token 认证失败：
  两者都需要服务账户或 bot token。确认 token 有效且具有所需的 chat API 范围。

**Matrix：**

- Homeserver 连接失败：
  确认 Matrix homeserver URL 可达且 `connectors.matrix.token` 下的 access token 有效。

**Nostr：**

- 中继连接失败：
  Nostr 连接器通过中继通信。确认中继 URL 已配置且可达。API key 认证因中继而异。

**Twitch：**

- 认证失败：
  确认 `connectors.twitch.accessToken` 或 `connectors.twitch.clientId` 已设置。或者设置 `enabled: true` 强制启用。确保 access token 具有所需的聊天范围。

**Blooio：**

- 认证失败：
  Blooio 使用 `apiKey`。确认凭证在连接器配置下已设置。

**Bluesky：**

- 认证失败：
  确认 `BLUESKY_USERNAME` 和 `BLUESKY_PASSWORD` 环境变量已设置。Bluesky 使用 app password，而非你的主账户密码。

**Instagram：**

- 登录失败或账户被锁定：
  Instagram 可能需要对自动登录进行验证。如果可用，请使用应用专用密码。避免频繁的登录尝试，这可能会触发账户锁定。

**LINE：**

- Webhook 未接收消息：
  确认 `LINE_CHANNEL_ACCESS_TOKEN` 和 `LINE_CHANNEL_SECRET` 已设置。Webhook URL 必须是可公开访问的 HTTPS。

**Twilio：**

- 短信未发送：
  确认 `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN` 和 `TWILIO_PHONE_NUMBER` 已设置。检查电话号码是否支持短信功能且账户余额充足。

**GitHub：**

- API token 被拒绝：
  确认 `GITHUB_API_TOKEN` 是具有所需仓库权限的有效个人访问令牌或细粒度令牌。

<div id="recovery-procedures">
### 恢复流程
</div>

1. **过期的连接器会话：** 重启代理。连接器在启动时重新初始化其平台连接。对于基于 WebSocket 的连接器（Discord、Slack），这会强制进行新的握手。
2. **Token 轮换：** 在 `eliza.json` 的 `connectors.<name>` 下更新 token 并重启。不要在运行的进程中编辑环境变量 — 配置在启动时读取。
3. **限流恢复：** 代理在收到 429 响应时自动退避。如果连接器被完全阻止，等待限流窗口过期（Discord 通常为 1–60 秒，因平台而异）然后重启。

<div id="verification-commands">
### 验证命令
</div>

这些测试路径引用了 `eliza` 子模块中的文件。请先运行 `bun run setup:upstreams` 进行初始化。

```bash
# 完整测试套件（从仓库根目录）
bun run test

# 端到端测试
bun run test:e2e

bun run typecheck
```
