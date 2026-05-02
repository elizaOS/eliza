# BlueBubbles Connector

Connect your agent to iMessage through a local [BlueBubbles](https://bluebubbles.app) server running on macOS using the `@elizaos/plugin-bluebubbles` package.

## Prerequisites

The BlueBubbles connector is an elizaOS plugin that bridges your agent to iMessage via a self-hosted BlueBubbles server. Unlike the native iMessage connector (which reads the local Messages database directly), BlueBubbles works over HTTP and can be accessed from any machine on the same network. It requires a BlueBubbles server running on a Mac with Messages signed in. It is auto-enabled by the runtime when both a server URL and password are configured.

## Configuration

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-bluebubbles` |
| Config key | `connectors.bluebubbles` |
| Auto-enable trigger | `serverUrl` AND `password` are both truthy in connector config |

These can be set as environment variables or under the `connectors.bluebubbles` config in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "bluebubbles": {
      "serverUrl": "http://192.168.1.10:1234",
      "password": "your-bluebubbles-password"
    }
  }
}
```

The connector auto-enables when `password` or `serverUrl` is truthy in the connector config, or `accounts` contains at least one enabled entry.

To disable:

```json
{
  "connectors": {
    "bluebubbles": {
      "serverUrl": "http://192.168.1.10:1234",
      "password": "your-bluebubbles-password",
      "enabled": false
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLUEBUBBLES_SERVER_URL` | No | BlueBubbles server URL |
| `BLUEBUBBLES_PASSWORD` | Yes | Server password |
| `BLUEBUBBLES_ENABLED` | No | Enable or disable the connector |
| `BLUEBUBBLES_DM_POLICY` | No | DM policy (e.g., `allow`, `deny`, `allowlist`) |
| `BLUEBUBBLES_ALLOW_FROM` | No | Comma-separated allowed sender list |
| `BLUEBUBBLES_GROUP_POLICY` | No | Group message policy |
| `BLUEBUBBLES_GROUP_ALLOW_FROM` | No | Comma-separated allowed group list |
| `BLUEBUBBLES_WEBHOOK_PATH` | No | Webhook endpoint path |
| `BLUEBUBBLES_SEND_READ_RECEIPTS` | No | Send read receipts for incoming messages |

## Full Configuration Reference

All fields are defined under `connectors.bluebubbles` in `eliza.json`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverUrl` | string | — | BlueBubbles server URL (required) |
| `password` | string | — | Server password (required) |
| `enabled` | boolean | — | Explicitly enable/disable |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy |
| `allowFrom` | string[] | — | User IDs allowed to DM |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Group message policy |
| `groupAllowFrom` | string[] | — | Allowed group IDs |
| `webhookPath` | string | — | Webhook path for inbound messages |
| `sendReadReceipts` | boolean | — | Send read receipts for incoming messages |

## Auto-Enable Mechanism

The `plugin-auto-enable.ts` module checks `connectors.bluebubbles` in your config. If both `serverUrl` and `password` are truthy (and `enabled` is not explicitly `false`), the runtime automatically loads `@elizaos/plugin-bluebubbles`.

No environment variable is required to trigger auto-enable -- it is driven entirely by the connector config object.

## Setup Steps

1. Install [BlueBubbles](https://bluebubbles.app) on a Mac with Messages signed in.
2. Start the BlueBubbles server and note the server URL and password.
3. Add the server URL and password to `connectors.bluebubbles` in your config.
4. Start your agent -- the connector auto-enables when both fields are present.

## Features

- iMessage send and receive via BlueBubbles server
- DM and group chat support
- Read receipt support
- Webhook-based inbound message handling
- DM and group access policies

## Related

- [BlueBubbles plugin reference](/plugin-registry/platform/bluebubbles)
- [iMessage Connector](/connectors/imessage) — Native iMessage connector (macOS only, reads Messages database directly)
- [Blooio Connector](/connectors/blooio) — iMessage/SMS via Blooio cloud service
- [Connectors overview](/guides/connectors)
