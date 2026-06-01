# @elizaos/plugin-instagram

Instagram DM and public-comment connector for elizaOS agents.

## Purpose / role

Adds Instagram integration to an Eliza agent: DM sending (via the `MESSAGE` connector), public
media-comment posting (via the `POST` connector), and workflow credential supply for Meta Graph
API-based nodes. Loaded opt-in — add `@elizaos/plugin-instagram` to the agent's `plugins` array.
Requires credentials to do anything useful; the service degrades gracefully when they are absent.

## Plugin surface

**Services** (registered in `services: [...]`):

- `InstagramService` (`serviceType = "instagram"`) — lifecycle manager for one or more Instagram
  accounts. On `start()` it reads config, validates credentials, and registers both the DM
  `MessageConnector` and the feed `PostConnector` with the runtime. Exposes methods for sending DMs,
  posting/replying to comments, liking media, following/unfollowing users, and fetching threads.
- `InstagramWorkflowCredentialProvider` (`serviceType = "workflow_credential_provider"`) — supplies
  a `facebookGraphApi` credential object (`{ accessToken }`) to the workflow plugin via duck-typed
  `resolve(userId, credType)`. Reads `INSTAGRAM_PAGE_ACCESS_TOKEN`.

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
  service.ts                     InstagramService class — connector registration + all API stubs
  workflow-credential-provider.ts InstagramWorkflowCredentialProvider — Meta Graph API token supply
  connector-account-provider.ts  ConnectorAccountProvider impl for ConnectorAccountManager
  accounts.ts                    Config resolution: env vars, character.settings.instagram, multi-account
  constants.ts                   INSTAGRAM_SERVICE_NAME, MAX_*, SUPPORTED_MEDIA_TYPES, EVENT_PREFIX
  types.ts                       All TS types/interfaces/enums (InstagramConfig, InstagramUser, etc.)
  actions/index.ts               Placeholder — no actions defined; DMs/comments use connectors
  providers/index.ts             Placeholder — no providers defined; context via connector hooks
  __tests__/                     Vitest unit tests
```

## Commands

```bash
bun run --cwd plugins/plugin-instagram build        # tsdown compile → dist/
bun run --cwd plugins/plugin-instagram dev          # watch build (bun --hot)
bun run --cwd plugins/plugin-instagram test         # vitest run
bun run --cwd plugins/plugin-instagram test:watch   # vitest watch
bun run --cwd plugins/plugin-instagram typecheck    # tsgo --noEmit
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
| `INSTAGRAM_ACCOUNTS` | No | JSON array/object of additional account configs |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | No | Meta Graph API page access token for workflow nodes |

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

- **API stubs:** The current `InstagramService` methods (`sendDirectMessage`, `postComment`,
  `getThreads`, etc.) are stubs that log and return synthetic data. Real Instagram API calls are not
  implemented. Connect an actual client library (e.g., `instagram-private-api`) inside those
  methods before shipping to production.
- **Multi-account:** Each configured account gets its own `InstagramService` instance. The `start()`
  static method iterates `listInstagramAccountIds()` and registers one connector pair per account.
- **Caption/comment length caps:** `MAX_CAPTION_LENGTH = 2200`, `MAX_COMMENT_LENGTH = 1000`,
  `MAX_DM_LENGTH = 1000` — enforced in `service.ts`; `contentShaping.postProcess` auto-truncates
  comments via `truncateInstagramComment`.
- **PostConnector target:** `POST operation=send` requires `mediaId`, `target`, or `replyTo` in
  `content.metadata`; throws without one.
- **WorkflowCredentialProvider is duck-typed** — it does not import `@elizaos/plugin-workflow` at
  compile time; the `serviceType = "workflow_credential_provider"` string is the only coupling.
- **No `console.*` in new code** — use `runtime.logger.*` or the imported `logger` from
  `@elizaos/core` (existing stubs use `console.log`; clean those up when implementing real API
  calls).
- **ESM only** — `"type": "module"` in `package.json`; all imports must use explicit `.js`
  extensions in compiled output.
- **Node-only runtime** — declared in `package.json` under `eliza.platforms: ["node"]`.
