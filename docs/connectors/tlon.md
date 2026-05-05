# Tlon Connector

Connect your agent to the Urbit network via Tlon for ship-to-ship messaging using the `@elizaos/plugin-tlon` package.

## Prerequisites

The Tlon connector is an elizaOS plugin that bridges your agent to the Urbit network. It supports ship-to-ship messaging and group chat participation. This connector is available from the plugin registry.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-tlon` |
| Config key | `connectors.tlon` |
| Install | `eliza plugins install @elizaos/plugin-tlon` |

## Setup

### 1. Get Your Urbit Ship Credentials

1. Have a running Urbit ship (planet, star, or comet)
2. Note the ship name (e.g., `~zod`)
3. Obtain the access code from your ship's web interface (Settings → Access Key)
4. Note the ship's URL (e.g., `http://localhost:8080`)

### 2. Configure Eliza

| Name | Required | Description |
|------|----------|-------------|
| `TLON_SHIP` | No | Urbit ship name (e.g., `~zod`) |
| `TLON_CODE` | No | Ship authentication/access code |
| `TLON_URL` | No | Ship URL (e.g., `http://localhost:8080`) |
| `TLON_ENABLED` | No | Enable or disable the connector |
| `TLON_DM_ALLOWLIST` | No | Comma-separated allowed user list for DMs |
| `TLON_GROUP_CHANNELS` | No | Comma-separated list of group channel identifiers |
| `TLON_AUTO_DISCOVER_CHANNELS` | No | Auto-discover available channels (boolean) |

Install the plugin from the registry:

```bash
eliza plugins install tlon
```

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "tlon": {
      "ship": "~zod",
      "code": "YOUR_ACCESS_CODE",
      "url": "http://localhost:8080"
    }
  }
}
```

Or via environment variables:

```bash
export TLON_SHIP=~zod
export TLON_CODE=YOUR_ACCESS_CODE
export TLON_URL=http://localhost:8080
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TLON_SHIP` | Yes | Urbit ship name (e.g., `~zod`) |
| `TLON_CODE` | Yes | Ship access code |
| `TLON_URL` | Yes | Ship URL (e.g., `http://localhost:8080`) |
| `TLON_ENABLED` | No | Set to `true` to enable |
| `TLON_DM_ALLOWLIST` | No | Comma-separated allowed user list for DMs |
| `TLON_GROUP_CHANNELS` | No | Comma-separated list of group channel identifiers |
| `TLON_AUTO_DISCOVER_CHANNELS` | No | Comma-separated list of channels to auto-discover |

## Configuration Reference

| Field | Required | Description |
|-------|----------|-------------|
| `ship` | Yes | Urbit ship name (e.g., `~zod`) |
| `code` | Yes | Urbit ship access code |
| `url` | Yes | Urbit ship URL |
| `enabled` | No | Set `false` to disable (default: `true`) |

## Features

- Ship-to-ship messaging on the Urbit network
- Group chat participation
- DM allowlist for access control
- Auto-discovery of group channels

## Related

- [Tlon Plugin Reference](/plugin-registry/platform/tlon)
- [Connectors overview](/guides/connectors#tlon)
