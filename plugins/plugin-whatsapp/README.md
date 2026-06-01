# @elizaos/plugin-whatsapp

WhatsApp plugin for elizaOS. Connects Eliza agents to WhatsApp via the **WhatsApp Cloud API** (Meta Business) or **Baileys** (personal account / QR-code auth).

## Capabilities

- Send and receive text messages (inbound messages ingested into agent memory)
- Send emoji reactions, remove reactions
- Support for media captions (image, video, document) on inbound messages
- Interactive message content extraction (button replies, list replies)
- Location and reaction message handling
- Baileys QR-code pairing with session persistence
- Multi-account support (multiple WhatsApp numbers per agent)
- DM and group access policies (open / allowlist / pairing / disabled)
- Webhook verification and `X-Hub-Signature-256` security for Cloud API

## Installation

```bash
npm install @elizaos/plugin-whatsapp
```

## Enabling the Plugin

Add the plugin to your character file:

```typescript
import whatsappPlugin from "@elizaos/plugin-whatsapp";

export const character = {
  // ...
  plugins: [whatsappPlugin],
};
```

The plugin also auto-enables when a `connectors.whatsapp` block is present in agent config.

## Configuration

### Cloud API (Meta Business)

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | Yes | Long-lived access token from Meta Business Manager |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Phone number ID registered in Meta Business |
| `WHATSAPP_APP_SECRET` | Yes (webhooks) | App Secret for `X-Hub-Signature-256` verification on incoming webhook POSTs |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | No | Token for Meta's one-time GET webhook subscribe handshake |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | No | WABA ID (informational only) |
| `WHATSAPP_API_VERSION` | No | Graph API version string (default: `v24.0`) |

### Baileys (personal account / QR auth)

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_AUTH_DIR` | Yes (Baileys) | Directory to persist multi-file Baileys auth state |
| `WHATSAPP_SESSION_PATH` | No | Alternative name for `WHATSAPP_AUTH_DIR` |
| `WHATSAPP_PRINT_QR` | No | Print QR code in terminal during initial pairing |

**Transport detection:** `WHATSAPP_AUTH_DIR` present → Baileys. `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` present → Cloud API. Baileys takes precedence when both are set.

### Access Control

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_DM_POLICY` | `pairing` | `open`, `allowlist`, `pairing`, or `disabled` |
| `WHATSAPP_GROUP_POLICY` | `allowlist` | `open`, `allowlist`, or `disabled` |
| `WHATSAPP_ALLOW_FROM` | — | Comma-separated E.164 numbers allowed in DMs (when policy is `allowlist`) |
| `WHATSAPP_GROUP_ALLOW_FROM` | — | Comma-separated E.164 numbers allowed as group senders |

### Agent Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_AUTO_REPLY` | `false` | When `true`, inbound messages trigger automatic agent replies. Off by default — messages are stored in memory only |

## Usage

### Accessing the Service

```typescript
import type { WhatsAppConnectorService } from "@elizaos/plugin-whatsapp";

const service = runtime.getService<WhatsAppConnectorService>("whatsapp");
```

### Sending a Text Message

```typescript
await service?.sendMessage({
  type: "text",
  to: "+14155552671",  // E.164 format for Cloud API; JID or E.164 for Baileys
  content: "Hello from elizaOS!",
});
```

### Sending a Message with Reply Threading

```typescript
await service?.sendMessage({
  type: "text",
  to: "+14155552671",
  content: "This is a reply",
  replyToMessageId: "wamid.xxxxx",
});
```

### Creating a Low-Level Client

Use `ClientFactory` when you need direct access to Cloud API media endpoints:

```typescript
import { ClientFactory } from "@elizaos/plugin-whatsapp";

// Cloud API
const client = ClientFactory.create({ accessToken: "...", phoneNumberId: "..." });

// Baileys
const client = ClientFactory.create({ authMethod: "baileys", authDir: "./wa-auth" });
```

### Webhook Setup (Cloud API)

The plugin automatically registers these HTTP routes on the agent:

- `GET /api/whatsapp/webhook` — Meta subscription verification (public)
- `POST /api/whatsapp/webhook` — Incoming message delivery (validates `X-Hub-Signature-256`)

Point your Meta App webhook URL to `https://<your-agent-host>/api/whatsapp/webhook`.

### QR Pairing (Baileys)

Start a pairing session via the agent's HTTP API:

```bash
# Start pairing
curl -X POST http://localhost:31337/api/whatsapp/pair \
  -H "Content-Type: application/json" \
  -d '{"accountId": "default"}'

# Check status
curl http://localhost:31337/api/whatsapp/status?accountId=default

# Stop pairing
curl -X POST http://localhost:31337/api/whatsapp/pair/stop \
  -H "Content-Type: application/json" \
  -d '{"accountId": "default"}'

# Logout and remove auth state
curl -X POST http://localhost:31337/api/whatsapp/disconnect \
  -H "Content-Type: application/json" \
  -d '{"accountId": "default"}'
```

## Multi-Account

Configure multiple WhatsApp accounts under `character.settings.whatsapp.accounts.<id>`. Each entry accepts the same fields as the top-level config (`authDir`, `accessToken`, `phoneNumberId`, `dmPolicy`, `groupPolicy`, etc.) plus an optional `name` for display.

## Message Connector Protocol

`WhatsAppConnectorService` registers with the elizaOS message connector system. Supported capabilities: `send_message`, `read_messages`, `search_messages`, `send_reaction`, `contact_resolution`, `chat_context`, `get_user`. Target kinds: `phone`, `contact`, `user`, `group`, `room`.

Use `source: "whatsapp"` when targeting WhatsApp from an orchestrator or workflow.

## Troubleshooting

**Messages not delivered:** Ensure phone numbers are in E.164 format (e.g. `+14155552671`). For Cloud API, bare number strings (no `+`) also work.

**Webhook verification fails:** Confirm `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in your env matches the token configured in the Meta Developer Portal webhook settings.

**Webhook POST rejected (401):** Set `WHATSAPP_APP_SECRET` to the App Secret shown in your Meta App dashboard.

**Baileys QR not appearing:** Set `WHATSAPP_PRINT_QR=true` or use the `/api/whatsapp/pair` endpoint and read the `qr` field from the WebSocket event stream.

**Common Cloud API error codes:**
| Code | Meaning |
|------|---------|
| 130429 | Rate limit reached |
| 131000 | Generic API error |
| 131030 | Invalid recipient |
| 131051 | Unsupported message type |

## License

MIT
