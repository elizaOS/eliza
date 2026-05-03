---
title: "WhatsApp Plugin"
sidebarTitle: "WhatsApp"
description: "WhatsApp connector for Eliza — personal messaging via Baileys or official WhatsApp Business Cloud API."
---

The WhatsApp plugin connects Eliza agents to WhatsApp, supporting two authentication methods: **Baileys** (QR code scan, personal accounts) and **Cloud API** (WhatsApp Business API, official).

**Package:** `@elizaos/plugin-whatsapp`

## Overview

Two paths are available:

- **Baileys (Personal)** — Uses the WhatsApp Web multi-device protocol. No API keys or business accounts needed. Scan a QR code with your phone to authenticate. **Pros:** no cost, works with personal accounts. **Cons:** unofficial API (may violate WhatsApp ToS), session can expire if phone disconnects.
- **Cloud API (Business)** — Uses Meta's official WhatsApp Business Cloud API. Requires a WhatsApp Business Account and access tokens from the Meta Developer Dashboard. **Pros:** official, reliable, webhook-based. **Cons:** requires business account, per-message costs may apply.

## Installation

```bash
eliza plugins install @elizaos/plugin-whatsapp
```

## Setup

### 1. Configure Authentication Directory

The plugin stores WhatsApp session credentials in an `authDir` directory. On first run, it will display a QR code for you to scan with your phone.

```json
{
  "connectors": {
    "whatsapp": {
      "authDir": "./whatsapp-auth"
    }
  }
}
```

### 2. Scan the QR Code

On first start, the plugin prints a QR code to the terminal. Scan it with WhatsApp on your phone:

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the QR code displayed in the terminal

The session is saved to `authDir` and persists across restarts.

### Cloud API Setup

For the official WhatsApp Business API, set environment variables instead of (or in addition to) `authDir`:

```bash
WHATSAPP_ACCESS_TOKEN=your-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_WEBHOOK_VERIFY_TOKEN=your-webhook-verify-token
WHATSAPP_BUSINESS_ACCOUNT_ID=your-business-account-id
```

These can be placed in `~/.eliza/.env` or the `env` section of your config file.

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `authDir` | Baileys only | Directory path for Baileys session files |
| `enabled` | No | Set `false` to disable (default: `true`) |
| `allowedJids` | No | Array of WhatsApp JIDs (phone numbers) to respond to |
| `allowedGroups` | No | Array of group JIDs to participate in |
| `ignoreOwnMessages` | No | Skip messages sent by the bot itself (default: `true`) |
| `dmPolicy` | No | DM acceptance policy: `"pairing"`, `"open"`, or `"closed"` (default: `"pairing"`) |
| `groupPolicy` | No | Group message policy: `"open"`, `"disabled"`, or `"allowlist"` (default: `"allowlist"`) |
| `selfChatMode` | No | Respond to your own messages for testing (default: `false`) |

```json
{
  "connectors": {
    "whatsapp": {
      "authDir": "./whatsapp-auth",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["1234567890-1234567890@g.us"]
    }
  }
}
```

## Multi-Account Support

Run multiple WhatsApp accounts by configuring the `accounts` map:

```json
{
  "connectors": {
    "whatsapp": {
      "accounts": {
        "account1": {
          "authDir": "./whatsapp-auth-1"
        },
        "account2": {
          "authDir": "./whatsapp-auth-2",
          "enabled": false
        }
      }
    }
  }
}
```

## Features

- **Personal accounts** — No Business API subscription required
- **Multi-device support** — WhatsApp multi-device protocol
- **Group chats** — Responds in group conversations
- **Private messages** — 1:1 message handling
- **Media** — Receives and sends images, documents, voice notes
- **Status updates** — Can post to WhatsApp Status
- **Multi-account** — Manage multiple WhatsApp numbers

## Message Flow

```
WhatsApp WebSocket event
       ↓
Plugin filters by allowed JIDs/groups
       ↓
Media downloaded and processed if present
       ↓
AgentRuntime processes message
       ↓
Response sent via Baileys API
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | No | WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | No | WhatsApp Business phone number ID |
| `WHATSAPP_AUTH_METHOD` | No | Authentication method: `baileys` or `cloud-api` |
| `WHATSAPP_AUTH_DIR` | No | Directory for Baileys session files |
| `WHATSAPP_PRINT_QR` | No | Print QR code in terminal for Baileys auth |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | No | Webhook verification token for Cloud API |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | No | WhatsApp Business account ID |
| `WHATSAPP_API_VERSION` | No | Cloud API version |
| `WHATSAPP_DM_POLICY` | No | DM acceptance policy |
| `WHATSAPP_GROUP_POLICY` | No | Group message policy |

## Auto-Enable

The plugin auto-enables when `connectors.whatsapp` contains an `authDir` or `accounts` configuration with at least one account that has `authDir` set.

## Session Persistence

Session credentials are stored in the `authDir` as multiple JSON files. Back up this directory to avoid needing to re-scan the QR code after a restart.

## Related

- [WhatsApp Connector Reference](/connectors/whatsapp) — Full configuration reference (multi-account, acknowledgment reactions, per-group config, streaming)
- [Telegram Plugin](/plugin-registry/platform/telegram) — Telegram bot integration (official API)
- [Connectors Guide](/guides/whatsapp) — WhatsApp setup guide
- [Connectors Overview](/guides/connectors) — All connector options
