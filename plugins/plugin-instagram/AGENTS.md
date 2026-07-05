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
  service.ts                     InstagramService class — connector registration + API backend boundary
  workflow-credential-provider.ts InstagramWorkflowCredentialProvider — Meta Graph API token supply
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

- **API backend boundary:** `InstagramService` registers the connector/account surfaces, but this
  package does not ship a concrete Instagram API client backend. API methods fail explicitly until a
  backend such as `instagram-private-api` or an approved Graph API adapter is wired into
  `src/service.ts`.
- **Multi-account:** Each configured account gets its own `InstagramService` instance. The `start()`
  static method iterates `listInstagramAccountIds()` and registers one connector pair per account.
- **Length caps:** `MAX_COMMENT_LENGTH = 1000` and `MAX_DM_LENGTH = 1000` are enforced in
  `service.ts` — DMs over the cap throw in `sendDirectMessage`, and `contentShaping.postProcess`
  auto-truncates comments via the module-local `truncateInstagramComment`. `MAX_CAPTION_LENGTH = 2200`
  is reserved for a caption-posting path.
- **PostConnector target:** `POST operation=send` requires `mediaId`, `target`, or `replyTo` in
  `content.metadata`; throws without one.
- **WorkflowCredentialProvider is duck-typed** — it does not import `@elizaos/plugin-workflow` at
  compile time; the `serviceType = "workflow_credential_provider"` string is the only coupling.
- **No `console.*`** — use `runtime.logger.*` or the imported `logger` from `@elizaos/core`.
- **ESM only** — `"type": "module"` in `package.json`; all imports must use explicit `.js`
  extensions in compiled output.
- **Node-only runtime** — declared in `package.json` under `eliza.platforms: ["node"]`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
