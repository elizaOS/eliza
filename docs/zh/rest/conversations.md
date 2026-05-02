---
title: "对话 API"
sidebarTitle: "对话"
description: "用于管理网页聊天对话的 REST API 端点 — CRUD、消息传递和流式传输。"
---

对话 API 管理代理的网页聊天界面。每个对话在运行时的内存系统中拥有独立的房间，从而支持独立的消息历史记录。该 API 同时支持流式传输（SSE）和同步消息投递。

<div id="endpoints">

## 端点

</div>

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/conversations` | 列出所有对话 |
| POST | `/api/conversations` | 创建新对话 |
| GET | `/api/conversations/:id/messages` | 获取对话的消息 |
| POST | `/api/conversations/:id/messages` | 发送消息（同步） |
| POST | `/api/conversations/:id/messages/stream` | 发送消息（SSE 流式传输） |
| POST | `/api/conversations/:id/greeting` | 生成问候消息 |
| PATCH | `/api/conversations/:id` | 更新对话元数据 |
| DELETE | `/api/conversations/:id` | 删除对话 |

---

<div id="get-apiconversations">

### GET /api/conversations

</div>

列出所有对话，按最近更新时间排序。

**响应**

```json
{
  "conversations": [
    {
      "id": "uuid",
      "title": "Morning Chat",
      "roomId": "uuid",
      "createdAt": "2025-06-01T10:00:00.000Z",
      "updatedAt": "2025-06-01T12:30:00.000Z"
    }
  ]
}
```

---

<div id="post-apiconversations">

### POST /api/conversations

</div>

创建一个拥有独立房间的新对话。

**请求体**

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `title` | string | 否 | 对话标题（默认值 `"New Chat"`） |

**响应**

```json
{
  "conversation": {
    "id": "uuid",
    "title": "New Chat",
    "roomId": "uuid",
    "createdAt": "2025-06-01T12:00:00.000Z",
    "updatedAt": "2025-06-01T12:00:00.000Z"
  }
}
```

---

<div id="get-apiconversationsidmessages">

### GET /api/conversations/:id/messages

</div>

检索对话中最多 200 条消息，按时间从旧到新排序。文本内容为空的消息（如操作日志记忆）会被自动过滤。

**响应**

```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "text": "Hello!",
      "timestamp": 1718000000000
    },
    {
      "id": "uuid",
      "role": "assistant",
      "text": "Hey there! How can I help?",
      "timestamp": 1718000001000
    },
    {
      "id": "uuid",
      "role": "user",
      "text": "What's going on in Discord?",
      "timestamp": 1718000002000,
      "source": "discord",
      "from": "Alice",
      "fromUserName": "alice#1234",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  ]
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `messages[].role` | string | `user` 或 `assistant` |
| `messages[].text` | string | 消息文本内容 |
| `messages[].timestamp` | number | 消息创建时的 Unix 时间戳（毫秒） |
| `messages[].source` | string\|undefined | 连接器来源标识符（例如 `discord`、`telegram`）。网页聊天消息中省略 |
| `messages[].from` | string\|undefined | 发送实体的显示名称（如果可用） |
| `messages[].fromUserName` | string\|undefined | 发送者的用户名或句柄（例如 Discord 用户名），当连接器提供时显示 |
| `messages[].avatarUrl` | string\|undefined | 当连接器可以提供时的发送者头像 URL |

**错误**

| 状态码 | 条件 |
|--------|------|
| 404 | 对话未找到 |

---

<div id="post-apiconversationsidmessages">

### POST /api/conversations/:id/messages

</div>

发送消息并同步获取代理的响应（非流式传输）。

**请求体**

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `text` | string | 是 | 用户消息文本 |
| `channelType` | string | 否 | 频道类型覆盖 |
| `images` | array | 否 | 附加的图片数据 |

**响应**

```json
{
  "text": "Here's what I think...",
  "agentName": "Eliza"
}
```

**错误**

| 状态码 | 条件 |
|--------|------|
| 404 | 对话未找到 |
| 503 | 代理未运行 |

---

<div id="post-apiconversationsidmessagesstream">

### POST /api/conversations/:id/messages/stream

</div>

发送消息并通过 Server-Sent Events（SSE）接收代理的响应。每个 token 在生成时实时传输，最后跟随一个 `done` 事件。

**请求体**

与 `POST /api/conversations/:id/messages` 相同。

**SSE 事件**

Token 事件（追加语义 — 每个文本片段扩展回复内容）：
```
data: {"type":"token","text":"Here's"}
data: {"type":"token","text":" what"}
data: {"type":"token","text":" I think..."}
```

快照事件（替换语义 — 当操作回调就地更新回复时使用）：
```
data: {"type":"token","fullText":"Here's what I think...\n\nSearching for track..."}
```

当 `fullText` 字段存在时，它具有权威性，客户端应替换整个助手消息文本，而不是追加。

最终事件：
```
data: {"type":"done","fullText":"Here's what I think...","agentName":"Eliza"}
```

如果对话标题仍为 `"New Chat"`，系统会在后台自动生成标题，并广播一个 `conversation-updated` WebSocket 事件。如果 AI 标题生成失败，标题将回退为用户消息的前五个词。

<Info>
操作回调（例如音乐播放、钱包流程）使用**替换**语义：每个后续回调替换消息中的回调部分，而不是追加。这与 Discord 和 Telegram 上使用的渐进式消息模式一致。详情请参阅[操作回调和 SSE 流式传输](/zh/runtime/action-callback-streaming)。
</Info>

---

<div id="post-apiconversationsidgreeting">

### POST /api/conversations/:id/greeting

</div>

为新对话生成问候消息。从代理的角色定义中随机选择一个 `postExample` — 无需模型调用，无延迟。问候消息作为代理消息存储以实现持久化。

**响应**

```json
{
  "text": "gm. ready to go viral today or what.",
  "agentName": "Eliza",
  "generated": true
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `text` | string | 问候文本（如果没有发布示例则为空） |
| `agentName` | string | 代理的显示名称 |
| `generated` | boolean | 如果有可用的发布示例则为 `true` |

---

<div id="patch-apiconversationsid">

### PATCH /api/conversations/:id

</div>

更新对话元数据（目前支持重命名）。

**请求体**

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `title` | string | 否 | 新的对话标题 |

**响应**

```json
{
  "conversation": {
    "id": "uuid",
    "title": "Updated Title",
    "roomId": "uuid",
    "createdAt": "2025-06-01T10:00:00.000Z",
    "updatedAt": "2025-06-01T14:00:00.000Z"
  }
}
```

**错误**

| 状态码 | 条件 |
|--------|------|
| 404 | 对话未找到 |

---

<div id="delete-apiconversationsid">

### DELETE /api/conversations/:id

</div>

删除对话。消息保留在运行时内存中，但对话元数据将被移除。

**响应**

```json
{
  "ok": true
}
```


<div id="common-error-codes">

## 常见错误代码

</div>

| 状态码 | 代码 | 描述 |
|--------|------|------|
| 400 | `INVALID_REQUEST` | 请求体格式错误或缺少必填字段 |
| 401 | `UNAUTHORIZED` | 缺少或无效的身份验证令牌 |
| 404 | `NOT_FOUND` | 请求的资源不存在 |
| 404 | `CONVERSATION_NOT_FOUND` | 指定 ID 的对话不存在 |
| 503 | `SERVICE_UNAVAILABLE` | 代理服务当前未运行 |
| 500 | `INTERNAL_ERROR` | 意外的服务器错误 |
