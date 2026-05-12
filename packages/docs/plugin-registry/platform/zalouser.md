---
title: "Zalo User Plugin"
sidebarTitle: "Zalo User"
description: "Zalo User connector for Eliza — personal-account messaging on the Zalo platform."
---

The Zalo User plugin connects Eliza agents to Zalo via a personal account, enabling one-to-one and group messaging outside the Official Account API.

**Package:** `@elizaos/plugin-zalouser`

## Installation

```bash
eliza plugins install zalouser
```

## Setup

### 1. Obtain Credentials

The Zalo User connector authenticates with a device IMEI and session cookie from your personal Zalo account.

### 2. Configure Eliza

Set environment variables:

```bash
export ZALOUSER_IMEI=YOUR_DEVICE_IMEI
export ZALOUSER_COOKIE_PATH=/path/to/cookie
```

Or enable the connector in `eliza.json`:

```json
{
  "connectors": {
    "zalouser": {
      "enabled": true
    }
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ZALOUSER_IMEI` | Device IMEI identifier (required) |
| `ZALOUSER_PROFILES` | Profile configuration |
| `ZALOUSER_DEFAULT_PROFILE` | Default profile to use |
| `ZALOUSER_COOKIE_PATH` | Path to session cookie file |
| `ZALOUSER_USER_AGENT` | User agent string for requests |
| `ZALOUSER_DM_POLICY` | DM policy (`allow`, `deny`, `allowlist`) |
| `ZALOUSER_GROUP_POLICY` | Group message policy (`allow`, `deny`) |
| `ZALOUSER_ALLOWED_THREADS` | Comma-separated list of allowed thread IDs |
| `ZALOUSER_LISTEN_TIMEOUT` | Timeout for listening to events |
| `ZALOUSER_ENABLED` | Enable or disable the connector |

## Features

- Personal-account one-to-one messaging (unlike the Official Account variant)
- DM and group policy controls
- Multi-profile support via `ZALOUSER_PROFILES`
- Thread allowlisting via `ZALOUSER_ALLOWED_THREADS`

## Related

- [Zalo (Official Account) plugin](/plugin-registry/platform/zalo)
- [Zalo User connector setup](/connectors/zalouser)
- [Connectors Guide](/guides/connectors)
