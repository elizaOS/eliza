---
title: "Inbox API"
sidebarTitle: "Inbox"
description: "REST API endpoints for the cross-channel inbox — aggregated messages, chat threads, and source discovery."
---

The inbox API provides a read-only, time-ordered view of messages from every connector channel the agent participates in — iMessage, Telegram, Discord, WhatsApp, WeChat, Slack, Signal, and SMS — merged into a single feed. Dashboard web-chat messages are excluded since they are already accessible via the [conversations API](/rest/conversations).

## Endpoints

| Method | Path                  | Description                                        |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/api/inbox/messages` | List recent messages across all connector channels |
| GET    | `/api/inbox/chats`    | List connector chat threads (one row per room)     |
| GET    | `/api/inbox/sources`  | List distinct connector source tags                |

---

### GET /api/inbox/messages

List the most recent messages across all connector channels in a time-ordered feed (newest first).

**Query parameters**

| Parameter | Type    | Required | Default           | Description                                             |
| --------- | ------- | -------- | ----------------- | ------------------------------------------------------- |
| `limit`   | integer | No       | 100               | Maximum messages to return (hard cap 500)               |
| `sources` | string  | No       | All inbox sources | Comma-separated source filter (e.g. `discord,telegram`) |
| `roomId`  | string  | No       | —                 | Scope to a single room ID for thread-level views        |

**Response**

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

| Field                     | Type              | Description                                                   |
| ------------------------- | ----------------- | ------------------------------------------------------------- |
| `messages[].id`           | string            | Memory UUID                                                   |
| `messages[].role`         | string            | `user` or `assistant`                                         |
| `messages[].text`         | string            | Message text content                                          |
| `messages[].timestamp`    | number            | Unix timestamp (ms) when the message was created              |
| `messages[].source`       | string            | Connector source tag (e.g. `imessage`, `telegram`, `discord`) |
| `messages[].roomId`       | string            | External chat room ID for threading                           |
| `messages[].from`         | string\|undefined | Best-effort display name of the sender entity                 |
| `messages[].fromUserName` | string\|undefined | Username or handle of the sender (e.g. Discord username)      |
| `messages[].avatarUrl`    | string\|undefined | Sender avatar URL when the connector provides one             |

For Discord messages, `from`, `fromUserName`, and `avatarUrl` are enriched from the live Discord user profile when available.

---

### GET /api/inbox/chats

List connector chat threads — one row per external chat room. Used by the sidebar to display a chat list alongside dashboard conversations.

**Query parameters**

| Parameter | Type   | Required | Default           | Description                   |
| --------- | ------ | -------- | ----------------- | ----------------------------- |
| `sources` | string | No       | All inbox sources | Comma-separated source filter |

**Response**

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

| Field                     | Type   | Description                                                                       |
| ------------------------- | ------ | --------------------------------------------------------------------------------- |
| `chats[].id`              | string | Room ID (stable across polls, used as selection key)                              |
| `chats[].source`          | string | Connector source tag for badge rendering                                          |
| `chats[].title`           | string | Display title — channel name, contact name for DMs, or fallback `"<source> chat"` |
| `chats[].lastMessageText` | string | Preview of the most recent message (truncated to 140 characters)                  |
| `chats[].lastMessageAt`   | number | Epoch ms timestamp of the most recent message                                     |
| `chats[].messageCount`    | number | Total messages in this room at scan time                                          |

Chat titles are resolved in the following priority order:

1. Live Discord channel name (fetched from the Discord client for Discord sources)
2. Stored room name (set by the connector plugin when the room was created)
3. Latest sender name (for DM rooms)
4. Fallback: `"<source> chat"`

---

### GET /api/inbox/sources

List the distinct set of connector source tags the agent currently has messages for. Use this to build dynamic source filter chips in the UI without hardcoding connector names.

**Response**

```json
{
  "sources": ["imessage", "telegram", "discord", "whatsapp"]
}
```

| Field     | Type     | Description                                                    |
| --------- | -------- | -------------------------------------------------------------- |
| `sources` | string[] | Array of distinct source tags present in agent message history |

## Supported sources

The inbox includes messages from these connector sources by default:

| Source tag | Platform |
| ---------- | -------- |
| `imessage` | iMessage |
| `telegram` | Telegram |
| `discord`  | Discord  |
| `gmail`    | Gmail    |
| `whatsapp` | WhatsApp |
| `wechat`   | WeChat   |
| `slack`    | Slack    |
| `signal`   | Signal   |
| `sms`      | SMS      |

Messages from `client_chat` (dashboard web chat) and internal sources (system events, knowledge ingestion) are excluded from the inbox feed.

## Common error codes

| Status | Code             | Description               |
| ------ | ---------------- | ------------------------- |
| 500    | `INTERNAL_ERROR` | Failed to load inbox data |
