---
title: "BlueBubbles Plugin"
sidebarTitle: "BlueBubbles"
description: "BlueBubbles connector for sending and receiving iMessage through a local BlueBubbles server"
---

iMessage connector via a local BlueBubbles server.

**Package:** `@elizaos/plugin-bluebubbles`

## Auto-Enable

This plugin auto-enables when both `serverUrl` and `password` are set in the connector config. No manual install is required.

## Auto-Enable

This plugin auto-enables when the `BLUEBUBBLES_SERVER_URL` environment variable is set.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `BLUEBUBBLES_SERVER_URL` | Yes | BlueBubbles server URL |
| `BLUEBUBBLES_PASSWORD` | Yes | Server password |
| `BLUEBUBBLES_ENABLED` | No | Enable or disable the connector |
| `BLUEBUBBLES_DM_POLICY` | No | DM policy (e.g., allow, deny, allowlist) |
| `BLUEBUBBLES_ALLOW_FROM` | No | Comma-separated allowed user list |
| `BLUEBUBBLES_GROUP_POLICY` | No | Group message policy |
| `BLUEBUBBLES_WEBHOOK_PATH` | No | Webhook endpoint path |
| `BLUEBUBBLES_GROUP_ALLOW_FROM` | No | Comma-separated allowed group list |
| `BLUEBUBBLES_SEND_READ_RECEIPTS` | No | Send read receipts for received messages |

## Features

- Send and receive iMessage via BlueBubbles HTTP API
- DM and group chat support
- Read receipts
- Webhook-based inbound messages
- Network-accessible (not limited to the Mac running Messages)

## Related

- [BlueBubbles Connector Setup](/connectors/bluebubbles) — Full configuration reference
- [iMessage Plugin](/plugin-registry/platform/imessage) — Native iMessage connector
- [Blooio Plugin](/plugin-registry/platform/blooio) — iMessage/SMS via Blooio cloud
