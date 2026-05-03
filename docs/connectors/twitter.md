---
title: Twitter/X Connector
sidebarTitle: Twitter/X
description: Connect your agent to Twitter/X via the xAI plugin (@elizaos/plugin-xai).
---

> **Registry note:** `@elizaos/plugin-x` is not currently listed in the Eliza plugin registry (`plugins.json`). The package may be available from npm or a separate elizaOS plugin repository. Verify availability before configuring.

Connect your agent to Twitter/X for social media engagement.

> **Availability:** `@elizaos/plugin-x` is an on-demand elizaOS plugin resolved from the remote plugin registry. It is **not** included in Eliza's bundled `plugins.json` index. The plugin auto-installs at runtime when a valid token is detected in your connector configuration.

## Overview

The Twitter connector is an elizaOS plugin that bridges your agent to Twitter/X. It is auto-enabled by the runtime when a valid token is detected in your connector configuration.

## Installation

```bash
eliza plugins install @elizaos/plugin-x
```

## Configuration

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-xai` |
| Config key | `connectors.twitter` |
| Auto-enable trigger | `apiKey`, `token`, or X OAuth env vars (`X_API_KEY`, etc.) |

<Note>
`@elizaos/plugin-x` is the dedicated Twitter connector and handles posting, mentions, and timeline interactions. The separate `@elizaos/plugin-xai` package also includes X/Twitter integration alongside Grok model access — if you already have xAI configured with `X_*` env vars, you may not need this connector separately.
</Note>

## Minimal Configuration

The connector auto-enables when `botToken`, `token`, or `apiKey` is truthy in the connector config and `enabled` is not explicitly `false`.

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "twitter": {
      "apiKey": "your-twitter-api-key"
    }
  }
}
```

## Disabling

To explicitly disable the connector even when a token is present:

```json
{
  "connectors": {
    "twitter": {
      "apiKey": "your-twitter-api-key",
      "enabled": false
    }
  }
}
```

## Setup

After installation, the `plugin-auto-enable.ts` module checks `connectors.twitter` in your config. If any of the fields `botToken`, `token`, or `apiKey` is truthy (and `enabled` is not explicitly `false`), the runtime automatically loads `@elizaos/plugin-x`.

No environment variable is required to trigger auto-enable — it is driven entirely by the connector config object. However, the plugin must first be installed via the registry (see [Installation](#installation) above).

## Environment Variables

Unlike Discord, Telegram, and Slack, the Eliza runtime does **not** inject Twitter secrets into `process.env` via the `CHANNEL_ENV_MAP`. The plugin reads credentials directly from the `connectors.twitter` config object.

The plugin also reads these environment variables as a fallback if the corresponding config fields are absent:

| Variable | Config Equivalent |
|----------|-------------------|
| `TWITTER_API_KEY` | `apiKey` |
| `TWITTER_API_SECRET_KEY` | `apiSecretKey` |
| `TWITTER_ACCESS_TOKEN` | `accessToken` |
| `TWITTER_ACCESS_TOKEN_SECRET` | `accessTokenSecret` |
| `TWITTER_DRY_RUN` | `dryRun` |
| `TWITTER_POST_ENABLE` | `postEnable` |
| `TWITTER_POST_INTERVAL_MIN` | `postIntervalMin` |
| `TWITTER_POST_INTERVAL_MAX` | `postIntervalMax` |
| `TWITTER_SEARCH_ENABLE` | `searchEnable` |
| `TWITTER_AUTO_RESPOND_MENTIONS` | `autoRespondMentions` |
| `TWITTER_POLL_INTERVAL` | `pollInterval` |

Config fields take precedence over environment variables. When using config-based setup, you do not need to set any environment variables.

## Full Configuration Reference

All fields are nested under `connectors.twitter` in `eliza.json`.

Note: Twitter does **not** support multi-account configuration. Only a single Twitter account can be configured per agent.

### Authentication

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | string | Twitter/X API key (consumer key) |
| `apiSecretKey` | string | API secret key (consumer secret) |
| `accessToken` | string | OAuth access token |
| `accessTokenSecret` | string | OAuth access token secret |
| `enabled` | boolean | Explicitly enable/disable the connector |

### Posting Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `postEnable` | boolean | `true` | Enable automated posting |
| `postImmediately` | boolean | `false` | Post immediately on startup (skip initial delay) |
| `postIntervalMin` | integer > 0 | `90` | Minimum minutes between automated posts |
| `postIntervalMax` | integer > 0 | `180` | Maximum minutes between automated posts |
| `postIntervalVariance` | number 0–1 | `0.1` | Randomization factor applied to the interval |
| `maxTweetLength` | integer > 0 | `4000` | Maximum tweet character length |

The posting interval is calculated as a random value between `postIntervalMin` and `postIntervalMax`, with additional variance applied by the `postIntervalVariance` factor.

### Interaction Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `searchEnable` | boolean | `false` | Enable keyword search monitoring |
| `autoRespondMentions` | boolean | `true` | Automatically respond to @mentions |
| `enableActionProcessing` | boolean | `true` | Process actions (like, retweet, quote) |
| `timelineAlgorithm` | `"weighted"` \| `"latest"` | `"weighted"` | Timeline processing algorithm |
| `pollInterval` | integer > 0 | `120` | Seconds between polling for new mentions/interactions |

### DM Policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy |

### Safety and Testing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dryRun` | boolean | `false` | When `true`, the agent generates posts but does not actually publish them. Useful for testing |
| `retryLimit` | integer > 0 | `3` | Max retry attempts for failed API calls |
| `configWrites` | boolean | — | Allow config writes from Twitter events |

### Example: Full Configuration

```json
{
  "connectors": {
    "twitter": {
      "apiKey": "your-consumer-key",
      "apiSecretKey": "your-consumer-secret",
      "accessToken": "your-access-token",
      "accessTokenSecret": "your-access-token-secret",
      "postEnable": true,
      "postIntervalMin": 60,
      "postIntervalMax": 120,
      "searchEnable": true,
      "autoRespondMentions": true,
      "timelineAlgorithm": "weighted",
      "dryRun": false
    }
  }
}
```

## Related

- [xAI plugin reference](/plugin-registry/llm/xai)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
