---
title: Zalouser Connector
sidebarTitle: Zalouser
description: Connect your agent to Zalo personal accounts using @elizaos/plugin-zalouser for one-to-one messaging.
---

Connect your agent to Zalo using a personal account for one-to-one messaging outside of the Official Account system.

## Overview

The Zalouser connector is a personal-account variant of the [Zalo](/connectors/zalo) connector. Instead of the Zalo Official Account API, it uses exported session cookies from a personal Zalo account to enable direct messaging.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-zalouser` |
| Config key | `connectors.zalouser` |

## Installation

```bash
eliza plugins install zalouser
```

## Setup

1. Export your Zalo session cookies from the official Zalo app or web client
2. Note your device IMEI from the Zalo app
3. Configure the environment variables or `eliza.json`

## Configuration

Set credentials via environment variables:

```bash
ZALOUSER_COOKIE_PATH=/path/to/cookies.json
ZALOUSER_IMEI=your-device-imei
```

Or configure in `~/.eliza/eliza.json`:

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

| Variable | Required | Description |
|----------|----------|-------------|
| `ZALOUSER_COOKIE_PATH` | Yes | Path to exported Zalo session cookies |
| `ZALOUSER_IMEI` | Yes | Device IMEI from the official Zalo app |
| `ZALOUSER_USER_AGENT` | No | Browser user agent string |
| `ZALOUSER_PROFILES` | No | Multiple account profiles (JSON) |
| `ZALOUSER_DEFAULT_PROFILE` | No | Default profile name |
| `ZALOUSER_ALLOWED_THREADS` | No | Comma-separated allowed conversation thread IDs |
| `ZALOUSER_DM_POLICY` | No | DM acceptance policy |
| `ZALOUSER_GROUP_POLICY` | No | Group message policy |
| `ZALOUSER_LISTEN_TIMEOUT` | No | Connection timeout in milliseconds |
| `ZALOUSER_ENABLED` | No | Enable/disable the connector |

## Features

- **Personal account messaging** — Use a personal Zalo account (not Official Account)
- **One-to-one conversations** — Direct messaging with Zalo contacts
- **Multiple profiles** — Configure multiple account profiles via `ZALOUSER_PROFILES`
- **Thread filtering** — Restrict which conversations the agent participates in

## Disabling

```json
{
  "connectors": {
    "zalouser": {
      "enabled": false
    }
  }
}
```

## Related

- [Zalo connector](/connectors/zalo) — Official Account variant
- [Zalouser plugin reference](/plugin-registry/platform/zalouser)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
