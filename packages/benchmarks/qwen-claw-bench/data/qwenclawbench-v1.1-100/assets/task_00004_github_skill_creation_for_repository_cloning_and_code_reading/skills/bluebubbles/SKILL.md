# BlueBubbles Plugin

Build or update the BlueBubbles external channel plugin for Moltbot (extension package, REST send/probe, webhook inbound).

## Overview

Integrates iMessage via BlueBubbles server as an external channel for the Moltbot agent.

## Prerequisites

- BlueBubbles server running on a Mac with iMessage configured
- Server URL and API password
- Network access from the agent host to the BlueBubbles server

## Configuration

```json
{
  "server_url": "http://bluebubbles-host:1234",
  "password": "your-api-password",
  "webhook_port": 8765
}
```

## Capabilities

- **Send**: POST to `/api/v1/message/text` with chat GUID and message
- **Probe**: GET `/api/v1/server/info` to verify connectivity
- **Inbound**: Webhook listener for incoming messages

## Notes

- Requires the BlueBubbles server to be running 24/7 on a macOS machine.
- Webhook URL must be reachable from the BlueBubbles server.
