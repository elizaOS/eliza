# @elizaos/plugin-discord-local

Local Discord desktop integration for Eliza agents via Discord RPC and macOS UI automation.

## Purpose / role

Connects an Eliza agent to the Discord **desktop app** running on the same machine. It listens
for incoming messages and notifications over the Discord local RPC socket, ingests them into
the agent's memory, and sends replies by driving the Discord UI through AppleScript/osascript.
It is opt-in: the plugin does nothing until `DISCORD_LOCAL_CLIENT_ID` and
`DISCORD_LOCAL_CLIENT_SECRET` are present in the agent's settings.

**macOS only.** The send path calls `osascript` and `/usr/bin/open`; the plugin will refuse
non-darwin platforms at runtime.

## Plugin surface

All surface is declared in the `discordLocalPlugin` export at the bottom of `src/index.ts`.

### Services

| Name | Class | What it does |
|---|---|---|
| `discord-local` | `DiscordLocalService` | Manages the IPC socket connection to the local Discord app, handles OAuth, subscribes to RPC events (`MESSAGE_CREATE`, `NOTIFICATION_CREATE`), ingests messages into runtime memory, and drives osascript to send replies. |

### Routes (all `rawPath: true`)

| Method | Path | Handler |
|---|---|---|
| GET | `/api/setup/discord/status` | `handleDiscordStatus` — returns connection/auth state |
| POST | `/api/setup/discord/start` | `handleDiscordStart` — triggers OAuth authorization flow |
| POST | `/api/setup/discord/cancel` | `handleDiscordCancel` — clears session and disconnects |
| GET | `/api/discord/guilds` | `handleDiscordGuilds` — lists guilds via RPC |
| GET | `/api/discord/channels` | `handleDiscordChannels` — lists channels for a guild (`?guildId=`) |
| POST | `/api/discord/subscriptions` | `handleDiscordSubscriptions` — updates `MESSAGE_CREATE` subscriptions |

### Actions / Providers / Evaluators

None. This plugin registers only a service and routes.

### Send handler

`DiscordLocalService.registerSendHandlers` registers the source `discord-local` (and `discord`
when no other discord handler is registered) on the runtime. This lets the orchestration layer
route outbound messages to Discord without importing this package directly.

## Layout

```
plugins/plugin-discord-local/
  src/
    index.ts          Everything — service, routes, plugin export, all helpers
  build.ts            Bun build script
  package.json
  tsconfig.json
  tsconfig.build.json
  biome.json
```

The entire plugin is a single file (`src/index.ts`). There are no sub-modules.

Key exports from `src/index.ts`:
- `default` — `discordLocalPlugin` (the `Plugin` object)
- `DiscordLocalService` — the service class
- `DISCORD_LOCAL_PLUGIN_NAME` — `"@elizaos/plugin-discord-local"`
- `DISCORD_LOCAL_SERVICE_NAME` — `"discord-local"`

## Commands

```bash
bun run --cwd plugins/plugin-discord-local build       # compile to dist/
bun run --cwd plugins/plugin-discord-local dev         # watch build (bun --hot)
bun run --cwd plugins/plugin-discord-local typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-discord-local lint        # biome check --write
bun run --cwd plugins/plugin-discord-local lint:check  # biome check (no write)
bun run --cwd plugins/plugin-discord-local format      # biome format --write
bun run --cwd plugins/plugin-discord-local format:check
bun run --cwd plugins/plugin-discord-local clean       # rm dist .turbo
```

No test script is defined in this package's `package.json`.

## Config / env vars

All settings are read via `runtime.getSetting(key)`.

| Setting | Required | Default | Description |
|---|---|---|---|
| `DISCORD_LOCAL_CLIENT_ID` | Yes | — | Discord application client ID (from Discord Developer Portal). Plugin is disabled if absent. |
| `DISCORD_LOCAL_CLIENT_SECRET` | Yes | — | Discord application client secret. Plugin is disabled if absent. |
| `DISCORD_LOCAL_ENABLED` | No | `true` | Set to `"false"` to explicitly disable after credentials are set. |
| `DISCORD_LOCAL_SCOPES` | No | `rpc,identify,rpc.notifications.read` | Comma-separated OAuth scopes. Must include `rpc` for IPC to work. |
| `DISCORD_LOCAL_MESSAGE_CHANNEL_IDS` | No | `""` | Comma-separated Discord channel IDs to subscribe to `MESSAGE_CREATE`. |
| `DISCORD_LOCAL_SEND_DELAY_MS` | No | `900` | Milliseconds to wait after focusing Discord before typing. Minimum 100. |

Session tokens are persisted to `<stateDir>/discord-local/session.json`. `resolveStateDir()` from
`@elizaos/core` determines `stateDir`.

The IPC socket is located by scanning `DISCORD_IPC_DIR`, `XDG_RUNTIME_DIR`, `TMPDIR`, `/tmp`,
`/private/tmp`, and `~/Library/Application Support/discord` (recursive, macOS fallback).

## How to extend

### Add a route

1. Write a handler function matching `(req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => Promise<void>`.
2. Append a `Route` object to `discordLocalSetupRoutes` at the bottom of `src/index.ts`.
3. Access the service inside the handler with `resolveDiscordLocalService(runtime)`.

### Add an action

1. Define the action object (`Action` from `@elizaos/core`) anywhere in `src/index.ts` or a new
   file under `src/`.
2. Add it to `discordLocalPlugin.actions = [...]` before the export.
3. In the action handler, retrieve the service via `runtime.getService(DISCORD_LOCAL_SERVICE_NAME)`.

### Add a provider

Same pattern: define a `Provider`, add to `discordLocalPlugin.providers = [...]`.

## Conventions / gotchas

- **macOS only.** `requireConfig()` throws on non-darwin platforms. Do not attempt to run the
  send path on Linux/Windows.
- **Authorization is interactive.** The OAuth flow (`handleDiscordStart` → `service.authorize()`)
  pops a Discord permission dialog in the desktop app. It cannot be automated headlessly.
- **Session persistence.** OAuth tokens survive restarts via `<stateDir>/discord-local/session.json`.
  Token refresh is automatic when `refreshToken` and `expiresAt` are present.
- **Reconnect.** On socket close, `scheduleReconnect` retries after 3 seconds if a session exists.
- **IPC timeout.** Each RPC command times out after 20 seconds.
- **No test suite.** There are no unit or integration tests in this package.
- **Single-file.** All logic lives in `src/index.ts`. Keep additions in the same file unless they
  grow large enough to justify splitting; if you split, update the exports list above.
- **`connector-setup` integration.** When the runtime exposes a `connector-setup` service,
  `handleDiscordSubscriptions` writes the chosen channel IDs back into the connector config and
  registers Discord as the escalation channel. This is an optional runtime capability; the plugin
  works without it.
- For global architecture rules, naming, and logger conventions see the repo root `AGENTS.md`.
