# @elizaos/plugin-bluebubbles

iMessage and SMS integration for [elizaOS](https://github.com/elizaOS/eliza) agents via the [BlueBubbles](https://bluebubbles.app/) macOS server.

## What it does

This plugin bridges an Eliza agent to iMessage and SMS by connecting to a
BlueBubbles server running on a macOS host. Once configured, the agent can:

- Receive iMessages and SMS via an inbound webhook from BlueBubbles
- Send text messages to iMessage handles, phone numbers, or group chats
- React to messages with emoji reactions
- Reply in-thread to specific messages
- Fetch and search chat history
- Edit and unsend messages (requires BlueBubbles Private API)
- Automatically launch the BlueBubbles app if it is not running (macOS only)

## Prerequisites

1. A Mac running the [BlueBubbles server app](https://bluebubbles.app/).
2. The BlueBubbles server must be reachable from the host running the agent.
3. A webhook URL configured in the BlueBubbles server pointing at
   `POST <agent-base-url>/webhooks/bluebubbles`.

## Installation

The plugin is included in the elizaOS monorepo at `@elizaos/plugin-bluebubbles`.
Add it to your agent's plugin list:

```ts
import blueBubblesPlugin from "@elizaos/plugin-bluebubbles";

// In your character config or runtime setup:
plugins: [blueBubblesPlugin],
```

The plugin **auto-enables** when `config.connectors.bluebubbles` is present
and not explicitly disabled — no manual loading is required in a standard
elizaOS agent setup.

## Configuration

Set the following environment variables (or character settings):

| Variable | Required | Description |
|---|---|---|
| `BLUEBUBBLES_SERVER_URL` | yes | Base URL of the BlueBubbles server (e.g. `http://192.168.1.10:1234`) |
| `BLUEBUBBLES_PASSWORD` | yes | BlueBubbles server password |
| `BLUEBUBBLES_WEBHOOK_SECRET` | recommended | Shared secret to authenticate inbound webhook POSTs (`X-BlueBubbles-Webhook-Secret` header). Webhook requests are rejected without this. |
| `BLUEBUBBLES_WEBHOOK_PATH` | no | Override the default webhook path (`/webhooks/bluebubbles`) |
| `BLUEBUBBLES_DM_POLICY` | no | `open` \| `pairing` (default) \| `allowlist` \| `disabled` |
| `BLUEBUBBLES_GROUP_POLICY` | no | `open` \| `allowlist` (default) \| `disabled` |
| `BLUEBUBBLES_ALLOW_FROM` | no | Comma-separated handles allowed to DM the agent |
| `BLUEBUBBLES_GROUP_ALLOW_FROM` | no | Comma-separated handles allowed in group chats |
| `BLUEBUBBLES_SEND_READ_RECEIPTS` | no | Send read receipts; default `true` |
| `BLUEBUBBLES_ENABLED` | no | Set to `false` to disable without removing config |
| `BLUEBUBBLES_AUTOSTART_COMMAND` | no | Command to launch BlueBubbles before connecting (defaults to `open -a BlueBubbles` on macOS) |

### Character settings alternative

Config can also live under `character.settings.bluebubbles`:

```json
{
  "settings": {
    "bluebubbles": {
      "serverUrl": "http://192.168.1.10:1234",
      "password": "your-password",
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567", "user@example.com"]
    }
  }
}
```

### Webhook setup

In the BlueBubbles server app → Webhooks, add an entry:

- URL: `http://<your-agent-host>:<port>/webhooks/bluebubbles`
- Events: `new-message`, `updated-message`, `chat-updated`
- Secret: the value you set in `BLUEBUBBLES_WEBHOOK_SECRET`

## DM and group policies

| Policy | Behavior |
|---|---|
| `open` | Accept messages from any sender |
| `pairing` (default for DMs) | Accept messages only from handles in `BLUEBUBBLES_ALLOW_FROM`; if the list is empty, accept all |
| `allowlist` (default for groups) | Accept only from handles in the allow list |
| `disabled` | Reject all messages of this type |

## API routes

The plugin registers the following HTTP endpoints on the agent:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/setup/bluebubbles/status` | Service health and webhook path |
| `POST` | `/api/setup/bluebubbles/start` | Persist server URL and password, activate connection |
| `POST` | `/api/setup/bluebubbles/cancel` | Clear stored credentials |
| `GET` | `/api/bluebubbles/chats` | List BlueBubbles chats (`?limit=&offset=`) |
| `GET` | `/api/bluebubbles/messages` | List messages for a chat (`?chatGuid=&limit=&offset=`) |
| `POST` | `/webhooks/bluebubbles` | Inbound webhook receiver |

## Notes

- **macOS only for iMessage.** The BlueBubbles server runs on macOS. The agent
  itself can run anywhere as long as it can reach the BlueBubbles server URL.
- **Private API.** Message editing and unsend require the BlueBubbles Private
  API to be enabled on the macOS host.
- **Multiple servers.** Multiple BlueBubbles servers can be configured via
  `character.settings.bluebubbles.accounts.<accountId>`.
