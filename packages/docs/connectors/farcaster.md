# Farcaster Connector

Connect your agent to the Farcaster decentralized social protocol for casting, replies, and channel participation using the `@elizaos/plugin-farcaster` package.

## Prerequisites

- A Farcaster account with a known FID
- A [Neynar](https://neynar.com) API key
- A Neynar signer UUID associated with your Farcaster account

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | Yes | Neynar API key for authentication |
| `FARCASTER_FID` | Yes | Farcaster ID (FID) of the agent account |
| `FARCASTER_SIGNER_UUID` | Yes | Neynar signer UUID for signing casts |
| `FARCASTER_HUB_URL` | No | Farcaster hub URL (default: `hub.pinata.cloud`) |
| `FARCASTER_MODE` | No | Operation mode: `polling` or `webhook` (default: `polling`) |
| `FARCASTER_POLL_INTERVAL` | No | Polling interval in seconds (default: `120`) |
| `FARCASTER_DRY_RUN` | No | Simulate operations without executing them |
| `ENABLE_CAST` | No | Enable posting casts (default: `true`) |
| `CAST_IMMEDIATELY` | No | Post immediately instead of on schedule (default: `false`) |
| `CAST_INTERVAL_MIN` | No | Minimum minutes between autonomous casts (default: `90`) |
| `CAST_INTERVAL_MAX` | No | Maximum minutes between autonomous casts (default: `180`) |
| `MAX_CAST_LENGTH` | No | Maximum characters per cast (default: `320`) |
| `ENABLE_ACTION_PROCESSING` | No | Enable automated action processing (default: `false`) |
| `ACTION_INTERVAL` | No | Minutes between action-processing cycles (default: `5`) |
| `MAX_ACTIONS_PROCESSING` | No | Maximum actions per batch (default: `1`) |

These can be set as environment variables or under the `connectors.farcaster` config in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "farcaster": {
      "apiKey": "YOUR_NEYNAR_API_KEY",
      "signerUuid": "YOUR_SIGNER_UUID",
      "fid": 12345
    }
  }
}
```

The connector auto-enables when `apiKey` is truthy in the connector config and `enabled` is not explicitly `false`.

## Setup

```json
{
  "connectors": {
    "farcaster": {
      "apiKey": "YOUR_NEYNAR_API_KEY",
      "signerUuid": "YOUR_SIGNER_UUID",
      "fid": 12345,
      "enabled": false
    }
  }
}
```

## Auto-Enable Mechanism

The `plugin-auto-enable.ts` module checks `connectors.farcaster` in your config. If the `apiKey` field is truthy (and `enabled` is not explicitly `false`), the runtime automatically loads `@elizaos/plugin-farcaster`.

The connector can also be enabled via the `FARCASTER_NEYNAR_API_KEY` environment variable (used as the primary env key in the plugin registry). Additional env vars supported: `FARCASTER_FID`, `FARCASTER_SIGNER_UUID`, `FARCASTER_POLL_INTERVAL`, `FARCASTER_HUB_URL`, `FARCASTER_DRY_RUN`, `FARCASTER_MODE`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | Neynar API key. When set, the runtime maps this to the connector's `apiKey` field. Can be used as an alternative to placing the key directly in `eliza.json`. |

## Environment Variables

When the connector is loaded, the following environment variables are consumed by the plugin:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | Yes | — | Neynar API key for authentication |
| `FARCASTER_SIGNER_UUID` | Yes | — | UUID of the Neynar signer for signing casts |
| `FARCASTER_FID` | Yes | — | Farcaster ID (user identifier) for the agent account |
| `FARCASTER_HUB_URL` | No | `hub.pinata.cloud` | Farcaster hub URL |
| `FARCASTER_POLL_INTERVAL` | No | `120` | Polling interval in seconds |
| `FARCASTER_DRY_RUN` | No | `false` | Simulate operations without executing |
| `FARCASTER_MODE` | No | `polling` | Operation mode: `polling` or `webhook` |
| `ENABLE_CAST` | No | `true` | Enable or disable posting casts |
| `CAST_IMMEDIATELY` | No | `false` | Publish casts immediately instead of on a schedule |
| `CAST_INTERVAL_MIN` | No | `90` | Minimum interval in minutes between automated casts |
| `CAST_INTERVAL_MAX` | No | `180` | Maximum interval in minutes between automated casts |
| `MAX_CAST_LENGTH` | No | `320` | Maximum characters per cast |
| `ACTION_INTERVAL` | No | `5` | Interval in minutes between action-processing cycles |
| `ENABLE_ACTION_PROCESSING` | No | `false` | Enable automated action processing |
| `MAX_ACTIONS_PROCESSING` | No | `1` | Maximum actions to process in a single batch |

## Full Configuration Reference

All fields are defined under `connectors.farcaster` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | — | Neynar API key (required) |
| `signerUuid` | string | — | Neynar signer UUID for the agent account (required) |
| `fid` | number | — | Farcaster ID of the agent account (required) |
| `enabled` | boolean | — | Explicitly enable/disable |
| `channels` | string[] | — | Farcaster channel names to monitor and participate in |
| `pollInterval` | number | `120` | Seconds between mention checks |
| `mode` | `"polling"` \| `"webhook"` | `"polling"` | Operation mode |
| `dryRun` | boolean | `false` | Simulate operations without executing |
| `hubUrl` | string | `hub.pinata.cloud` | Farcaster hub URL |

### Autonomous Casting

The agent can post casts autonomously at random intervals. The LLM generates cast content based on the character's personality and current context.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `castIntervalMin` | number | `90` | Minimum minutes between autonomous casts |
| `castIntervalMax` | number | `180` | Maximum minutes between autonomous casts |
| `castImmediately` | boolean | `false` | Publish casts immediately |
| `maxCastLength` | number | `320` | Maximum characters per cast |

### Action Processing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `actionInterval` | number | `5` | Minutes between action-processing cycles |
| `enableActionProcessing` | boolean | `false` | Enable automated action processing |
| `maxActionsProcessing` | number | `1` | Max actions to process per batch |

```json
{
  "connectors": {
    "farcaster": {
      "apiKey": "...",
      "signerUuid": "...",
      "fid": 12345,
      "channels": ["ai", "agents"],
      "castIntervalMin": 90,
      "castIntervalMax": 180
    }
  }
}
```

### Cast Limits

Casts are limited to 320 characters. Longer responses are automatically split into cast threads.

### DM Policy

Farcaster supports direct casts (private messages via Warpcast). The connector handles incoming direct casts as DM conversations.

## Features

- **Autonomous casting** -- Posts in the agent's voice at configurable intervals
- **Replies** -- Responds to @mentions and replies to the agent's casts
- **Reactions** -- Likes and recasts
- **Channel monitoring** -- Participates in Farcaster channels
- **Direct casts** -- Private DM-like messages (Warpcast feature)
- **On-chain identity** -- Agent identity is tied to an Ethereum address
- **Thread splitting** -- Messages over 320 characters are split into cast threads

## Related

- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
