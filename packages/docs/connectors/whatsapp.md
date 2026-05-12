# WhatsApp Connector

Connect your agent to WhatsApp for private chats and group conversations via personal or business accounts using the `@elizaos/plugin-whatsapp` package.

## Prerequisites

- For **Baileys** (personal): A phone with WhatsApp installed (for QR code scanning)
- For **Cloud API** (business): A WhatsApp Business Account and access tokens from the Meta Developer Dashboard

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `WHATSAPP_AUTH_METHOD` | No | Authentication method: `cloudapi` or `baileys` |
| `WHATSAPP_ACCESS_TOKEN` | No | WhatsApp Business API access token (required for `cloudapi` auth) |
| `WHATSAPP_PHONE_NUMBER_ID` | No | Phone number ID from Meta Developer Dashboard (required for `cloudapi` auth) |
| `WHATSAPP_AUTH_DIR` | No | Directory for Baileys session files (required for `baileys` auth) |
| `WHATSAPP_PRINT_QR` | No | Print QR code in terminal when using Baileys auth |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | No | Webhook verification token |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | No | WhatsApp Business Account ID |
| `WHATSAPP_API_VERSION` | No | API version string |
| `WHATSAPP_DM_POLICY` | No | DM policy (e.g., `allow`, `deny`, `allowlist`) |
| `WHATSAPP_GROUP_POLICY` | No | Group message policy |

The connector auto-enables when `authDir`, `authState`, `sessionPath`, or `accounts` with at least one account having `authDir` is present, and `enabled` is not explicitly `false`.

## Minimal Configuration

In `~/.eliza/eliza.json` (Baileys / QR code):

```json
{
  "connectors": {
    "whatsapp": {
      "accounts": {
        "default": {
          "enabled": true,
          "authDir": "./auth/whatsapp"
        }
      }
    }
  }
}
```

Or with a top-level `authDir` (single account shorthand):

```json
{
  "connectors": {
    "whatsapp": {
      "authDir": "./whatsapp-auth"
    }
  }
}
```

## Disabling

To explicitly disable the connector even when auth config is present:

```json
{
  "connectors": {
    "whatsapp": {
      "authDir": "./whatsapp-auth",
      "enabled": false
    }
  }
}
```

## Setup

### Baileys (personal account)

1. Set `authDir` in your connector config (e.g., `"./auth/whatsapp"`).
2. Start Eliza -- a QR code will be printed to the terminal.
3. Scan the QR code with your phone (WhatsApp > Settings > Linked Devices > Link a Device).
4. The session persists automatically across restarts.

### Cloud API (business account)

1. Set up a WhatsApp Business Account in the [Meta Developer Dashboard](https://developers.facebook.com/).
2. Obtain an access token and phone number ID.
3. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_AUTH_METHOD=cloudapi`.
4. Configure a webhook URL pointing to your Eliza instance.
5. Start your agent.

## Authentication Methods

### Baileys (QR Code)

Baileys connects via the WhatsApp Web multi-device protocol. No API keys or business accounts are needed. On first start, a QR code is printed to the terminal. Scan it with your phone (WhatsApp > Settings > Linked Devices > Link a Device) to authenticate.

**Pros**: No API costs, works with personal accounts, full feature access.
**Cons**: Requires a phone with WhatsApp linked, session can expire if phone disconnects.

### Cloud API (Business)

The WhatsApp Business Cloud API is Meta's official API. Requires a WhatsApp Business Account and access tokens from the Meta Developer Dashboard.

**Pros**: Official API, reliable uptime, webhook-based.
**Cons**: Requires business account, per-message costs may apply, approval process.

## Features

- Private and group chat messaging
- Two auth methods: Baileys (QR code, personal) and Cloud API (business)
- Read receipts and acknowledgment reactions
- DM and group access policies
- Media attachments up to 50MB
- Multi-account support
- Self-chat mode for testing
- Session persistence across restarts

## Full Configuration Reference

All fields are defined under `connectors.whatsapp` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accounts` | object | -- | Named account configurations (see Multi-Account below) |
| `authDir` | string | -- | Directory for Baileys session files (single-account shorthand) |
| `enabled` | boolean | -- | Explicitly enable/disable |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM acceptance policy. `"open"` requires `allowFrom` to include `"*"` |
| `allowFrom` | string[] | -- | Allowlist of phone numbers (required when `dmPolicy: "open"`) |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Group message policy |
| `groupAllowFrom` | string[] | -- | Allowlist of group JIDs |
| `historyLimit` | number | -- | Max messages to load from conversation history |
| `dmHistoryLimit` | number | -- | Max messages for DM history |
| `textChunkLimit` | number | -- | Max characters per outgoing message chunk |
| `chunkMode` | `"length"` \| `"newline"` | -- | Long message splitting strategy |
| `mediaMaxMb` | number | `50` | Max media attachment size in MB |
| `sendReadReceipts` | boolean | -- | Send read receipts for incoming messages |
| `selfChatMode` | boolean | -- | Respond to your own messages (for testing; avoid in production) |
| `messagePrefix` | string | -- | Text prefix added to all outgoing messages |
| `debounceMs` | number | `0` | Delay in ms before responding, to allow message batching |
| `blockStreaming` | boolean | -- | Disable streaming responses |
| `groups` | object | -- | Per-group configuration overrides |

### Acknowledgment Reactions

Configure emoji reactions sent as message acknowledgments:

```json
{
  "connectors": {
    "whatsapp": {
      "ackReaction": {
        "emoji": "eyes",
        "direct": true,
        "group": "mentions"
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ackReaction.emoji` | string | -- | Reaction emoji to send as acknowledgment |
| `ackReaction.direct` | boolean | `true` | Send ack reactions in DMs |
| `ackReaction.group` | string | `"mentions"` | Group ack behavior: `"always"`, `"mentions"`, or `"never"` |

### Multi-Account Support

The `accounts` field allows running multiple WhatsApp sessions from a single agent. Each account gets its own Baileys auth directory and QR code pairing flow.

```json
{
  "connectors": {
    "whatsapp": {
      "accounts": {
        "account-1": {
          "enabled": true,
          "authDir": "./auth/whatsapp-1"
        },
        "account-2": {
          "enabled": true,
          "authDir": "./auth/whatsapp-2"
        }
      }
    }
  }
}
```

Each account under `accounts.<name>` supports all top-level fields plus:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable or disable this account |
| `authDir` | string | Directory for Baileys session files (required per account) |
| `name` | string | Display name for this account |

### Self-Chat Mode

When `selfChatMode` is `true`, the agent responds to messages you send to yourself (the "Message Yourself" chat). This is useful for testing without involving other contacts. Avoid enabling in production.

```json
{
  "connectors": {
    "whatsapp": {
      "selfChatMode": true
    }
  }
}
```

## Session Persistence

Baileys saves its session state to the directory specified by `authDir`. This includes:

- Encryption credentials
- Device registration info
- Authentication keys

The session persists across restarts. A new QR code is only generated when:

- The session files in `authDir` are deleted or corrupted
- Your phone revokes the linked device (Settings > Linked Devices > remove)
- The session expires due to prolonged disconnection

**Security considerations**:

- Never commit the auth directory to version control (`auth/` should be in `.gitignore`)
- Back up the auth directory to avoid re-scanning on a new machine
- The auth directory contents grant full access to the linked WhatsApp session

## Troubleshooting

### Plugin Not Loading

Verify that at least one of the auto-enable triggers is present in your config:

- `authDir` at the top level, or
- At least one account under `accounts` with `authDir` set and `enabled: true`

### QR Code Expires

QR codes have a short TTL (typically around 20 seconds). The connector automatically generates a new QR code when the previous one expires. Make sure your phone has internet access when scanning.

### Session Expired

If reconnection fails with a session error:

1. Delete the contents of your `authDir` directory
2. Restart Eliza
3. Scan the new QR code

### `dmPolicy: "open"` Validation Error

When setting `dmPolicy` to `"open"`, you must also set `allowFrom: ["*"]`. This is a safety requirement enforced by the config validator:

```json
{
  "dmPolicy": "open",
  "allowFrom": ["*"]
}
```

### Rate Limits

WhatsApp has undocumented rate limits. If the agent sends messages too rapidly, the connection may be throttled or temporarily banned. Use `debounceMs` to add delays:

```json
{
  "debounceMs": 1000
}
```

## Related

- [WhatsApp setup guide](/guides/whatsapp)
- [WhatsApp plugin reference](/plugin-registry/platform/whatsapp)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
