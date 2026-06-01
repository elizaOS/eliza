# @elizaos/plugin-discord

Discord connector plugin for elizaOS — connects an Eliza agent to Discord servers via the Discord.js gateway.

## Purpose / role

This plugin registers the `DiscordService` (and companion services) with the elizaOS runtime, giving an Eliza agent the ability to send and receive messages, handle voice, manage slash commands, track permission changes, and bridge the Discord desktop app via a local IPC connector. It is auto-enabled when `discord` appears in the character's connector keys (`autoEnable.connectorKeys: ["discord"]`). No actions or providers are registered; all behavior flows through services and events.

## Plugin surface

### Services
| Name | Type key | Purpose |
|---|---|---|
| `DiscordService` | `"discord"` | Main gateway service — connects to Discord API, handles messages, voice, slash commands, reactions, history backfill, and emits `DiscordEventTypes.*` events |
| `DiscordOwnerPairingServiceImpl` | `"OWNER_PAIRING_DISCORD"` | Registers the `/eliza-pair` slash command; relays pairing codes to the backend owner-bind service and DMs login links |
| `DiscordUserAccountScraperImpl` | `"discord_user_account_scraper"` | Scrapes message history and DM inboxes from the Discord desktop app via CDP/browser automation |

### Routes (registered with `rawPath: true`)
| Method | Path | File | Purpose |
|---|---|---|---|
| GET | `/api/setup/discord/status` | `setup-routes.ts` | OAuth/IPC connection state |
| POST | `/api/setup/discord/start` | `setup-routes.ts` | Initiate authorization |
| POST | `/api/setup/discord/cancel` | `setup-routes.ts` | Tear down session |
| GET | `/api/discord/guilds` | `data-routes.ts` | List guilds after auth |
| GET | `/api/discord/channels` | `data-routes.ts` | List channels for a guild |
| POST | `/api/discord/subscriptions` | `data-routes.ts` | Subscribe to channel IDs |

### Events emitted (from `DiscordEventTypes` in `types.ts`)
`DISCORD_MESSAGE_RECEIVED`, `DISCORD_MESSAGE_SENT`, `DISCORD_SLASH_COMMAND`, `DISCORD_MODAL_SUBMIT`, `DISCORD_REACTION_RECEIVED`, `DISCORD_REACTION_REMOVED`, `DISCORD_WORLD_JOINED`, `DISCORD_SERVER_CONNECTED`, `DISCORD_USER_JOINED`, `DISCORD_USER_LEFT`, `DISCORD_VOICE_STATE_CHANGED`, `DISCORD_CHANNEL_PERMISSIONS_CHANGED`, `DISCORD_ROLE_PERMISSIONS_CHANGED`, `DISCORD_MEMBER_ROLES_CHANGED`, `DISCORD_ROLE_CREATED`, `DISCORD_ROLE_DELETED`, `DISCORD_LISTEN_CHANNEL_MESSAGE`, `DISCORD_NOT_IN_CHANNELS_MESSAGE`

### Actions / providers / evaluators
None registered. The plugin operates entirely through services and events.

## Layout

```
plugins/plugin-discord/
  index.ts                    Plugin definition; init registers connector provider, reads env vars, logs banner
  service.ts                  DiscordService — main gateway service (discord.js Client, message/voice/interaction handling)
  voice.ts                    VoiceManager helper called by DiscordService for audio RX/TX, STT integration
  config.ts                   Config types: DiscordConfig, DiscordAccountConfig, DiscordGuildEntry, DiscordChannelConfig, etc.
  types.ts                    DiscordEventTypes enum, all event payload interfaces, DiscordSettings, error classes, snowflake helpers
  accounts.ts                 Multi-account helpers: resolveDiscordAccount, normalizeDiscordToken, listDiscordAccountIds
  allowlist.ts                Message gating: validateMessageAllowed, resolveDiscordAllowListMatch, resolveDiscordChannelConfig
  permissions.ts              Permission tiers, generateInviteUrl, getPermissionValues
  permissionEvents.ts         Elevated permissions helpers (hasElevatedPermissions, isElevatedRole)
  owner-pairing-service.ts    DiscordOwnerPairingServiceImpl — /eliza-pair slash command, DM login links
  discord-local-service.ts    DiscordLocalService — IPC connector to Discord desktop app (OAuth + local RPC socket)
  setup-routes.ts             HTTP routes for connector setup state machine (/api/setup/discord/*)
  data-routes.ts              HTTP routes for post-auth data (/api/discord/guilds, channels, subscriptions)
  slash-commands.ts           Slash command registry and dispatcher
  native-commands.ts          Utilities for building Discord slash commands with button/menu components
  messaging.ts                Text helpers: chunkDiscordText, escapeDiscordMarkdown, extractAllUserMentions, etc.
  messages.ts                 Message creation/sending logic used by DiscordService
  message-coalesce.ts         Debouncing/coalescing of rapid inbound messages before processing
  discord-history.ts          Channel history backfill (paginated fetch, batch storage)
  discord-events.ts           Discord.js event binding in DiscordService (GuildCreate, MessageCreate, etc.)
  discord-interactions.ts     Interaction handler (slash commands, buttons, modals)
  discord-reactions.ts        Reaction add/remove handlers
  discord-profiles.ts         Profile resolution helpers (avatar, entity display name)
  discord-avatar-cache.ts     Avatar URL caching utilities
  discord-commands.ts         Command sync utilities (REST-based command registration)
  connector-account-provider.ts  Registers this plugin as a connector account provider with ConnectorAccountManager
  sensitive-request-adapter.ts   Wraps DM-sent sensitive requests for approval flows
  inbound-envelope.ts         Normalises raw Discord messages into elizaOS Memory objects
  attachments.ts              Attachment download and media type detection
  addressing.ts               Channel/user ID resolution helpers
  identity.ts                 Bot identity helpers (isSelf, botUserId)
  debouncer.ts                Generic debounce utility used by message-coalesce
  draft-chunking.ts           Streaming draft chunking logic
  draft-stream.ts             Draft streaming over Discord message edits
  staleness.ts                Stale-world detection helpers
  auto-enable.ts              Character-level auto-enable resolution
  environment.ts              Env var validation (DISCORD_API_TOKEN required check)
  compat.ts                   Runtime proxy for serverId/messageServerId API version shim
  constants.ts                DISCORD_SERVICE_NAME = "discord"
  utils.ts                    Misc runtime helpers (getMessageService, normalizeDiscordMessageText, etc.)
  user-account-scraper/
    service.ts                DiscordUserAccountScraperImpl — CDP-based message and DM inbox scraper
    discord-browser-scraper.ts  Browser-based scraper logic
    discord-desktop-cdp.ts    Desktop CDP probe and tab management utilities
    index.ts                  Barrel re-export
  actions/
    actionResultSemantics.ts  Action result helpers
    setup-credentials.ts      Credential preset definitions used by /setup slash command
  __tests__/                  Vitest unit tests (co-located fast tests)
  test/                       Vitest unit + live integration tests
    helpers/                  Shared test helpers (http.ts, pglite-runtime.ts)
    live/                     Live integration specs (require real Discord credentials)
  tests.ts                    DiscordTestSuite for elizaOS plugin test runner
```

## Commands

Only scripts present in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-discord build       # compile with build.ts → dist/
bun run --cwd plugins/plugin-discord dev         # hot-rebuild with bun --hot build.ts
bun run --cwd plugins/plugin-discord test        # vitest run (unit tests)
bun run --cwd plugins/plugin-discord typecheck   # tsc --noEmit
bun run --cwd plugins/plugin-discord lint        # biome check --write --unsafe
bun run --cwd plugins/plugin-discord format      # biome format --write
bun run --cwd plugins/plugin-discord test:e2e    # live smoke test via app-core runner
bun run --cwd plugins/plugin-discord clean       # rm dist + generated .d.ts files
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `DISCORD_API_TOKEN` | **Yes** | Bot token used to log in the Discord gateway client |
| `DISCORD_APPLICATION_ID` | **Yes** | Discord application (client) ID — used for slash command registration and invite URL generation |
| `DISCORD_BOT_TOKENS` | No | Comma-separated multi-account tokens (multi-account mode alternative to `DISCORD_API_TOKEN`) |
| `CHANNEL_IDS` | No | Comma-separated channel IDs the bot is restricted to (whitelist) |
| `DISCORD_LISTEN_CHANNEL_IDS` | No | Comma-separated channel IDs where the bot ingests messages but does NOT reply |
| `DISCORD_VOICE_CHANNEL_ID` | No | Voice channel ID to auto-join on guild scan; defaults to most-populated channel |
| `DISCORD_SHOULD_IGNORE_BOT_MESSAGES` | No | `"true"` to ignore messages from other bots (default: `false`) |
| `DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES` | No | `"true"` to ignore DMs (default: `false`) |
| `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS` | No | `"true"` to only reply when @-mentioned (default: `false`) |
| `DISCORD_TEST_CHANNEL_ID` | No | Channel used by `DiscordTestSuite` |

All settings can also be provided in the character file under `settings.discord` (as `DiscordConfig` / `DiscordAccountConfig`) — character settings override env vars.

## How to extend

**Add a new slash command** — either call `addCommand(commandSpec)` (from `slash-commands.ts`) with a `SlashCommand`-shaped object that includes an `execute(interaction, runtime)` function, or emit the `DISCORD_REGISTER_COMMANDS` event with an array of `DiscordSlashCommand` objects (from `types.ts`) for external registration. Handle responses by listening for `DISCORD_SLASH_COMMAND` or `DISCORD_MODAL_SUBMIT` events.

**Add a new event handler** — subscribe to a `DiscordEventTypes.*` string event on the runtime from any plugin or service. All event payload types are in `types.ts` (`DiscordEventPayloadMap`).

**Add a new HTTP route** — append a `Route` object to `discordSetupRoutes` (in `setup-routes.ts`) or `discordDataRoutes` (in `data-routes.ts`), or export a new route array from a new file and add it to the `routes` array in `index.ts`.

**Add a new service** — create a class extending `Service` from `@elizaos/core`, export it, and add it to the `services` array in `index.ts`.

## Conventions / gotchas

- **Discord snowflake IDs are not UUIDs.** Use `stringToUuid(discordId)` to store them in UUID fields. Use `createUniqueUuid(runtime, discordId)` for `worldId`/`roomId` (agent-namespaced). Never use `asUUID()` on raw Discord IDs — it throws.
- **`messageServerId` is the correct field** for server IDs on `Room` and `World` objects (not `serverId`). The `compat.ts` shim handles older core versions transparently.
- **Native dependencies.** `@discordjs/opus` and `libsodium-wrappers` have native binaries. They must build successfully in the Node.js environment; the plugin does not run in browsers (see `eliza.platforms: ["node"]`).
- **Voice requires ffmpeg.** The `fluent-ffmpeg` dep expects a system `ffmpeg` binary on `PATH` for audio processing.
- **Multi-account mode** is activated by setting `DISCORD_BOT_TOKENS` (comma-separated) instead of `DISCORD_API_TOKEN`. See `accounts.ts` for resolution order.
- **`autoReply` is false by default** in `DiscordSettings` — messages are ingested but the agent does not auto-reply unless explicitly enabled.
- See root `AGENTS.md` for repo-wide architecture rules, logger-only logging, ESM conventions, and naming standards.
