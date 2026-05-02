---
title: "Matrix Plugin"
sidebarTitle: "Matrix"
description: "Matrix connector for Eliza — federated chat with room support, encryption, and auto-join."
---

The Matrix plugin connects Eliza agents to any Matrix homeserver, enabling messaging in rooms, direct messages, and optional end-to-end encryption.

**Package:** `@elizaos/plugin-matrix`

## Installation

```bash
eliza plugins install @elizaos/plugin-matrix
```

## Setup

### 1. Create a Bot Account

Create a Matrix account for your bot on your preferred homeserver (e.g., matrix.org, or a self-hosted instance).

### 2. Obtain an Access Token

Generate an access token through your Matrix client or via the [Client-Server API](https://spec.matrix.org/latest/client-server-api/#login):

```bash
curl -X POST https://matrix.example.com/_matrix/client/v3/login \
  -d '{"type":"m.login.password","user":"@bot:example.com","password":"botpassword"}'
```

### 3. Configure Eliza

```json
{
  "env": {
    "MATRIX_ACCESS_TOKEN": "syt_your_access_token"
  },
  "connectors": {
    "matrix": {
      "enabled": true
    }
  }
}
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MATRIX_ACCESS_TOKEN` | Yes | — | Access token for homeserver authentication |
| `MATRIX_HOMESERVER` | No | — | Homeserver URL (e.g., `https://matrix.org`) |
| `MATRIX_USER_ID` | No | — | Bot user ID (e.g., `@bot:matrix.org`) |
| `MATRIX_DEVICE_ID` | No | — | Device identifier for encryption sessions |
| `MATRIX_ROOMS` | No | — | Comma-separated room IDs to join |
| `MATRIX_AUTO_JOIN` | No | `false` | Automatically accept room invitations |
| `MATRIX_ENCRYPTION` | No | `false` | Enable end-to-end encryption (Olm) |
| `MATRIX_REQUIRE_MENTION` | No | `false` | Only respond when @mentioned |

## Features

- Private and room messaging
- Auto-join on invitation
- End-to-end encryption support
- Mention filtering for rooms
- Works with any spec-compliant homeserver

## Auto-Enable

The plugin auto-enables when the `connectors.matrix` block contains `token`, `botToken`, or `apiKey`. Environment variables alone do not trigger auto-enable. Set `"token": "syt_your_access_token"` in the connector config to trigger auto-enable, or add the plugin to `plugins.allow` explicitly.

## Related

- [Matrix connector setup](/connectors/matrix) — full connector configuration
- [Connectors overview](/guides/connectors) — all platform connectors
