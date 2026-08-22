# @elizaos/plugin-instagram

Instagram DM and public-comment connector for elizaOS agents.

## Purpose / role

Adds Instagram integration to an Eliza agent: DM sending (via the `MESSAGE` connector) and public
media-comment posting (via the `POST` connector). Loaded opt-in — add
`@elizaos/plugin-instagram` to the agent's `plugins` array.
Requires credentials to do anything useful; the service degrades gracefully when they are absent.

## Plugin surface

**Services** (registered in `services: [...]`):

- `InstagramService` (`serviceType = "instagram"`) — lifecycle manager for one or more Instagram
  accounts. On `start()` it reads config, validates credentials, and registers both the DM
  `MessageConnector` and the feed `PostConnector` with the runtime. Exposes methods for sending DMs,
  posting/replying to comments, liking media, following/unfollowing users, and fetching threads.

**Actions:** none registered — DMs route through `MESSAGE`, comments through `POST`.

**Providers:** none registered — context is exposed via the `MessageConnector` and `PostConnector`
hooks (`getChatContext`, `getUserContext`, `resolveTargets`, `listRooms`, `fetchMessages`,
`searchMessages`).

**Connector registration** (inside `InstagramService.registerSendHandlers`):
- `MessageConnector` — source `"instagram"`, capabilities `send_message · resolve_targets ·
  list_rooms · chat_context · user_context`, context tags `["social", "connectors"]`.
- `PostConnector` — source `"instagram"`, capabilities `post · comment`, context tags
  `["social_posting", "connectors"]`.

**`init()` hook:** Registers `createInstagramConnectorAccountProvider` with the runtime's
`ConnectorAccountManager` (if present). Warns on failure; does not throw.

## Layout

```
src/
  index.ts                       Plugin object, init() hook, re-exports
  service.ts                     InstagramService class — connector registration + API backend boundary
  connector-account-provider.ts  ConnectorAccountProvider impl for ConnectorAccountManager
  accounts.ts                    Config resolution: env vars, character.settings.instagram, multi-account
  constants.ts                   INSTAGRAM_SERVICE_NAME, MAX_*, SUPPORTED_MEDIA_TYPES, EVENT_PREFIX
  types.ts                       All TS types/interfaces/enums (InstagramConfig, InstagramUser, etc.)
  tests.ts                       InstagramTestSuite — in-process TestCase[] suite for message splitting and service internals
  actions/index.ts               Empty action surface; DMs/comments use connectors
  providers/index.ts             Empty provider surface; context comes from connector hooks
  __tests__/                     Vitest unit tests
```

## Commands

```bash
bun run --cwd plugins/plugin-instagram build        # bun build → dist/
bun run --cwd plugins/plugin-instagram dev          # watch build (bun --hot)
bun run --cwd plugins/plugin-instagram test         # vitest run
bun run --cwd plugins/plugin-instagram test:watch   # vitest watch
bun run --cwd plugins/plugin-instagram typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-instagram lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-instagram lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-instagram format       # biome format --write
bun run --cwd plugins/plugin-instagram clean        # rm dist/ .turbo/ tsconfig artifacts
```

## Config / env vars

All read via `runtime.getSetting(key)` or `character.settings.instagram.*`. Only the env vars below
apply when `accountId === "default"` (the single-account case). Multi-account deployments use
`INSTAGRAM_ACCOUNTS` (JSON) or `character.settings.instagram.accounts`.

| Env var | Required | Description |
|---|---|---|
| `INSTAGRAM_USERNAME` | **Yes** | Instagram username for the default account |
| `INSTAGRAM_PASSWORD` | **Yes** | Instagram password for the default account |
| `INSTAGRAM_VERIFICATION_CODE` | No | 2FA code if account requires it |
| `INSTAGRAM_PROXY` | No | HTTP/SOCKS proxy URL for API requests |
| `INSTAGRAM_AUTO_RESPOND_DMS` | No | `"true"` to auto-respond to DMs |
| `INSTAGRAM_AUTO_RESPOND_COMMENTS` | No | `"true"` to auto-respond to comments |
| `INSTAGRAM_POLLING_INTERVAL` | No | Poll interval in seconds (default `60`) |
| `INSTAGRAM_ACCOUNT_ID` | No | Override default account ID |
| `INSTAGRAM_DEFAULT_ACCOUNT_ID` | No | Alias for `INSTAGRAM_ACCOUNT_ID` |
| `INSTAGRAM_ACCOUNTS` | No | JSON array/object of additional account configs. Malformed JSON or a primitive fails startup with `INSTAGRAM_CONFIG_INVALID`; junk entries are skipped and IDs are normalized. |

Character-level config goes in `character.settings.instagram`:
```json
{
  "settings": {
    "instagram": {
      "username": "mybot",
      "password": "secret",
      "accounts": {
        "brand-a": { "username": "brand_a", "password": "..." }
      }
    }
  }
}
```

## How to extend

**Add an action** — create `src/actions/my-action.ts` implementing `Action` from `@elizaos/core`,
then push it into the `actions: []` array in `src/index.ts`.

**Add a provider** — create `src/providers/my-provider.ts` implementing `Provider` from
`@elizaos/core`, then push it into `providers: []` in `src/index.ts`.

**Add a new service** — extend `Service` from `@elizaos/core`, set a unique static `serviceType`,
implement `static async start(runtime)` + `async stop()`, then add the class to `services: [...]`
in `src/index.ts`.

**Add a new account field** — extend `InstagramConfig` in `src/types.ts` and wire the env var
through `resolveInstagramAccountConfig` in `src/accounts.ts` (follow the existing `allowEnv`
pattern).

## Conventions / gotchas

- **API backend boundary:** `InstagramService` registers the connector/account surfaces, but this
  package does not ship a concrete Instagram API client backend. API methods fail explicitly until a
  backend such as `instagram-private-api` or an approved Graph API adapter is wired into
  `src/service.ts`.
- **Multi-account:** Each configured account gets its own `InstagramService` instance. The `start()`
  static method iterates `listInstagramAccountIds()` and registers one connector pair per account.
  `INSTAGRAM_ACCOUNTS` is fail-closed: malformed/non-collection JSON is fatal, non-object entries
  are skipped, padded object keys and array `accountId`/`id` values are normalized before lookup,
  and duplicate normalized IDs are rejected rather than silently overwriting credentials. The same
  key normalization applies to `character.settings.instagram.accounts`.
- **Length limits:** `MAX_COMMENT_LENGTH = 1000` and `MAX_DM_LENGTH = 1000` are enforced in
  `service.ts` — over-limit DMs and comments fail explicitly without changing the text.
  `MAX_CAPTION_LENGTH = 2200` is reserved for a caption-posting path.
- **PostConnector target:** `POST operation=send` requires `mediaId`, `target`, or `replyTo` in
  `content.metadata`; throws without one.
- **No `console.*`** — use `runtime.logger.*` or the imported `logger` from `@elizaos/core`.
- **ESM only** — `"type": "module"` in `package.json`; all imports must use explicit `.js`
  extensions in compiled output.
- **Node-only runtime** — declared in `package.json` under `eliza.platforms: ["node"]`.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
