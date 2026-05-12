---
title: "Connectors API"
sidebarTitle: "Connectors"
description: "REST API endpoints for managing platform connectors — Telegram, Discord, WhatsApp, and other messaging integrations."
---

The connectors API manages the agent's platform connector configurations. Connectors bridge the agent to external messaging platforms. 28 connectors are supported: Discord, Telegram, Slack, WhatsApp, Signal, iMessage, Blooio, MS Teams, Google Chat, Twitter, Farcaster, Twitch, Mattermost, WeChat, Matrix, Feishu, Nostr, Lens, BlueBubbles, Bluesky, Instagram, LINE, Zalo, Twilio, GitHub, Gmail Watch, Nextcloud Talk, and Tlon. Configuration is persisted to the Eliza config file. Changes typically require a restart to take effect.

See the [Connectors guide](/guides/connectors) for detailed setup instructions per platform.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/connectors` | List all configured connectors |
| POST | `/api/connectors` | Add or update a connector |
| DELETE | `/api/connectors/:name` | Remove a connector |

---

### GET /api/connectors

Returns all configured connectors with secrets redacted.

**Response**

```json
{
  "connectors": {
    "telegram": {
      "botToken": "****:****"
    },
    "discord": {
      "token": "****"
    }
  }
}
```

---

### POST /api/connectors

Add a new connector or update an existing one. The connector config is saved to the Eliza config file.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Connector identifier (e.g. `telegram`, `discord`, `whatsapp`) |
| `config` | object | Yes | Connector-specific configuration |

```json
{
  "name": "telegram",
  "config": {
    "botToken": "123456:ABC-DEF..."
  }
}
```

**Response**

Returns the updated connectors map (with secrets redacted):

```json
{
  "connectors": {
    "telegram": {
      "botToken": "****:****"
    }
  }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing connector name |
| 400 | Name is a reserved key (`__proto__`, `constructor`, `prototype`) |
| 400 | Missing connector config object |

---

### DELETE /api/connectors/:name

Remove a connector from the configuration. Also removes from the legacy `channels` config key if present.

**Path Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Connector name (URL-encoded) |

**Response**

Returns the updated connectors map:

```json
{
  "connectors": {}
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid connector name |
