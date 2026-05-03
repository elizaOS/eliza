---
title: "Platform Connectors"
sidebarTitle: "Connectors"
description: "Platform bridges for 29 messaging platforms — 19 auto-enabled from config (Discord, Telegram, Slack, WhatsApp, Signal, iMessage, Blooio, BlueBubbles, MS Teams, Google Chat, Twitter, Farcaster, Twitch, Mattermost, Matrix, Feishu, Nostr, Lens, WeChat) plus 10 installable from the registry (Bluesky, Instagram, LINE, Zalo, Zalo User, Twilio, GitHub, Gmail Watch, Nextcloud Talk, Tlon)."
---

Connectors are platform bridges that allow your agent to communicate across messaging platforms and social networks. Each connector handles authentication, message routing, session management, and platform-specific features.

## Table of Contents

**Connector Plugins**

1. [Supported Platforms](#supported-platforms)
2. [General Configuration](#general-configuration)

**Auto-enabled connectors** (load when config is present):

3. [Discord](#discord)
4. [Telegram](#telegram)
5. [Slack](#slack)
6. [WhatsApp](#whatsapp)
7. [Signal](#signal)
8. [iMessage](#imessage)
9. [Blooio](#blooio)
10. [Microsoft Teams](#microsoft-teams)
11. [Google Chat](#google-chat)
12. [Twitter](#twitter)
13. [Farcaster](#farcaster)
14. [Twitch](#twitch)
15. [Mattermost](#mattermost)
16. [WeChat](#wechat)
17. [Matrix](#matrix)
18. [Feishu / Lark](#feishu--lark)
19. [Nostr](#nostr)
20. [Lens](#lens)

**Registry connectors** (install with `eliza plugins install <name>`):

21. [Bluesky](#bluesky)
22. [Instagram](#instagram)
23. [LINE](#line)
24. [Zalo](#zalo)
25. [Twilio](#twilio)
26. [GitHub](#github)
27. [Gmail Watch](#gmail-watch)
28. [Nextcloud Talk](#nextcloud-talk)
29. [Tlon](#tlon)

**Reference:**

30. [Connector Lifecycle](#connector-lifecycle)
31. [Multi-Account Support](#multi-account-support)
32. [Session Management](#session-management)

---

## Supported Platforms

Connectors marked **Auto** load automatically when their config is present in `eliza.json`. Connectors marked **Registry** must be installed first with `eliza plugins install <package>`. Connectors marked **Upstream** are available from the upstream elizaOS registry but are not bundled — install them explicitly with `eliza plugins install <package>` before configuring.

| Platform | Auth Method | DM Support | Group Support | Multi-Account | Availability |
|----------|------------|------------|---------------|---------------|-------------|
| Discord | Bot token | Yes | Yes (guilds/channels) | Yes | Auto |
| Telegram | Bot token | Yes | Yes (groups/topics) | Yes | Auto |
| Slack | Bot + App tokens | Yes | Yes (channels/threads) | Yes | Auto |
| WhatsApp | QR code (Baileys) or Cloud API | Yes | Yes | Yes | Auto |
| Signal | signal-cli HTTP API | Yes | Yes | Yes | Auto |
| iMessage | Native CLI (macOS) | Yes | Yes | Yes | Auto |
| Microsoft Teams | App ID + password | Yes | Yes (teams/channels) | No | Auto |
| Google Chat | Service account | Yes | Yes (spaces) | Yes | Auto |
| Twitter | API keys + tokens | DMs | N/A | No | Registry |
| Farcaster | Neynar API key + signer | Casts | Yes (channels) | No | Auto |
| Twitch | Client ID + access token | Yes (chat) | Yes (channels) | No | Auto |
| Mattermost | Bot token | Yes | Yes (channels) | No | Auto |
| WeChat | Proxy API key + QR code | Yes | Yes | Yes | Upstream |
| Matrix | Access token | Yes | Yes (rooms) | No | Auto |
| Feishu / Lark | App ID + secret | Yes | Yes (group chats) | No | Auto |
| Nostr | Private key (nsec/hex) | Yes (NIP-04) | N/A | No | Auto |
| Lens | API key | Yes | N/A | No | Auto (planned) |
| BlueBubbles | Server password | Yes | Yes | No | Auto |
| Bluesky | Account credentials | Posts | N/A | No | Registry |
| Instagram | Username + password | DMs | N/A | No | Registry |
| LINE | Channel access token + secret | Yes | Yes | No | Registry |
| Zalo | Access token | Yes | Yes | No | Registry |
| Zalo User | Cookie session | Yes | No | No | Registry |
| Twilio | Account SID + auth token | SMS/Voice | N/A | No | Registry |
| GitHub | API token | Issues/PRs | Yes (repos) | No | Registry |
| Gmail Watch | Service account / OAuth | N/A | N/A | No | Registry |
| Nextcloud Talk | Server credentials | Yes | Yes (rooms) | No | Registry |
| Tlon | Ship credentials | Yes | Yes (Urbit chats) | No | Registry |
| Zalouser | User credentials | Yes | N/A | No | Registry |

---

## General Configuration

Connectors are configured in the `connectors` section of `eliza.json`. Common fields shared across most connectors:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable or disable the connector |
| `dmPolicy` | string | DM acceptance: `"pairing"` (default), `"allowlist"`, `"open"`, or `"disabled"` |
| `allowFrom` | string[] | Allowlist of user IDs (required when `dmPolicy: "open"`, must include `"*"`) |
| `groupPolicy` | string | Group message policy: `"allowlist"` (default), `"open"`, or `"disabled"` |
| `groupAllowFrom` | string[] | Allowlist of group IDs |
| `historyLimit` | number | Max messages to load from conversation history |
| `dmHistoryLimit` | number | Max messages for DM history |
| `textChunkLimit` | number | Max characters per message chunk |
| `chunkMode` | string | `"length"` or `"newline"` -- how to split long messages |
| `blockStreaming` | boolean | Disable streaming responses |
| `mediaMaxMb` | number | Max media attachment size in MB |
| `configWrites` | boolean | Allow the agent to modify its own config |
| `capabilities` | string[] | Feature flags for this connector |
| `markdown` | object | Markdown rendering settings |
| `heartbeat` | object | Channel heartbeat visibility settings |

---

## Discord

### Setup Requirements

- Discord bot token (from Discord Developer Portal)
- Bot must be invited to target servers with appropriate permissions

### Key Configuration

```json
{
  "connectors": {
    "discord": {
      "enabled": true,
      "botToken": "BOT_TOKEN",
      "groupPolicy": "allowlist",
      "guilds": {
        "SERVER_ID": {
          "requireMention": true,
          "channels": {
            "CHANNEL_ID": {
              "allow": true,
              "requireMention": false
            }
          }
        }
      },
      "dm": {
        "enabled": true,
        "policy": "pairing"
      }
    }
  }
}
```

### Features

- Per-guild and per-channel configuration
- DM policy with allowlists
- Reaction notifications (`off`, `own`, `all`, `allowlist`)
- Execution approvals with designated approver users
- PluralKit integration
- Reply-to mode configuration
- Intent configuration (presence, guild members)
- Actions: reactions, stickers, emoji uploads, polls, permissions, messages, threads, pins, search, member/role/channel info, voice status, events, moderation, presence

---

## Telegram

### Setup Requirements

- Bot token from @BotFather

### Key Configuration

```json
{
  "connectors": {
    "telegram": {
      "enabled": true,
      "botToken": "BOT_TOKEN",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groups": {
        "GROUP_ID": {
          "requireMention": true,
          "topics": {
            "TOPIC_ID": {
              "enabled": true
            }
          }
        }
      }
    }
  }
}
```

### Features

- Per-group and per-topic configuration
- Custom slash commands with validation
- Inline buttons (scope: `off`, `dm`, `group`, `all`, `allowlist`)
- Webhook mode (with webhook URL, secret, and path)
- Stream mode (`off`, `partial`, `block`)
- Reaction notifications and reaction levels
- Link preview control
- Network configuration (auto-select family)
- Proxy support

---

## Slack

### Setup Requirements

- Bot token (`xoxb-...`)
- App token (`xapp-...`) for Socket Mode
- Signing secret (for HTTP mode)

### Key Configuration

```json
{
  "connectors": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>",
      "groupPolicy": "allowlist",
      "channels": {
        "CHANNEL_ID": {
          "allow": true,
          "requireMention": true
        }
      }
    }
  }
}
```

### Features

- Socket Mode or HTTP mode
- Per-channel configuration with allowlists
- Thread-aware history (thread or channel scope)
- User token support (read-only by default)
- Slash command integration (with ephemeral response option)
- Reply-to mode by chat type (direct, group, channel)
- DM group channels support
- Actions: reactions, messages, pins, search, permissions, member info, channel info, emoji list

---

## WhatsApp

### Setup Requirements

- Baileys: No external credentials needed (QR code scan)
- Cloud API: WhatsApp Business API access token and phone number ID

### Key Configuration

```json
{
  "connectors": {
    "whatsapp": {
      "accounts": {
        "default": {
          "enabled": true,
          "authDir": "./auth/whatsapp"
        }
      },
      "dmPolicy": "pairing",
      "sendReadReceipts": true,
      "debounceMs": 0
    }
  }
}
```

### Features

- Per-account auth directory for Baileys session persistence
- Self-chat mode for testing
- Message prefix for outgoing messages
- Acknowledgment reactions (configurable emoji, DM/group behavior)
- Debounce for rapid messages
- Per-group configuration with mention requirements
- Actions: reactions, send message, polls

See the [WhatsApp Integration Guide](/guides/whatsapp) for detailed setup instructions.

---

## Signal

### Setup Requirements

- signal-cli running in HTTP/JSON-RPC mode
- Registered Signal account

### Key Configuration

```json
{
  "connectors": {
    "signal": {
      "enabled": true,
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "dmPolicy": "pairing"
    }
  }
}
```

### Features

- HTTP URL or host/port configuration
- CLI path with optional auto-start
- Startup timeout configuration (1-120 seconds)
- Receive mode (`on-start` or `manual`)
- Attachment and story handling options
- Read receipt support
- Reaction notifications and levels

---

## iMessage

### Setup Requirements

- macOS with iMessage configured
- CLI tool for iMessage access (e.g., `imessage-exporter`)

### Key Configuration

```json
{
  "connectors": {
    "imessage": {
      "enabled": true,
      "cliPath": "/usr/local/bin/imessage-exporter",
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

> **Auto-enable note:** The connector auto-enables when `cliPath` is set. Without it, the plugin will not load.

**Environment variables:** `IMESSAGE_CLI_PATH`, `IMESSAGE_DB_PATH`, `IMESSAGE_ENABLED`, `IMESSAGE_DM_POLICY`, `IMESSAGE_ALLOW_FROM`, `IMESSAGE_GROUP_POLICY`, `IMESSAGE_POLL_INTERVAL_MS`

### Features

- Service selection: `imessage`, `sms`, or `auto`
- CLI path and database path configuration
- Remote host support
- Region configuration
- Attachment inclusion toggle
- Per-group mention and tool configuration

---

## BlueBubbles

Connects to iMessage through a self-hosted [BlueBubbles](https://bluebubbles.app) server running on macOS. Unlike the direct iMessage connector, BlueBubbles is network-accessible — the agent does not need to run on the same Mac as iMessage.

### Setup Requirements

- A Mac with iMessage signed in and [BlueBubbles server](https://bluebubbles.app) installed
- The server password and URL reachable from the machine running Eliza

### Key Configuration

```json
{
  "connectors": {
    "bluebubbles": {
      "password": "YOUR_BLUEBUBBLES_PASSWORD",
      "serverUrl": "http://192.168.1.50:1234"
    }
  }
}
```

**Environment variables:** `BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_SERVER_URL`

### Features

- Send and receive iMessages and SMS through a local BlueBubbles server
- Tapback reactions (add and remove)
- Reply to specific messages in threads
- Edit and unsend sent messages (macOS version dependent)
- Send attachments with captions and iMessage effects
- Group chat participant management
- Read receipt support
- Webhook-based inbound message handling

See the [BlueBubbles connector reference](/connectors/bluebubbles) for the full configuration reference.

---

## Blooio

> **Note:** Blooio is a **feature plugin** (`@elizaos/plugin-blooio`), not a connector-category plugin in the registry. It provides iMessage/SMS integration via the Blooio bridge service.

Connects to iMessage and SMS messaging via the Blooio service with signed webhooks.

### Setup Requirements

- Blooio API key
- Webhook URL for receiving messages

### Key Configuration

```json
{
  "connectors": {
    "blooio": {
      "enabled": true,
      "apiKey": "YOUR_BLOOIO_API_KEY",
      "webhookUrl": "https://your-domain.com/blooio/webhook"
    }
  }
}
```

**Environment variables:** `BLOOIO_API_KEY`, `BLOOIO_WEBHOOK_URL`, `BLOOIO_BASE_URL`, `BLOOIO_FROM_NUMBER`, `BLOOIO_WEBHOOK_PATH`, `BLOOIO_WEBHOOK_PORT`, `BLOOIO_WEBHOOK_SECRET`, `BLOOIO_SIGNATURE_TOLERANCE_SEC`

### Features

- iMessage and SMS messaging via Blooio bridge
- Signed webhook verification for inbound messages
- Outbound message sending
- Auto-enabled when `apiKey` is configured

---

## Microsoft Teams

### Setup Requirements

- Azure Bot registration (App ID and App Password)
- Tenant ID

### Key Configuration

```json
{
  "connectors": {
    "msteams": {
      "enabled": true,
      "botToken": "APP_PASSWORD",
      "appId": "APP_ID",
      "appPassword": "APP_PASSWORD",
      "tenantId": "TENANT_ID",
      "dmPolicy": "pairing"
    }
  }
}
```

> **Auto-enable note:** The connector auto-enables when `botToken`, `token`, or `apiKey` is present in the config. Set `botToken` to the app password to trigger auto-enable.

**Environment variables:** `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`, `MSTEAMS_ENABLED`, `MSTEAMS_MEDIA_MAX_MB`, `MSTEAMS_WEBHOOK_PATH`, `MSTEAMS_WEBHOOK_PORT`, `MSTEAMS_ALLOWED_TENANTS`, `MSTEAMS_SHAREPOINT_SITE_ID`

### Features

- Per-team and per-channel configuration
- Reply style configuration
- Webhook port and path settings
- Media host allowlists (for downloading and auth)
- SharePoint site ID for file uploads in group chats
- Up to 100MB media support (OneDrive upload)

---

## Google Chat

### Setup Requirements

- Google Cloud service account with Chat API access
- Service account JSON key file or inline config

### Key Configuration

```json
{
  "connectors": {
    "googlechat": {
      "enabled": true,
      "apiKey": "placeholder",
      "serviceAccountFile": "./service-account.json",
      "audienceType": "project-number",
      "audience": "123456789",
      "webhookPath": "/google-chat"
    }
  }
}
```

> **Auto-enable note:** Google Chat uses service-account auth, not a traditional API key. Include `"apiKey": "placeholder"` to trigger auto-enable — the actual authentication uses the service account file.

**Environment variables:** `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`, `GOOGLE_CHAT_AUDIENCE`, `GOOGLE_CHAT_AUDIENCE_TYPE`, `GOOGLE_CHAT_BOT_USER`, `GOOGLE_CHAT_SPACES`, `GOOGLE_CHAT_ENABLED`, `GOOGLE_CHAT_WEBHOOK_PATH`, `GOOGLE_CHAT_REQUIRE_MENTION`

### Features

- Service account auth (file path or inline JSON)
- Audience type configuration (`app-url` or `project-number`)
- Webhook path and URL configuration
- Per-group configuration with mention requirements
- Typing indicator modes (`none`, `message`, `reaction`)
- DM policy with group chat support

---

## Twitter

Install from the registry before configuring: `eliza plugins install @elizaos/plugin-x`

### Setup Requirements

- Twitter API v2 credentials (API key, API secret key, access token, access token secret)

### Key Configuration

```json
{
  "connectors": {
    "twitter": {
      "enabled": true,
      "apiKey": "...",
      "apiSecretKey": "...",
      "accessToken": "...",
      "accessTokenSecret": "...",
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

### Features

- Automated posting with configurable intervals and variance
- Post immediately option
- Search and mention monitoring
- Timeline algorithm selection (`weighted` or `latest`)
- Auto-respond to mentions
- Action processing toggle
- Dry run mode for testing
- Configurable max tweet length (default: 4000)

---

## Farcaster

### Setup Requirements

- Neynar API key (from [neynar.com](https://neynar.com))
- Farcaster account with a Neynar signer UUID
- Farcaster ID (FID) of the agent account

| Env Variable | Description |
|-------------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | Neynar API key (alternative to config) |

### Key Configuration

```json
{
  "connectors": {
    "farcaster": {
      "enabled": true,
      "apiKey": "YOUR_NEYNAR_API_KEY",
      "signerUuid": "YOUR_SIGNER_UUID",
      "fid": 12345,
      "channels": ["ai", "agents"],
      "castIntervalMin": 120,
      "castIntervalMax": 240
    }
  }
}
```

**Environment variables:** `FARCASTER_NEYNAR_API_KEY`, `FARCASTER_SIGNER_UUID`, `FARCASTER_FID`, `FARCASTER_HUB_URL`, `FARCASTER_POLL_INTERVAL`, `FARCASTER_DRY_RUN`, `FARCASTER_MODE`, `ENABLE_CAST`, `CAST_IMMEDIATELY`, `CAST_INTERVAL_MIN`, `CAST_INTERVAL_MAX`, `MAX_CAST_LENGTH`, `ACTION_INTERVAL`, `ENABLE_ACTION_PROCESSING`, `MAX_ACTIONS_PROCESSING`

### Features

- Autonomous casting (posting) at configurable intervals
- Reply to @mentions and cast replies
- Channel monitoring and participation
- Reactions (likes and recasts)
- Direct casts (private messages)
- On-chain identity tied to Ethereum address
- Cast thread splitting for messages over 320 characters

---

## BlueBubbles

### Setup Requirements

- A Mac with Messages signed in and [BlueBubbles](https://bluebubbles.app) server running
- BlueBubbles server URL and password

### Key Configuration

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

**Environment variables:** `BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_SERVER_URL`, `BLUEBUBBLES_ENABLED`, `BLUEBUBBLES_DM_POLICY`, `BLUEBUBBLES_ALLOW_FROM`, `BLUEBUBBLES_GROUP_POLICY`, `BLUEBUBBLES_GROUP_ALLOW_FROM`, `BLUEBUBBLES_WEBHOOK_PATH`, `BLUEBUBBLES_SEND_READ_RECEIPTS`

### Features

- iMessage send/receive via BlueBubbles HTTP API
- DM and group chat support
- Read receipts
- Webhook-based inbound messages
- Network-accessible (works from any machine, not just the Mac running Messages)

**Auto-enable:** The connector auto-enables when both `serverUrl` and `password` are set in the connector config. No manual install is required.

**Docs:** [BlueBubbles connector](/connectors/bluebubbles)

---

## Bluesky

### Setup Requirements

- Bluesky account credentials (handle and app password)

### Key Configuration

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true,
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

**Environment variables:** `BLUESKY_HANDLE`, `BLUESKY_PASSWORD`, `BLUESKY_ENABLED`, `BLUESKY_DRY_RUN`, `BLUESKY_SERVICE`, `BLUESKY_ENABLE_DMS`, `BLUESKY_ENABLE_POSTING`, `BLUESKY_POLL_INTERVAL`, `BLUESKY_ACTION_INTERVAL`, `BLUESKY_MAX_POST_LENGTH`, `BLUESKY_POST_IMMEDIATELY`, `BLUESKY_POST_INTERVAL_MIN`, `BLUESKY_POST_INTERVAL_MAX`, `BLUESKY_MAX_ACTIONS_PROCESSING`, `BLUESKY_ENABLE_ACTION_PROCESSING`

### Features

- Post creation at configurable intervals
- Mention and reply monitoring
- Dry run mode for testing
- AT Protocol-based decentralized social networking

This connector auto-enables when its configuration is present in `eliza.json`.

---

## Instagram

### Setup Requirements

- Instagram account credentials (username and password)

### Key Configuration

```json
{
  "connectors": {
    "instagram": {
      "enabled": true
    }
  }
}
```

**Environment variables:** `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD`, `INSTAGRAM_PROXY`, `INSTAGRAM_VERIFICATION_CODE`

### Features

- Media posting with caption generation
- Comment monitoring and response
- DM handling
- Dry run mode for testing
- Configurable posting and polling intervals

This connector auto-enables when its configuration is present in `eliza.json`.

---

## Twitch

### Setup Requirements

- Twitch application Client ID and access token
- Twitch channel to connect to

### Key Configuration

```json
{
  "connectors": {
    "twitch": {
      "enabled": true,
      "clientId": "YOUR_CLIENT_ID",
      "accessToken": "YOUR_ACCESS_TOKEN"
    }
  }
}
```

**Environment variables:** `TWITCH_ACCESS_TOKEN`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REFRESH_TOKEN`, `TWITCH_USERNAME`, `TWITCH_CHANNEL`, `TWITCH_CHANNELS`, `TWITCH_ALLOWED_ROLES`, `TWITCH_REQUIRE_MENTION`

### Features

- Live chat monitoring and response
- Channel event handling
- Audience interaction management
- Auto-enabled when `clientId` or `accessToken` is configured

---

## Mattermost

### Setup Requirements

- Mattermost bot token (from System Console > Integrations > Bot Accounts)
- Mattermost server URL

### Key Configuration

```json
{
  "connectors": {
    "mattermost": {
      "enabled": true,
      "botToken": "YOUR_BOT_TOKEN",
      "baseUrl": "https://chat.example.com",
      "chatmode": "all",
      "requireMention": false
    }
  }
}
```

**Environment variables:** `MATTERMOST_BOT_TOKEN`, `MATTERMOST_SERVER_URL`, `MATTERMOST_ENABLED`, `MATTERMOST_TEAM_ID`, `MATTERMOST_DM_POLICY`, `MATTERMOST_GROUP_POLICY`, `MATTERMOST_ALLOWED_USERS`, `MATTERMOST_ALLOWED_CHANNELS`, `MATTERMOST_REQUIRE_MENTION`, `MATTERMOST_IGNORE_BOT_MESSAGES`

### Features

- Channel and DM messaging
- Chat mode restriction (`dm-only`, `channel-only`, or `all`)
- Mention filtering (optionally require @mentions)
- Custom command prefix triggers
- Self-hosted server support

---

## Matrix

### Setup Requirements

- Matrix account on any homeserver (e.g., matrix.org or self-hosted)
- Access token for the bot account

### Key Configuration

```json
{
  "env": {
    "MATRIX_ACCESS_TOKEN": "syt_your_access_token"
  },
  "connectors": {
    "matrix": {
      "enabled": true,
      "token": "syt_your_access_token"
    }
  }
}
```

> **Auto-enable note:** The connector auto-enables when `token`, `botToken`, or `apiKey` is present in the connector config. Setting `"enabled": true` alone is not sufficient — include the `token` field.

**Environment variables:** `MATRIX_ACCESS_TOKEN`, `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_DEVICE_ID`, `MATRIX_ROOMS`, `MATRIX_AUTO_JOIN`, `MATRIX_ENCRYPTION`, `MATRIX_REQUIRE_MENTION`

### Features

- Room and DM messaging on any spec-compliant homeserver
- Auto-join on room invitations
- End-to-end encryption (Olm) support
- Mention filtering in rooms
- Federation support across homeservers

---

## Feishu / Lark

### Setup Requirements

- Feishu/Lark Custom App with App ID and App Secret
- Bot capability enabled on the app

### Key Configuration

```json
{
  "env": {
    "FEISHU_APP_ID": "cli_your_app_id",
    "FEISHU_APP_SECRET": "your_app_secret"
  },
  "connectors": {
    "feishu": {
      "enabled": true,
      "apiKey": "your_app_secret"
    }
  }
}
```

> **Auto-enable note:** The connector auto-enables when `apiKey`, `token`, or `botToken` is present in the connector config. Set `apiKey` to the app secret to trigger auto-enable.

**Environment variables:** `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`, `FEISHU_ALLOWED_CHATS`

### Features

- Direct bot messaging and group chats
- Chat allowlist for access control
- China (`feishu.cn`) and global (`larksuite.com`) domain support
- Event subscription for real-time messages

---

## Nostr

### Setup Requirements

- Nostr private key (nsec or hex format)

### Key Configuration

```json
{
  "env": {
    "NOSTR_PRIVATE_KEY": "nsec1your_private_key"
  },
  "connectors": {
    "nostr": {
      "enabled": true,
      "token": "placeholder"
    }
  }
}
```

> **Auto-enable note:** Nostr uses key-based auth, not a traditional token. Include `"token": "placeholder"` in the connector config to trigger auto-enable — the actual authentication uses the `NOSTR_PRIVATE_KEY` environment variable.

**Environment variables:** `NOSTR_PRIVATE_KEY`, `NOSTR_RELAYS`, `NOSTR_DM_POLICY`, `NOSTR_ALLOW_FROM`, `NOSTR_ENABLED`

### Features

- Multi-relay connectivity
- Note publishing (kind 1 events)
- NIP-04 encrypted direct messages
- DM access policies (allow, deny, allowlist)
- Fully decentralized via relay network

---

## LINE

### Setup Requirements

- LINE Channel access token
- LINE Channel secret

### Key Configuration

```json
{
  "connectors": {
    "line": {
      "enabled": true
    }
  }
}
```

**Environment variables:** `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_ENABLED`, `LINE_DM_POLICY`, `LINE_ALLOW_FROM`, `LINE_GROUP_POLICY`, `LINE_WEBHOOK_PATH`

### Features

- Bot messaging and customer conversations
- Rich message types (text, sticker, image, video)
- Group chat support
- Webhook-based event handling

This connector auto-enables when its configuration is present in `eliza.json`.

---

## Zalo

### Setup Requirements

- Zalo Official Account (OA) access token

### Key Configuration

```json
{
  "connectors": {
    "zalo": {
      "enabled": true
    }
  }
}
```

**Environment variables:** `ZALO_ACCESS_TOKEN`, `ZALO_SECRET_KEY`, `ZALO_REFRESH_TOKEN`, `ZALO_APP_ID`, `ZALO_ENABLED`, `ZALO_WEBHOOK_URL`, `ZALO_WEBHOOK_PATH`, `ZALO_WEBHOOK_PORT`, `ZALO_PROXY_URL`, `ZALO_USE_POLLING`

### Features

- Official account messaging and support workflows
- Webhook-based message handling
- Customer interaction management

A personal-account variant is also available — see [Zalo User](#zalo-user) below.

This connector auto-enables when its configuration is present in `eliza.json`.

---

## Zalo User

### Setup Requirements

- Zalo personal account session (cookie-based authentication)

### Key Configuration

```json
{
  "connectors": {
    "zalouser": {
      "enabled": true,
      "cookiePath": "./auth/zalouser"
    }
  }
}
```

**Environment variables:** `ZALOUSER_COOKIE_PATH`, `ZALOUSER_IMEI`, `ZALOUSER_USER_AGENT`, `ZALOUSER_DM_POLICY`, `ZALOUSER_GROUP_POLICY`, `ZALOUSER_ALLOWED_THREADS`, `ZALOUSER_LISTEN_TIMEOUT`

### Features

- Personal account one-to-one messaging (not Official Account)
- Cookie-based session persistence
- DM and group policy controls

**Note:** This is the personal-account variant of the [Zalo](#zalo) connector. Install it with `eliza plugins install @elizaos/plugin-zalouser`.

---

## Twilio

### Setup Requirements

- Zalo personal account credentials (IMEI and session cookie)

### Key Configuration

```json
{
  "connectors": {
    "zalouser": {
      "enabled": true
    }
  }
}
```

**Environment variables:** `ZALOUSER_IMEI`, `ZALOUSER_PROFILES`, `ZALOUSER_COOKIE_PATH`, `ZALOUSER_USER_AGENT`, `ZALOUSER_DEFAULT_PROFILE`

### Features

- Personal-account one-to-one messaging (unlike the Official Account variant)
- DM and group policy controls (`ZALOUSER_DM_POLICY`, `ZALOUSER_GROUP_POLICY`)
- Multi-profile support via `ZALOUSER_PROFILES`
- Thread allowlisting via `ZALOUSER_ALLOWED_THREADS`

**Note:** This connector is available from the plugin registry. Install it with `eliza plugins install @elizaos/plugin-zalouser`.

---

## Zalo User

A personal-account variant of the Zalo connector for one-to-one messaging outside of the Official Account system.

> **Note:** Twilio is a **feature plugin** (`@elizaos/plugin-twilio`), not a connector-category plugin in the registry. It provides SMS and voice call capabilities.

### Setup Requirements

- Zalo account cookie file for authentication

### Key Configuration

```json
{
  "connectors": {
    "zalouser": {
      "enabled": true
    }
  }
}
```

**Config keys:** `ZALOUSER_COOKIE_PATH`, `ZALOUSER_IMEI`, `ZALOUSER_USER_AGENT`, `ZALOUSER_DM_POLICY`, `ZALOUSER_GROUP_POLICY`, `ZALOUSER_ALLOWED_THREADS`

### Features

- Personal account messaging (outside Official Account)
- DM and group policy controls
- Profile configuration
- Thread allowlists

**Note:** This connector is available from the plugin registry. Install it with `eliza plugins install @elizaos/plugin-zalouser`.

---

## Nextcloud Talk

### Setup Requirements

- Nextcloud server URL and credentials

### Key Configuration

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

**Environment variables:** `NEXTCLOUD_URL`, `NEXTCLOUD_ENABLED`, `NEXTCLOUD_BOT_SECRET`, `NEXTCLOUD_WEBHOOK_HOST`, `NEXTCLOUD_WEBHOOK_PATH`, `NEXTCLOUD_WEBHOOK_PORT`, `NEXTCLOUD_ALLOWED_ROOMS`, `NEXTCLOUD_WEBHOOK_PUBLIC_URL`

### Features

- Room-based messaging
- DM and group conversation support
- Self-hosted collaboration platform integration
- Webhook-based message delivery

**Note:** This connector is available from the plugin registry. Install it with `eliza plugins install @elizaos/plugin-nextcloud-talk`.

---

## Tlon

### Setup Requirements

- Tlon ship credentials (Urbit ship name and access code)

### Key Configuration

```json
{
  "connectors": {
    "tlon": {
      "enabled": true
    }
  }
}
```

**Environment variables:** `TLON_SHIP`, `TLON_CODE`, `TLON_URL`, `TLON_ENABLED`, `TLON_DM_ALLOWLIST`, `TLON_GROUP_CHANNELS`, `TLON_AUTO_DISCOVER_CHANNELS`

### Features

- Urbit-based chat and social interactions
- Ship-to-ship messaging
- Group chat participation

**Note:** This connector is available from the plugin registry. Install it with `eliza plugins install @elizaos/plugin-tlon`.

---

## Connector Lifecycle

The typical connector lifecycle follows this pattern:

1. **Install plugin** -- Connector plugins are installed as `@elizaos/plugin-{platform}` packages
2. **Configure** -- Add the platform configuration to the `connectors` section of `eliza.json`
3. **Enable** -- Set `enabled: true` in the connector config
4. **Authenticate** -- Provide credentials (tokens, keys) or complete auth flow (QR code scan)
5. **Run** -- The runtime starts the connector, establishes connections, and begins message handling
6. **Monitor** -- Status probes verify connectivity; reconnection happens automatically on failures

---

## Multi-Account Support

Most connectors support multiple accounts via the `accounts` key. Each account has its own configuration, authentication, and session state:

```json
{
  "connectors": {
    "telegram": {
      "dmPolicy": "pairing",
      "accounts": {
        "main-bot": {
          "enabled": true,
          "botToken": "TOKEN_1"
        },
        "support-bot": {
          "enabled": true,
          "botToken": "TOKEN_2",
          "dmPolicy": "open",
          "allowFrom": ["*"]
        }
      }
    }
  }
}
```

Account-level settings override the base connector settings. Each account runs independently with its own connection, credentials, and session state.

---

## Session Management

All connectors manage sessions that track conversation state across platforms:

- **DM sessions** -- one session per user, governed by `dmPolicy`
- **Group sessions** -- one session per group/channel, governed by `groupPolicy`
- **History** -- configurable message history depth per session type (`historyLimit`, `dmHistoryLimit`)
- **DM configurations** -- per-user DM overrides via the `dms` record

The `dmPolicy` options are:

| Policy | Behavior |
|--------|----------|
| `pairing` | Default. Agent responds after a pairing/onboarding flow. |
| `allowlist` | Agent responds only to users in the `allowFrom` list. |
| `open` | Agent responds to all DMs. Requires `allowFrom: ["*"]`. |
| `disabled` | Agent does not respond to DMs. |

---

## Connector Operations Runbook

### Setup Checklist

1. Configure connector credentials under `connectors.<name>`.
2. Enable connector plugin loading via connector config or plugin allow-list.
3. Validate DM/group policy values and allow-lists before enabling `open` policies.
4. For each connector, confirm the platform bot/app is created and tokens are valid (see platform-specific notes below).
5. Test connectivity in `pairing` mode before switching to `open` mode.

### Failure Modes

**General connector failures:**

- Connector plugin not loading:
  Check connector ID mapping in `eliza/packages/agent/src/config/plugin-auto-enable.ts`, plugin availability, and `plugins.entries` overrides. The auto-enable layer maps connector config keys to plugin package names — a mismatch means the plugin is silently skipped.
- Auth succeeds but no messages arrive:
  Check platform webhook/socket settings and policy gates (`dmPolicy`, `groupPolicy`). For webhook-based connectors, confirm the callback URL is publicly reachable.
- Misrouted connector secrets:
  Confirm expected env vars are populated from config and not overwritten by stale env. The config schema merges env vars with file config — env takes precedence.

**Discord:**

- Bot token rejected (`401 Unauthorized`):
  Regenerate the bot token in the Discord Developer Portal. Tokens are invalidated if the bot's password is reset or the token is leaked and auto-revoked.
- Bot is online but does not respond in channels:
  Check that the bot has `MESSAGE_CONTENT` intent enabled in the Developer Portal and the `groupPolicy` is not `closed`. Confirm the bot has `Send Messages` permission in the target channel.
- Rate limited (`429 Too Many Requests`):
  Discord rate limits are per-route. The connector should back off automatically. If persistent, reduce message frequency or check for message loops (bot replying to itself).

**Telegram:**

- Webhook not receiving updates:
  Telegram requires HTTPS with a valid certificate. Use `getWebhookInfo` to check status. If using long polling, confirm no other process is polling the same bot token (Telegram allows only one consumer).
- Bot token expired or revoked:
  Re-create the bot via BotFather and update `TELEGRAM_BOT_TOKEN`. Telegram tokens do not expire automatically but can be revoked.
- Messages delayed or missing:
  Telegram buffers updates for up to 24 hours if the webhook is unreachable. After restoring connectivity, a burst of backlogged messages may arrive.

**Slack:**

- `invalid_auth` or `token_revoked`:
  Reinstall the Slack app to the workspace. Bot tokens are revoked when the app is uninstalled or workspace permissions change.
- Events not arriving:
  Confirm the Events API subscription includes the required event types (`message.im`, `message.channels`). Check the Slack app's Request URL is verified and receiving challenge responses.

**WhatsApp:**

- QR pairing fails or session drops:
  WhatsApp Web sessions expire after extended inactivity. Re-pair by scanning a new QR code via `POST /api/whatsapp/pair`. The `whatsapp-pairing` service manages session state.
- Messages not delivered:
  WhatsApp enforces strict anti-spam policies. If the number is flagged, messages are silently dropped. Confirm the business account is in good standing.
- Multi-account auth directory issues:
  Each WhatsApp account requires its own `authDir` (Baileys multi-file auth state). If multiple accounts share a directory, sessions corrupt each other.

**Signal:**

- Signal CLI not found:
  The connector requires `signal-cli` in PATH or a `cliPath` configured. For HTTP mode, set `httpUrl` or `httpHost`/`httpPort` to point to a running signal-cli REST API.
- Account registration fails:
  Signal requires a verified phone number. Use `signal-cli register` or provide a pre-registered account number via `connectors.signal.account`.
- Multi-account configuration:
  Signal supports multiple accounts via the `accounts` map. Each account must have `account`, `httpUrl`, or `cliPath` set and must not be `enabled: false`.

**iMessage (direct):**

- CLI path not found:
  Requires `cliPath` pointing to a valid iMessage CLI tool. macOS-only — Accessibility permissions are required.

**BlueBubbles:**

- Connection refused or timeout:
  Confirm the BlueBubbles server is running on the target Mac and the `serverUrl` is reachable from the agent machine. Check firewall rules if connecting across the network.
- Password rejected:
  Confirm `connectors.bluebubbles.password` matches the password configured in the BlueBubbles server app on macOS.

**Farcaster:**

- API key invalid:
  Confirm `connectors.farcaster.apiKey` is set. Farcaster hub access requires a valid API key.

**MS Teams:**

- Bot token rejected:
  Teams bots require Azure AD registration. Confirm the bot token is valid and the app has the required permissions in the Azure portal.

**Mattermost:**

- Token authentication fails:
  Confirm `connectors.mattermost.botToken` (env: `MATTERMOST_BOT_TOKEN`) is a valid personal access token or bot token. Check that the Mattermost server URL is configured.

**Google Chat / Feishu:**

- Token authentication fails:
  Both require service account or bot tokens. Confirm the token is valid and has the required chat API scopes.

**Matrix:**

- Homeserver connection fails:
  Confirm the Matrix homeserver URL is reachable and the access token under `connectors.matrix.token` is valid.

**Nostr:**

- Relay connection fails:
  Nostr connectors communicate via relays. Confirm relay URLs are configured and reachable. API key authentication varies by relay.

**Twitch:**

- Authentication fails:
  Confirm `connectors.twitch.accessToken` or `connectors.twitch.clientId` is set. Alternatively, set `enabled: true` to force-enable. Ensure the access token has the required chat scopes.

**BlueBubbles:**

- Server connection fails:
  Confirm `BLUEBUBBLES_SERVER_URL` points to a running BlueBubbles server and `BLUEBUBBLES_PASSWORD` is correct. The server must be reachable from the machine running Eliza.

**Blooio:**

- Authentication fails:
  Blooio uses `apiKey`. Confirm credentials are set under the connector config.

**Bluesky:**

- Authentication fails:
  Confirm `BLUESKY_HANDLE` and `BLUESKY_PASSWORD` environment variables are set. Bluesky uses app passwords, not your main account password. Generate an app password at bsky.app/settings/app-passwords.

**Instagram:**

- Login fails or account locked:
  Instagram may require verification for automated logins. Set `INSTAGRAM_VERIFICATION_CODE` if 2FA is enabled. Use `INSTAGRAM_PROXY` to reduce rate-limit bans. Avoid frequent login attempts which can trigger account locks.

**BlueBubbles:**

- Cannot connect to server:
  Confirm `BLUEBUBBLES_PASSWORD` and `BLUEBUBBLES_SERVER_URL` are correct. The BlueBubbles server must be running on macOS and reachable from the agent host.

**LINE:**

- Webhook not receiving messages:
  Confirm `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` are set. The webhook URL must be publicly reachable with HTTPS.

**Twilio:**

- SMS not sending:
  Confirm `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` are set. Check that the phone number is SMS-capable and the account has sufficient balance.

**GitHub:**

- API token rejected:
  Confirm `GITHUB_API_TOKEN` is a valid personal access token or fine-grained token with the required repository permissions.

### Recovery Procedures

1. **Stale connector session:** Restart the agent. Connectors re-initialize their platform connections on startup. For WebSocket-based connectors (Discord, Slack), this forces a fresh handshake.
2. **Token rotation:** Update the token in `eliza.json` under `connectors.<name>` and restart. Do not edit env vars in a running process — the config is read at startup.
3. **Rate limit recovery:** The agent automatically backs off on 429 responses. If the connector is fully blocked, wait for the rate limit window to expire (typically 1–60 seconds for Discord, varies by platform) and restart.

### Verification Commands

These test paths reference files in the `eliza` submodule. Run `bun run setup:upstreams` first to initialize it.

```bash
# Full test suite (from repo root)
bun run test

# End-to-end tests
bun run test:e2e

bun run typecheck
```
