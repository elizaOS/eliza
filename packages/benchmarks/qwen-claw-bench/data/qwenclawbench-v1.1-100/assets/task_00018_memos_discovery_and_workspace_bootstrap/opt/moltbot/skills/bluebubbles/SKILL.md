# BlueBubbles Channel Plugin

Build or update the BlueBubbles external channel plugin for Moltbot (extension package, REST send/probe, webhook inbound).

## When to Use

- Setting up iMessage integration via BlueBubbles server
- Configuring webhook endpoints for incoming iMessage traffic
- Sending outbound messages through the BlueBubbles REST API

## Configuration

Add to `gateway.yaml` under `channels`:

```yaml
channels:
  bluebubbles:
    enabled: true
    server_url: "http://192.168.1.50:1234"
    password: "${BLUEBUBBLES_PASSWORD}"
    webhook_port: 3211
```

## API Endpoints

- `POST /api/v1/message/text` — Send text message
- `GET /api/v1/chat/query` — List conversations  
- `POST /api/v1/server/webhook` — Register webhook

## Webhook Events

- `new-message` — Incoming message received
- `message-send-error` — Outbound delivery failed
- `updated-message` — Message status update (read, delivered)
