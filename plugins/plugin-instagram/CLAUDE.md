# @elizaos/plugin-instagram

Instagram DM and public-comment connector for elizaOS agents.

## Purpose / role

Adds Instagram integration to an Eliza agent: DM sending (via the `MESSAGE` connector) and public
media-comment posting (via the `POST` connector). Loaded opt-in — add
`@elizaos/plugin-instagram` to the agent's `plugins` array.
Requires approved professional-account Graph credentials; consumer username/password automation is
not supported. The service stays disabled when credentials are absent.

## Plugin surface

**Services** (registered in `services: [...]`):

- `InstagramService` (`serviceType = "instagram"`) — lifecycle manager for one or more Instagram
  accounts. On `start()` it reads config, validates credentials, and registers both the DM
  `MessageConnector` and the feed `PostConnector` with the runtime. Exposes Graph-backed methods for
  scoped profiles, owned media, conversations/messages, text DMs, and comment/reply writes. Legacy
  like/follow methods remain public for compatibility but fail explicitly as unsupported.

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
  graph-client.ts                Production Graph transport, schemas, paging, and DTO conversion
  webhook.ts                     Raw-body signature/challenge validation and account event routing
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
| `INSTAGRAM_GRAPH_ACCOUNT_ID` | **Yes** | Professional account ID for the default account |
| `INSTAGRAM_ACCESS_TOKEN` | **Yes** | Approved Graph API access token |
| `INSTAGRAM_APP_SECRET` | For webhooks | App secret for `X-Hub-Signature-256` validation |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | For webhooks | Subscription verification secret |
| `INSTAGRAM_GRAPH_API_VERSION` | No | Explicit API version (default `v24.0`) |
| `INSTAGRAM_GRAPH_BASE_URL` | No | HTTPS Graph origin; literal loopback HTTP is test-only |
| `INSTAGRAM_REQUEST_TIMEOUT_MS` | No | Request deadline in milliseconds |
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
      "instagramAccountId": "17841400000000000",
      "accessToken": "secret",
      "accounts": {
        "brand-a": { "instagramAccountId": "17841400000000001", "accessToken": "..." }
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

- **API backend boundary:** `InstagramGraphClient` is the only production network boundary. It uses
  bearer headers, strict response schemas, same-origin cursors, manual redirects, bounded bodies,
  deadlines, and redacted typed failures. Remote origins require HTTPS; literal loopback HTTP exists
  only for real-wire protocol tests.
- **Capability truth:** Official professional-account reads, scoped profile lookup, one-to-one text
  sends, and media comments/replies are implemented. Consumer login, arbitrary username discovery,
  third-party media reads, follows, and likes fail with `INSTAGRAM_CAPABILITY_UNSUPPORTED`; do not
  add private/mobile scraping APIs.
- **Webhook boundary:** Validate the raw body signature before parsing. Parsed events are stamped
  with the professional account ID and stable replay identity. Durable route ingestion and shared
  synthetic reset/ledger composition remain owned by #24093 and #24076-#24078.
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
