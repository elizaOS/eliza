# @elizaos/plugin-farcaster

Farcaster client plugin — sends and receives casts on behalf of an Eliza agent via the Neynar API.

## Purpose / role

Adds Farcaster connectivity to any Eliza agent. It registers a `FarcasterService` that manages one or more Neynar-backed accounts per agent, polls or listens for incoming casts/mentions, publishes new casts, and exposes a `post` / `fetch_feed` / `search_posts` connector so the agent runtime's social-posting layer can address Farcaster like any other platform.

Auto-enabled when a `farcaster` connector block is present in the agent's config (via `auto-enable.ts` + `elizaos.plugin.autoEnableModule`). It is NOT default-enabled for agents with no Farcaster configuration.

## Plugin surface

**Services** (registered in `farcasterPlugin.services`):
- `FarcasterService` — singleton per runtime; manages per-agent, per-account `FarcasterAgentManager` instances; registers as a `post` connector; exposes `getMessageService`, `getCastService`, `getManagerForAccount`, `healthCheck`.
- `FarcasterWorkflowCredentialProvider` — duck-typed `workflow_credential_provider` service; supplies the Neynar API key as `httpHeaderAuth` to the workflow plugin (no compile-time dep on plugin-workflow).

**Providers** (registered in `farcasterPlugin.providers`):
- `farcasterProfileProvider` — name: `farcasterProfile`; dynamic; contexts: `social_posting`, `messaging`, `connectors`; fetches the agent's Farcaster profile (FID, username, display name) from Neynar and injects it as context each turn.

**Routes** (registered in `farcasterPlugin.routes`):
- `POST /webhook` — Neynar webhook handler; validates `NeynarWebhookData` shape, routes to the matching `FarcasterAgentManager.interactions.processWebhookData()`.

**Actions**: none registered directly; the plugin exposes Farcaster as a post connector, and the runtime's generic `POST` action handles it.

**Events emitted** (`FarcasterEventTypes`):
- `FARCASTER_POST_GENERATED` — fired by `FarcasterMessageService.sendMessage` after a cast is published.
- `FARCASTER_MENTION_RECEIVED` — fired by the interaction manager when a mention arrives.
- `FARCASTER_THREAD_CAST_CREATED` — fired when a new thread cast is created.

## Layout

```
plugins/plugin-farcaster/
  index.ts                        Plugin object (farcasterPlugin), re-exports
  auto-enable.ts                  shouldEnable() — connector-block check (loaded at boot, no heavy imports)
  connector-account-provider.ts   ConnectorAccountManager registration
  workflow-credential-provider.ts FarcasterWorkflowCredentialProvider service
  actions/
    index.ts                      farcasterActions = [] (empty barrel)
  client/
    FarcasterClient.ts            Neynar SDK wrapper (sendCast, getTimeline, getMentions, getCast, getProfile, publishReaction, deleteReaction); LRU cast + profile caches
  managers/
    index.ts                      barrel re-export
    AgentManager.ts               FarcasterAgentManager — owns FarcasterClient, CastManager, InteractionManager per account
    CastManager.ts                Scheduled autonomous cast loop
    InteractionManager.ts         Polling / webhook interaction dispatcher
    InteractionProcessor.ts       Processes a single incoming cast into an agent response
    InteractionSource.ts          Abstracts polling vs webhook data sources
    EmbedManager.ts               Classifies and processes NeynarEmbed into CastEmbed
  services/
    FarcasterService.ts           Top-level Service — multi-agent, multi-account lifecycle
    CastService.ts                FarcasterCastService — getCasts, createCast, handleSendPost, fetchFeed, searchPosts, likeCast, recast, etc.
    MessageService.ts             FarcasterMessageService — getMessages, sendMessage, getThread, getMessage
    index.ts                      barrel re-export
  providers/
    index.ts                      farcasterProviders array
    profileProvider.ts            farcasterProfileProvider implementation
  routes/
    webhook.ts                    POST /webhook handler
  types/
    index.ts                      Cast, Profile, CastId, FarcasterConfig, FarcasterConfigSchema (zod), FarcasterEventTypes, FarcasterMessageType, NeynarWebhookData
  utils/
    config.ts                     validateFarcasterConfig, getFarcasterFid, hasFarcasterEnabled, listFarcasterAccountIds, readFarcasterAccountId, normalizeFarcasterAccountId, resolveDefaultFarcasterAccountId
    index.ts                      castUuid, neynarCastToCast, splitPostContent
    asyncqueue.ts                 Serial async queue used by interaction processor
    callbacks.ts                  Post-cast callback helpers
    prompts.ts                    formatCast / formatTimeline cast+timeline formatting helpers
  prompts/                        actions.json / evaluators.json / providers.json plugin spec manifests
  generated/specs/                spec-helpers.ts + specs.ts — provider/action spec lookups (do not hand-edit)
```

## Commands

Only scripts that exist in this package.json:

```bash
bun run --cwd plugins/plugin-farcaster build         # Bun.build via build.ts (node + browser targets)
bun run --cwd plugins/plugin-farcaster dev           # build --watch
bun run --cwd plugins/plugin-farcaster clean         # rm -rf dist .turbo ...
bun run --cwd plugins/plugin-farcaster typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-farcaster test          # vitest run (all)
bun run --cwd plugins/plugin-farcaster test:unit     # vitest run __tests__/
bun run --cwd plugins/plugin-farcaster lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-farcaster lint:check    # biome check (read-only)
bun run --cwd plugins/plugin-farcaster format        # biome format --write
bun run --cwd plugins/plugin-farcaster format:check  # biome format (read-only)
```

## Config / env vars

Read via `validateFarcasterConfig()` in `utils/config.ts` against `FarcasterConfigSchema` (zod). Multi-account: prefix any var with `FARCASTER_<ACCOUNT_ID>_` to support multiple accounts per agent, or pass a JSON array via `FARCASTER_ACCOUNTS`.

| Env var                       | Required | Default          | Description |
|-------------------------------|----------|------------------|-------------|
| `FARCASTER_NEYNAR_API_KEY`    | yes      | —                | Neynar API key (sensitive) |
| `FARCASTER_FID`               | yes      | —                | Farcaster user ID (integer) |
| `FARCASTER_SIGNER_UUID`       | yes      | —                | Neynar signer UUID for signing casts |
| `FARCASTER_ACCOUNTS`          | no       | —                | JSON array of per-account config objects for multi-account mode |
| `FARCASTER_DEFAULT_ACCOUNT_ID`| no       | —                | Selects the default account when multiple accounts are configured |
| `FARCASTER_ACCOUNT_ID`        | no       | —                | Alias for FARCASTER_DEFAULT_ACCOUNT_ID (legacy fallback) |
| `FARCASTER_MODE`              | no       | `polling`        | `polling` or `webhook` |
| `FARCASTER_HUB_URL`           | no       | `hub.pinata.cloud` | Farcaster hub base URL |
| `FARCASTER_POLL_INTERVAL`     | no       | `120`            | Polling interval in seconds |
| `FARCASTER_DRY_RUN`           | no       | `false`          | Simulate actions without publishing |
| `MAX_CAST_LENGTH`             | no       | `320`            | Max cast character length |
| `ENABLE_CAST`                 | no       | `true`           | Enable autonomous cast loop |
| `CAST_INTERVAL_MIN`           | no       | `90`             | Min minutes between autonomous casts |
| `CAST_INTERVAL_MAX`           | no       | `180`            | Max minutes between autonomous casts |
| `CAST_IMMEDIATELY`            | no       | `false`          | Post first cast immediately on start |
| `ENABLE_ACTION_PROCESSING`    | no       | `false`          | Process interactions/mentions automatically |
| `ACTION_INTERVAL`             | no       | `5`              | Minutes between action-processing cycles |
| `MAX_ACTIONS_PROCESSING`      | no       | `1`              | Max interactions processed per cycle |

## How to extend

**Add an action:** create `actions/<MyAction>.ts` exporting a `const myAction: Action`, import and add it to the `actions: []` array in `index.ts`.

**Add a provider:** create `providers/<myProvider>.ts` exporting a `Provider`, add it to `farcasterProviders` in `providers/index.ts`.

**Add a route:** add a `Route` object to the array in `routes/webhook.ts`, or create a new file and import it into `index.ts` alongside `farcasterWebhookRoutes`.

**Add a service:** implement `class MyService extends Service` with `static serviceType`, add it to `farcasterPlugin.services` in `index.ts`.

## Conventions / gotchas

- **Neynar SDK is the only Farcaster API client.** `FarcasterClient` wraps `@neynar/nodejs-sdk`. All hub/network calls go through it. Do not call Neynar endpoints directly elsewhere.
- **Cast deletion is not supported by the Farcaster protocol.** `FarcasterCastService.deleteCast` logs a warning and returns — this is intentional.
- **Multi-account support.** `FarcasterService` tracks a map of `agentId → { managers, castServices, messageServices }`. Env vars can be namespaced by account ID, or a full multi-account config can be passed as a JSON array via `FARCASTER_ACCOUNTS`. Use `listFarcasterAccountIds` / `normalizeFarcasterAccountId` from `utils/config.ts` — do not hand-roll account ID logic.
- **Post connector registration.** `FarcasterService.registerSendHandlers` wires `FarcasterCastService.handleSendPost` / `fetchFeed` / `searchPosts` into the runtime's `registerPostConnector`. This only succeeds if the runtime supports that method; absence is silently skipped.
- **LRU caches.** `FarcasterClient` caches cast lookups (TTL 30 min, max 9 000 entries) and profile lookups (TTL 15 min, max 1 000). Keep this in mind during testing — stale cache entries will not trigger network calls.
- **Webhook mode vs polling mode.** Set `FARCASTER_MODE=webhook` and point Neynar to `POST /webhook` on your agent's public URL. In `polling` mode, `InteractionManager` fetches mentions on `FARCASTER_POLL_INTERVAL`.
- **`generated/specs/`** — auto-generated; do not edit by hand. Provider spec names (`requireProviderSpec("farcasterProfile")`) come from here.
- **Browser build is a proxy boundary.** The `browser` export condition (`dist/browser/`) builds `index.browser.ts`, which only re-exports the types and an unsupported-browser `farcasterPlugin` whose `init` logs a warning ("not supported directly in browsers. Use a server proxy"). The real Neynar-backed plugin runs Node-only; browsers must call it through a server proxy.

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
