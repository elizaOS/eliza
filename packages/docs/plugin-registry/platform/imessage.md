---
title: "iMessage Plugin"
sidebarTitle: "iMessage"
description: "iMessage connector for Eliza — macOS native messaging with iMessage and SMS support, database access, and remote host connectivity."
---

The iMessage plugin connects Eliza agents to iMessage on macOS, supporting both iMessage and SMS conversations with configurable service selection and attachment handling.

**Package:** `@elizaos/plugin-imessage`

## Installation

```bash
eliza plugins install @elizaos/plugin-imessage
```

## Setup

### 1. Prerequisites

- macOS with iMessage configured and signed in
- Full Disk Access granted to the terminal or application running Eliza (for chat database access)

### 2. Configure Eliza

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

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `cliPath` | Yes | Path to the iMessage CLI tool executable (required to trigger auto-enable) |
| `service` | No | Service type: `"imessage"`, `"sms"`, or `"auto"` |
| `dbPath` | No | Path to iMessage database (default: `~/Library/Messages/chat.db`) |
| `remoteHost` | No | Remote Mac hostname for SSH-based iMessage access |
| `region` | No | Region configuration for phone number formatting |
| `includeAttachments` | No | Include attachments in messages |
| `dmPolicy` | No | DM access policy: `"pairing"`, `"allowlist"`, `"open"`, or `"disabled"` (default: `"pairing"`) |

## Features

- **Service selection** — Choose between iMessage, SMS, or automatic detection
- **Database access** — Direct access to macOS iMessage database for message history
- **Remote host** — Connect to iMessage on a remote Mac via SSH
- **Attachments** — Send and receive media attachments
- **Per-group config** — Configure mention requirements and tool access per group
- **Multi-account** — Supports multiple accounts via `accounts` map

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IMESSAGE_ENABLED` | No | Enable or disable the connector |
| `IMESSAGE_CLI_PATH` | No | Path to the iMessage CLI tool executable |
| `IMESSAGE_DB_PATH` | No | Path to iMessage database (default: `~/Library/Messages/chat.db`) |
| `IMESSAGE_DM_POLICY` | No | DM access policy |
| `IMESSAGE_ALLOW_FROM` | No | Comma-separated allowed phone numbers/emails |
| `IMESSAGE_GROUP_POLICY` | No | Group message policy |
| `IMESSAGE_POLL_INTERVAL_MS` | No | Polling interval in milliseconds |

## Auto-Enable

The plugin auto-enables when the `connectors.imessage` block contains a `cliPath`:

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage"
    }
  }
}
```

## Troubleshooting

### Full Disk Access

If message retrieval fails, ensure Full Disk Access is granted:

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add the terminal application or Eliza process

### Database Path

The default iMessage database is at `~/Library/Messages/chat.db`. If using a non-standard location, set `dbPath` explicitly.

## Related

- [iMessage Connector Reference](/connectors/imessage) — Full configuration reference (per-contact config, remote SSH access, attachment options)
- [Signal Plugin](/plugin-registry/platform/signal) — Signal messaging integration
- [Connectors Guide](/guides/connectors) — General connector documentation
