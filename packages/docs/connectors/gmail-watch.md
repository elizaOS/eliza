# Gmail Watch Connector

Monitor Gmail inboxes for incoming messages using Google Cloud Pub/Sub with the `@elizaos/plugin-gmail-watch` package.

## Overview

The Gmail Watch plugin is an elizaOS feature plugin that monitors Gmail inboxes via Google Cloud Pub/Sub. It watches for new messages and triggers agent events. This plugin is enabled via the `features.gmailWatch` flag rather than the `connectors` section. Available from the plugin registry.

> **Note:** Gmail Watch is categorized as a feature plugin, not a connector. It uses the `features` config section instead of `connectors`.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-gmail-watch` |
| Feature flag | `features.gmailWatch` |
| Install | `eliza plugins install @elizaos/plugin-gmail-watch` |

## Setup Requirements

- A Gmail account
- Google Cloud service account or OAuth credentials with Gmail API access
- A Pub/Sub topic configured for Gmail push notifications

## Configuration

Gmail Watch does not use environment variables for configuration. It is enabled via the `features` section of your config.

Install the plugin from the registry:

```bash
eliza plugins install gmail-watch
```

Enable in `~/.eliza/eliza.json`:

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

## Setup

1. Set up a Google Cloud project with the Gmail API enabled.
2. Configure a Pub/Sub topic for Gmail push notifications.
3. Create a service account or OAuth credentials with Gmail API access.
4. Install the plugin: `eliza plugins install gmail-watch`.
5. Enable the feature in your config as shown above.
6. Start your agent.

## Features

- Gmail Pub/Sub message watching
- Auto-renewal of watch subscriptions
- Inbound email event handling
- Label filtering for targeted inbox monitoring

## Important

Unlike most connectors, Gmail Watch is configured via the `features` section of `eliza.json`, **not** the `connectors` section. It must be installed from the registry before use.

## Related

- [Gmail Watch plugin reference](/plugin-registry/platform/gmail-watch)
- [Connectors overview](/guides/connectors#gmail-watch)
- [Configuration reference](/configuration)
