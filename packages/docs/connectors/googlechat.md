# Google Chat Connector

Connect your agent to Google Chat for DMs and space conversations using the `@elizaos/plugin-google-chat` package.

## Prerequisites

- A Google Cloud project with the Google Chat API enabled
- A service account with Chat Bot permissions

## Configuration

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-google-chat` |
| Registry ID | `google-chat` |
| Config key | `connectors.googlechat` |
| Auto-enable trigger | `botToken`, `token`, or `apiKey` is truthy in connector config |

The connector auto-enables when `botToken`, `token`, or `apiKey` is truthy in the connector config. The `serviceAccountFile`/`audience` fields alone do not trigger auto-enable -- you must include one of the trigger fields or add the plugin to `plugins.allow`.

Configure in `~/.eliza/eliza.json`:

Google Chat authenticates via a service account JSON file, not an API key. The `apiKey` field below is only used to trigger auto-enable — it has no functional role in authentication.

```json
{
  "connectors": {
    "googlechat": {
      "apiKey": "placeholder",
      "serviceAccountFile": "./service-account.json",
      "audienceType": "project-number",
      "audience": "123456789",
      "webhookPath": "/google-chat"
    }
  }
}
```

If you don't want to set a trigger field, add the plugin explicitly:

```json
{
  "plugins": {
    "allow": ["@elizaos/plugin-google-chat"]
  },
  "connectors": {
    "googlechat": {
      "serviceAccountFile": "./service-account.json",
      "audienceType": "project-number",
      "audience": "123456789",
      "webhookPath": "/google-chat"
    }
  }
}
```

To disable:

```json
{
  "connectors": {
    "googlechat": {
      "enabled": false
    }
  }
}
```

## Setup

1. Create a Google Cloud project and enable the Google Chat API.
2. Create a service account with the Chat Bot role.
3. Download the service account key file or configure inline credentials.
4. Configure the Chat app in the Google Cloud Console with an HTTP endpoint pointing to your Eliza instance.
5. Add the credentials and webhook path to your Eliza config.
6. Start your agent.

## Features

## Environment Variables

The following environment variables are supported by the plugin:

| Variable | Description |
|----------|-------------|
| `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` | Path to service account JSON key file |
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | Inline service account JSON |
| `GOOGLE_APPLICATION_CREDENTIALS` | Standard Google Cloud credentials path |
| `GOOGLE_CHAT_AUDIENCE_TYPE` | Authentication audience type (`app-url` or `project-number`) |
| `GOOGLE_CHAT_AUDIENCE` | App URL or project number |
| `GOOGLE_CHAT_BOT_USER` | Bot user identifier |
| `GOOGLE_CHAT_WEBHOOK_PATH` | Webhook endpoint path |
| `GOOGLE_CHAT_SPACES` | Comma-separated list of spaces to join |
| `GOOGLE_CHAT_ENABLED` | Set to `true` to enable |
| `GOOGLE_CHAT_REQUIRE_MENTION` | Only respond when @mentioned |

## Full Configuration Reference

All fields are defined under `connectors.googlechat` in `eliza.json`.

### Core Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serviceAccountFile` | string | — | Path to service account JSON key file |
| `serviceAccount` | string \| object | — | Inline service account JSON (alternative to file) |
| `audienceType` | `"app-url"` \| `"project-number"` | — | Authentication audience type |
| `audience` | string | — | App URL or project number (matches `audienceType`) |
| `name` | string | — | Account display name |
| `enabled` | boolean | — | Explicitly enable/disable |
| `capabilities` | string[] | — | Capability flags |
| `webhookPath` | string | — | Webhook endpoint path (e.g., `/google-chat`) |
| `webhookUrl` | string | — | Full webhook URL override |
| `botUser` | string | — | Bot user identifier |
| `configWrites` | boolean | — | Allow config writes from Google Chat events |
| `allowBots` | boolean | — | Allow interactions from other bots |
| `requireMention` | boolean | — | Only respond when @mentioned |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Group join policy |
| `groupAllowFrom` | (string\|number)[] | — | Allowed group/space IDs |
| `historyLimit` | integer >= 0 | — | Max messages in context |
| `dmHistoryLimit` | integer >= 0 | — | History limit for DMs |
| `dms` | object | — | Per-DM history overrides keyed by DM ID. Each value: `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Max characters per message chunk |
| `chunkMode` | `"length"` \| `"newline"` | — | Long message splitting strategy |
| `mediaMaxMb` | number > 0 | — | Max media file size in MB |
| `blockStreaming` | boolean | — | Disable streaming responses |
| `blockStreamingCoalesce` | object | — | Coalescing settings: `minChars`, `maxChars`, `idleMs` |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Reply threading mode |
| `typingIndicator` | `"none"` \| `"message"` \| `"reaction"` | `"none"` | Typing indicator mode |

### Actions

| Field | Type | Description |
|-------|------|-------------|
| `actions.reactions` | boolean | Send reactions to messages |

### DM Configuration

The `dm` sub-object provides additional DM-level policy:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dm.enabled` | boolean | — | Enable/disable DMs |
| `dm.policy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | DM access policy. `"open"` requires `dm.allowFrom` to include `"*"` |
| `dm.allowFrom` | (string\|number)[] | — | User IDs allowed to DM |

### Group Configuration

Per-group settings are defined under `groups.<group-id>`:

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable this group |
| `allow` | boolean | Allow messages in this group |
| `requireMention` | boolean | Only respond when @mentioned |
| `users` | (string\|number)[] | Allowed user IDs in this group |
| `systemPrompt` | string | Group-specific system prompt |

### Multi-Account Support

The `accounts` field allows running multiple Google Chat bots from a single agent:

```json
{
  "connectors": {
    "googlechat": {
      "accounts": {
        "workspace-1": {
          "serviceAccountFile": "./sa-1.json",
          "audienceType": "project-number",
          "audience": "111111111"
        },
        "workspace-2": {
          "serviceAccountFile": "./sa-2.json",
          "audienceType": "project-number",
          "audience": "222222222"
        }
      },
      "defaultAccount": "workspace-1"
    }
  }
}
```

Account-level settings override the base connector settings. Use `defaultAccount` to specify which account is used when none is explicitly selected.

## Related

- [MS Teams connector](/connectors/msteams)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
