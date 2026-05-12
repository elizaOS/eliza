---
title: "Tlon Plugin"
sidebarTitle: "Tlon"
description: "Tlon connector for Eliza — bot integration with the Tlon (Urbit) messaging platform."
---

The Tlon plugin connects Eliza agents to Tlon (Urbit), enabling message handling through a connected Urbit ship.

**Package:** `@elizaos/plugin-tlon`

## Installation

```bash
eliza plugins install @elizaos/plugin-tlon
```

## Setup

### 1. Get Your Urbit Ship Credentials

1. Have a running Urbit ship (planet, star, or comet)
2. Note the ship name (e.g., `~zod`)
3. Obtain the access code from your ship's web interface (Settings → Access Key)
4. Note the ship's URL (e.g., `http://localhost:8080`)

### 2. Configure Eliza

```json
{
  "connectors": {
    "tlon": {
      "ship": "YOUR_SHIP",
      "code": "YOUR_CODE",
      "url": "YOUR_URL"
    }
  }
}
```

Or via environment variables:

```bash
export TLON_SHIP=YOUR_SHIP
export TLON_CODE=YOUR_CODE
export TLON_URL=YOUR_URL
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `ship` | Yes | Urbit ship name (e.g., `~zod`) |
| `code` | Yes | Urbit ship access code |
| `url` | Yes | Urbit ship URL |
| `enabled` | No | Set `false` to disable (default: `true`) |
| `dmAllowlist` | No | Comma-separated allowed user list for DMs |
| `groupChannels` | No | Comma-separated list of group channel identifiers |
| `autoDiscoverChannels` | No | Comma-separated list of channels to auto-discover |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TLON_SHIP` | No | Urbit ship name (e.g., `~zod`) |
| `TLON_CODE` | No | Urbit ship access code |
| `TLON_URL` | No | Urbit ship URL |
| `TLON_ENABLED` | No | Enable or disable the connector |
| `TLON_DM_ALLOWLIST` | No | Comma-separated allowed ship names for DMs |
| `TLON_GROUP_CHANNELS` | No | Comma-separated group channel paths |
| `TLON_AUTO_DISCOVER_CHANNELS` | No | Auto-discover channels from groups |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
