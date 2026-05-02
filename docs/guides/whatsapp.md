---
title: "WhatsApp Integration"
sidebarTitle: "WhatsApp"
description: "Detailed guide for WhatsApp integration using Baileys (QR code) or Cloud API authentication."
---

This guide covers the WhatsApp connector in detail, including both authentication methods, configuration, session management, and troubleshooting.

## Table of Contents

1. [Overview](#overview)
2. [Authentication Methods](#authentication-methods)
3. [Quick Start with Baileys](#quick-start-with-baileys)
4. [Cloud API Setup](#cloud-api-setup)
5. [Configuration Reference](#configuration-reference)
6. [Session Persistence](#session-persistence)
7. [Reconnection](#reconnection)
8. [Example Character Config](#example-character-config)
9. [Troubleshooting](#troubleshooting)

---

## Overview

The WhatsApp connector (`@elizaos/plugin-whatsapp`) supports two authentication methods:

- **Baileys** -- For personal accounts using QR code authentication (similar to WhatsApp Web)
- **Cloud API** -- For business accounts using the WhatsApp Business API

---

## Authentication Methods

### Baileys (QR Code)

Baileys is an open-source library that connects to WhatsApp via the multi-device Web protocol. No external API keys or business accounts are needed. Authentication is completed by scanning a QR code with the WhatsApp mobile app.

**Pros**: No API costs, works with personal accounts, full feature access.
**Cons**: Requires a phone with WhatsApp linked, session can expire if phone disconnects.

### Cloud API (Business)

The WhatsApp Business Cloud API is Meta's official API for building business integrations. Requires a WhatsApp Business Account and access tokens from the Meta Developer Dashboard.

**Pros**: Official API, reliable uptime, webhook-based.
**Cons**: Requires business account, per-message costs may apply, approval process.

---

## Quick Start with Baileys

### Step 1: Configure

Add the WhatsApp connector to your agent's configuration file:

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
      "selfChatMode": false
    }
  }
}
```

The `authDir` is where Baileys stores session credentials. Create this directory or let Eliza create it automatically.

### Step 2: Start Eliza

```bash
eliza start -- --character=./your-character.json
```

### Step 3: Scan the QR Code

When Eliza starts with a fresh WhatsApp configuration, a QR code appears in the terminal:

1. Open WhatsApp on your phone
2. Go to **Settings** > **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code displayed in your terminal

### Step 4: Verify Connection

Once paired, the logs will show:

```
[WhatsApp] Connected to WhatsApp!
```

The session is saved to `authDir` and reused on subsequent starts. No re-scanning is needed unless the session is revoked.

---

## Cloud API Setup

For the WhatsApp Business Cloud API, configure via environment variables:

```bash
WHATSAPP_ACCESS_TOKEN=your_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_id
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your_verify_token
WHATSAPP_BUSINESS_ACCOUNT_ID=your_account_id
```

These can also be placed in the `env` section of `eliza.json`.

---

## Configuration Reference

### Top-Level WhatsApp Config

These fields apply to all accounts unless overridden:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accounts` | object | -- | Named account configurations |
| `dmPolicy` | string | `"pairing"` | DM acceptance policy: `"pairing"`, `"open"`, or `"closed"` |
| `sendReadReceipts` | boolean | -- | Send read receipts for incoming messages |
| `selfChatMode` | boolean | -- | Respond to your own messages (for testing; avoid in production) |
| `messagePrefix` | string | -- | Text prefix added to all outgoing messages |
| `groupPolicy` | string | `"allowlist"` | Group message policy |
| `groupAllowFrom` | string[] | -- | Allowlist of group JIDs |
| `allowFrom` | string[] | -- | Allowlist of phone numbers (required when `dmPolicy: "open"`) |
| `historyLimit` | number | -- | Max messages to load from conversation history |
| `dmHistoryLimit` | number | -- | Max messages for DM history |
| `textChunkLimit` | number | -- | Max characters per outgoing message chunk |
| `chunkMode` | string | -- | `"length"` or `"newline"` for splitting long messages |
| `mediaMaxMb` | number | `50` | Max media attachment size in MB |
| `debounceMs` | number | `0` | Delay before responding to allow message batching |
| `blockStreaming` | boolean | -- | Disable streaming responses |
| `ackReaction` | object | -- | Acknowledgment reaction settings |
| `groups` | object | -- | Per-group configuration overrides |

### Acknowledgment Reactions

```json
{
  "ackReaction": {
    "emoji": "eyes",
    "direct": true,
    "group": "mentions"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `emoji` | string | -- | Reaction emoji to send as acknowledgment |
| `direct` | boolean | `true` | Send ack reactions in DMs |
| `group` | string | `"mentions"` | Group ack behavior: `"always"`, `"mentions"`, or `"never"` |

### Per-Account Config

Each account under `accounts.<name>` supports all top-level fields plus:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable or disable this account |
| `authDir` | string | Directory for Baileys session files (multi-file auth state) |
| `name` | string | Display name for this account |

---

## Session Persistence

Baileys saves its session state to the directory specified by `authDir`. This includes:

- Encryption credentials
- Device registration info
- Authentication keys

**Security considerations**:

- Never commit the auth directory to version control (`auth/` should be in `.gitignore`)
- Back up the auth directory if you want to avoid re-scanning on a new machine
- The auth directory contents grant full access to the linked WhatsApp session

---

## Reconnection

Eliza automatically reconnects using saved session files on restart. A new QR code is only generated when:

- The session files in `authDir` are deleted or corrupted
- Your phone revokes the linked device (Settings > Linked Devices > remove)
- The session expires due to prolonged disconnection

When reconnection fails, the connector logs the error and enters a retry loop.

---

## Example Character Config

A complete example character configuration for WhatsApp testing:

```json
{
  "name": "Eliza WhatsApp Test",
  "description": "Test configuration for WhatsApp connector with Baileys (QR code) authentication",
  "bio": [
    "A test bot for validating WhatsApp connector functionality",
    "Supports both Cloud API and Baileys (QR code) authentication methods"
  ],
  "connectors": {
    "whatsapp": {
      "accounts": {
        "default": {
          "enabled": true,
          "authDir": "./auth/whatsapp-test"
        }
      },
      "dmPolicy": "pairing",
      "sendReadReceipts": true,
      "selfChatMode": false,
      "messagePrefix": "[Eliza] "
    }
  },
  "modelProvider": "anthropic",
  "secrets": {
    "enableServerless": false
  }
}
```

---

## Troubleshooting

### Plugin Not Loading

If the WhatsApp plugin does not start, verify:

- At least one account is defined under `accounts` with `enabled: true`
- The `authDir` path is valid and writable
- The auto-enable logic requires a configured account to activate the plugin

### QR Code Expires

QR codes have a short time-to-live (typically around 20 seconds). Eliza automatically generates a new QR code when the previous one expires. Make sure your phone has internet access when scanning.

### Session Expired

If reconnection fails with a session error:

1. Delete the contents of your `authDir` directory
2. Restart Eliza
3. Scan the new QR code

### `dmPolicy: "open"` Validation Error

When setting `dmPolicy` to `"open"`, you must also set `allowFrom: ["*"]` in your configuration. This is a safety requirement enforced by the config validator:

```json
{
  "dmPolicy": "open",
  "allowFrom": ["*"]
}
```

### Connection Drops

WhatsApp may disconnect the session if:

- The phone loses internet connectivity for an extended period
- WhatsApp updates require re-linking
- Too many concurrent linked devices

The connector will attempt automatic reconnection. If that fails persistently, delete `authDir` and re-pair.

### Rate Limits

WhatsApp has undocumented rate limits. If the agent sends messages too rapidly, the connection may be throttled or temporarily banned. Use `debounceMs` to add delays between responses:

```json
{
  "debounceMs": 1000
}
```
