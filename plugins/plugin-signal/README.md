# @elizaos/plugin-signal

Signal messaging integration for elizaOS. Enables Eliza agents to send and receive end-to-end-encrypted Signal messages via [signal-cli](https://github.com/AsamK/signal-cli) or its REST API.

## What it does

- **Receive messages** — inbound Signal DMs and group messages are stored as agent memories and trigger `SIGNAL_MESSAGE_RECEIVED` events.
- **Send messages** — agents send DMs and group messages through the elizaOS `MessageConnector` surface (LifeOps, workflow automations, explicit send actions).
- **Contact and group discovery** — the plugin exposes Signal contacts and groups as connector targets so agents can resolve conversation destinations by name, phone number, or group.
- **QR device linking** — HTTP endpoints drive a pairing flow (QR code → signal-cli device link) without requiring a separate phone.
- **Multi-account** — configure multiple Signal accounts via `character.settings.signal.accounts`.
- **Workflow integration** — supplies credentials to the workflow plugin for Signal-backed automations.

## Capabilities registered

This plugin registers no actions. Messaging is handled through the `MessageConnector` interface.

**Services:**
- `SignalService` — core connector; manages daemon lifecycle, inbound/outbound messages, contacts, and groups.
- `SignalWorkflowCredentialProvider` — bridges Signal credentials to the workflow plugin.

**Setup routes (no auth required, mounted at raw paths):**
- `GET  /api/setup/signal/status` — pairing and connection state
- `POST /api/setup/signal/start`  — begin QR device-linking session
- `POST /api/setup/signal/cancel` — stop pairing and disconnect

## Prerequisites

One of:
- **signal-cli** installed and on `PATH` (the plugin can spawn and manage it as a daemon). On macOS, install via Homebrew: `brew install signal-cli`. Java is required; the plugin auto-detects Homebrew's OpenJDK.
- A running **signal-cli REST API server** (`signal-cli -a +1... daemon --http 127.0.0.1:8080`) accessible at `SIGNAL_HTTP_URL`.
- The optional **`@elizaos/signal-native`** peer dependency for QR linking without spawning signal-cli.

The agent's Signal account must be linked (registered or device-linked) before the service can connect. Use the `/api/setup/signal/start` endpoint or run `signal-cli -a +1... link` manually.

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SIGNAL_ACCOUNT_NUMBER` | **yes** | — | Phone number in E.164 format (e.g. `+15551234567`) |
| `SIGNAL_HTTP_URL` | no | `http://127.0.0.1:8080` | signal-cli REST API URL; omit to auto-start a local daemon |
| `SIGNAL_CLI_PATH` | no | `signal-cli` (PATH) | Path to signal-cli binary |
| `SIGNAL_CLI_AUTO_INSTALL` | no | `true` | Set `false` to disable Homebrew auto-install |
| `SIGNAL_AUTH_DIR` | no | `~/.local/share/signal-cli` | signal-cli data directory |
| `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES` | no | `false` | Set `true` to respond only to DMs |
| `SIGNAL_AUTO_REPLY` | no | `false` | Set `true` to have the agent auto-generate replies |
| `SIGNAL_RECEIVE_MODE` | no | `manual` | `on-start` polls immediately; `manual` lets LifeOps pull |
| `SIGNAL_STARTUP_TIMEOUT_MS` | no | `30000` | Daemon startup timeout (max 120 000 ms) |

### Character settings (multi-account)

```jsonc
{
  "settings": {
    "signal": {
      "account": "+15551234567",
      "httpUrl": "http://127.0.0.1:8080",
      "accounts": {
        "work": {
          "account": "+15559876543",
          "httpUrl": "http://127.0.0.1:8081",
          "enabled": true
        }
      }
    }
  }
}
```

## Enabling the plugin

The plugin auto-enables when a `signal` connector block is present in the agent config and not explicitly set to `enabled: false`. You can also add it directly to the plugins array:

```ts
import signalPlugin from "@elizaos/plugin-signal";

const agent = new AgentRuntime({
  plugins: [signalPlugin],
  // ...
});
```

## Important behavior notes

- **Auto-reply is off by default.** Inbound messages are recorded as memories and events, but the agent does not respond unless `SIGNAL_AUTO_REPLY=true`. Use LifeOps or explicit workflow actions to send responses.
- **Auth directory:** signal-cli always uses `~/.local/share/signal-cli` on all platforms (including macOS). This matches the signal-cli default, so an existing local installation works without extra config.
- **Message length:** messages over 4 000 characters are split automatically.
- **Group filtering:** set `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES=true` to limit the agent to direct messages only.
