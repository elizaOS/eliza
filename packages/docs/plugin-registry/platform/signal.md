---
title: "Signal Plugin"
sidebarTitle: "Signal"
description: "Signal connector for Eliza — private messaging via signal-cli with HTTP/JSON-RPC mode, attachments, and read receipts."
---

The Signal plugin connects Eliza agents to Signal via signal-cli running in HTTP or JSON-RPC mode, enabling private and group messaging with attachment and reaction support.

**Package:** `@elizaos/plugin-signal`

## Installation

```bash
eliza plugins install @elizaos/plugin-signal
```

## Setup

### 1. Install signal-cli

Install [signal-cli](https://github.com/AsamK/signal-cli) and register or link a Signal account:

```bash
signal-cli -a +1234567890 register
signal-cli -a +1234567890 verify CODE
```

### 2. Start signal-cli in HTTP Mode

```bash
signal-cli -a +1234567890 daemon --http localhost:8080
```

### 3. Configure Eliza

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

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `account` | Yes | Signal phone number (E.164 format, e.g., `+1234567890`) |
| `httpUrl` | No | HTTP URL for signal-cli daemon (e.g., `http://localhost:8080`) |
| `httpHost` | No | Hostname alternative to `httpUrl` |
| `httpPort` | No | Port alternative to `httpUrl` |
| `cliPath` | No | Path to signal-cli binary for auto-start |
| `startupTimeoutMs` | No | Milliseconds to wait for CLI startup (1000-120000) |
| `receiveMode` | No | `"on-start"` or `"manual"` (default: `"on-start"`) |
| `ignoreAttachments` | No | Ignore incoming attachments |
| `ignoreStories` | No | Ignore story messages |
| `sendReadReceipts` | No | Send read receipts for received messages |
| `reactionNotifications` | No | `"off"`, `"own"`, `"all"`, or `"allowlist"` |
| `dmPolicy` | No | `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` (default: `"pairing"`) |

## Features

- **HTTP and JSON-RPC** — Connects to signal-cli via HTTP URL or host/port
- **Auto-start** — Optional CLI auto-start with configurable timeout
- **Attachments** — Send and receive media attachments
- **Read receipts** — Configurable delivery/read receipt support
- **Reactions** — Reaction notifications at configurable levels
- **Stories** — Optional story message processing
- **Multi-account** — Supports multiple Signal accounts via `accounts` map

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SIGNAL_ACCOUNT_NUMBER` | Yes | Signal phone number (E.164 format) |
| `SIGNAL_HTTP_URL` | No | HTTP URL for signal-cli daemon |
| `SIGNAL_CLI_PATH` | No | Path to signal-cli binary |
| `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES` | No | Ignore group messages |

## Auto-Enable

The plugin auto-enables when the `connectors.signal` block contains an `account`:

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890"
    }
  }
}
```

## Related

- [iMessage Plugin](/plugin-registry/platform/imessage) — iMessage integration
- [Telegram Plugin](/plugin-registry/platform/telegram) — Telegram bot integration
- [Connectors Guide](/guides/connectors) — General connector documentation
