---
title: "收件箱 API"
sidebarTitle: "收件箱"
description: "统一跨渠道收件箱的 REST API 端点 — 聚合消息、聊天线程和来源发现。"
---

收件箱 API 提供了一个只读的、按时间排序的视图，展示代理参与的所有连接器渠道的消息 — iMessage、Telegram、Discord、WhatsApp、WeChat、Slack、Signal 和 SMS — 合并到单个信息流中。仪表板网页聊天消息被排除在外，因为它们已经可以通过[会话 API](/zh/rest/conversations)访问。

<div id="endpoints">

## 端点

</div>

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/inbox/messages` | 列出所有连接器渠道的最新消息 |
| GET | `/api/inbox/chats` | 列出连接器聊天线程（每个房间一行） |
| GET | `/api/inbox/sources` | 列出不同的连接器来源标签 |

---

<div id="get-apiinboxmessages">

### GET /api/inbox/messages

</div>

列出所有连接器渠道中最新的消息，以统一的、按时间排序的信息流呈现（最新的排在前面）。

**查询参数**

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| `limit` | integer | 否 | 100 | 返回的最大消息数（硬限制 500） |
| `sources` | string | 否 | 所有收件箱来源 | 以逗号分隔的来源过滤器（例如 `discord,telegram`） |
| `roomId` | string | 否 | — | 限定为单个房间 ID，用于线程级视图 |

**响应**

```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "text": "Hey, check this out!",
      "timestamp": 1718000000000,
      "source": "discord",
      "roomId": "room-uuid",
      "from": "Alice",
      "fromUserName": "alice#1234",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  ],
  "count": 1
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `messages[].id` | string | 内存 UUID |
| `messages[].role` | string | `user` 或 `assistant` |
| `messages[].text` | string | 消息文本内容 |
| `messages[].timestamp` | number | 消息创建时的 Unix 时间戳（毫秒） |
| `messages[].source` | string | 连接器来源标签（例如 `imessage`、`telegram`、`discord`） |
| `messages[].roomId` | string | 用于线程分组的外部聊天房间 ID |
| `messages[].from` | string\|undefined | 发送者的显示名称（尽力而为） |
| `messages[].fromUserName` | string\|undefined | 发送者的用户名或句柄（例如 Discord 用户名） |
| `messages[].avatarUrl` | string\|undefined | 当连接器提供时的发送者头像 URL |

对于 Discord 消息，`from`、`fromUserName` 和 `avatarUrl` 在可用时会从实时 Discord 用户资料中补充。

---

<div id="get-apiinboxchats">

### GET /api/inbox/chats

</div>

列出连接器聊天线程 — 每个外部聊天房间一行。供侧边栏使用，在仪表板会话旁边显示统一的聊天列表。

**查询参数**

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| `sources` | string | 否 | 所有收件箱来源 | 以逗号分隔的来源过滤器 |

**响应**

```json
{
  "chats": [
    {
      "id": "room-uuid",
      "source": "discord",
      "title": "#general",
      "lastMessageText": "Hey, check this out!",
      "lastMessageAt": 1718000000000,
      "messageCount": 42
    }
  ],
  "count": 1
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `chats[].id` | string | 房间 ID（在轮询间保持稳定，用作选择键） |
| `chats[].source` | string | 用于徽章渲染的连接器来源标签 |
| `chats[].title` | string | 显示标题 — 频道名称、私信联系人名称，或回退值 `"<source> chat"` |
| `chats[].lastMessageText` | string | 最新消息的预览（截断为 140 个字符） |
| `chats[].lastMessageAt` | number | 最新消息的 epoch 毫秒时间戳 |
| `chats[].messageCount` | number | 扫描时此房间中的消息总数 |

聊天标题按以下优先顺序解析：

1. 实时 Discord 频道名称（从 Discord 客户端获取，适用于 Discord 来源）
2. 已存储的房间名称（在创建房间时由连接器插件设置）
3. 最新发送者名称（适用于私信房间）
4. 回退值：`"<source> chat"`

---

<div id="get-apiinboxsources">

### GET /api/inbox/sources

</div>

列出代理当前拥有消息的不同连接器来源标签集合。使用此端点在界面中构建动态来源过滤器标签，而无需硬编码连接器名称。

**响应**

```json
{
  "sources": ["imessage", "telegram", "discord", "whatsapp"]
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `sources` | string[] | 代理消息历史中存在的不同来源标签数组 |

<div id="supported-sources">

## 支持的来源

</div>

收件箱默认包含来自以下连接器来源的消息：

| 来源标签 | 平台 |
|----------|------|
| `imessage` | iMessage |
| `telegram` | Telegram |
| `discord` | Discord |
| `whatsapp` | WhatsApp |
| `wechat` | WeChat |
| `slack` | Slack |
| `signal` | Signal |
| `sms` | SMS |

来自 `client_chat`（仪表板网页聊天）和内部来源（系统事件、知识摄取）的消息被排除在收件箱信息流之外。

<div id="common-error-codes">

## 常见错误代码

</div>

| 状态 | 代码 | 描述 |
|------|------|------|
| 500 | `INTERNAL_ERROR` | 加载收件箱数据失败 |
