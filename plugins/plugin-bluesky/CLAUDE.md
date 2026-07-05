# @elizaos/plugin-bluesky

AT Protocol (BlueSky) social client for elizaOS agents.

## Purpose / role

Adds BlueSky integration to any Eliza agent: public-feed posting, direct messages via `chat.bsky`, and notification polling. Loaded as a standard elizaOS plugin (`blueSkyPlugin` exported from `index.ts`). Opt-in — initialization is unavailable unless `BLUESKY_HANDLE` and `BLUESKY_PASSWORD` are configured (or when `BLUESKY_ENABLED` is explicitly `false`). Supports multiple BlueSky handles per agent via `BLUESKY_ACCOUNTS` JSON or `character.settings.bluesky.accounts`.

## Plugin surface

**Services** (registered in `plugin.services`):
- `BlueSkyService` — singleton orchestrator; authenticates one `BlueSkyClient` per configured account, starts `BlueSkyAgentManager`, `BlueSkyMessageService`, and `BlueSkyPostService` per account. Registers message and post connectors with the runtime on startup.
- `BlueskyWorkflowCredentialProvider` — supplies Bluesky `httpHeaderAuth` credentials to the workflow plugin; duck-typed on `"workflow_credential_provider"` service type.

**Actions:** none registered.

**Providers:** none registered in the plugin object. A `ConnectorAccountProvider` (`createBlueSkyConnectorAccountProvider`) is registered with `ConnectorAccountManager` inside `plugin.init` — not a runtime provider.

**Evaluators:** none.

**Routes:** none.

**Events emitted** (via `runtime.emitEvent`):
| Event | Trigger |
|---|---|
| `bluesky.mention_received` | Incoming mention or reply notification |
| `bluesky.follow_received` | New follower notification |
| `bluesky.like_received` | Like notification |
| `bluesky.repost_received` | Repost notification |
| `bluesky.quote_received` | Quote notification |
| `bluesky.should_respond` | Mention/reply reaching action-processing cycle |
| `bluesky.create_post` | Automated posting timer fires |

**Runtime connectors registered:**
- Message connector (`source: "bluesky"`) — DM send/receive, target resolution, room listing.
- Post connector (`source: "bluesky"`) — public-post publishing, feed fetch, post search.

## Layout

```
plugins/plugin-bluesky/
├── index.ts                        Plugin export (blueSkyPlugin); PluginConfig interface
├── index.node.ts                   Re-exports index.ts (node entrypoint)
├── index.browser.ts                Re-exports index.ts (browser entrypoint)
├── client.ts                       BlueSkyClient — wraps @atproto/api BskyAgent;
│                                   authenticate, sendPost, sendMessage, getTimeline,
│                                   searchPosts, getNotifications, getConversations,
│                                   getMessages, likePost, repost, deletePost
├── connector-account-provider.ts   ConnectorAccountProvider adapter (BLUESKY_PROVIDER_ID)
├── workflow-credential-provider.ts BlueskyWorkflowCredentialProvider service
├── prompts.ts                      LLM prompt templates for DM and post generation
├── types/
│   └── index.ts                    All domain types: BlueSkyConfig, BlueSkyPost,
│                                   BlueSkyMessage, BlueSkyConversation, BlueSkyError,
│                                   event payload interfaces, Zod config schema
├── utils/
│   └── config.ts                   Config resolution: validateBlueSkyConfig,
│                                   hasBlueSkyEnabled, listBlueSkyAccountIds,
│                                   normalizeBlueSkyAccountId, readBlueSkyAccountId
├── services/
│   ├── bluesky.ts                  BlueSkyService (main Service class)
│   ├── message.ts                  BlueSkyMessageService — DM fetch/send/connector API
│   └── post.ts                     BlueSkyPostService — post publish/feed fetch/search
└── managers/
    └── agent.ts                    BlueSkyAgentManager — polling timers, notification
                                    dispatch, automated post scheduling
```

## Commands

```bash
bun run --cwd plugins/plugin-bluesky build        # compile (Bun.build + tsc for .d.ts)
bun run --cwd plugins/plugin-bluesky dev          # watch build (--hot)
bun run --cwd plugins/plugin-bluesky test         # vitest run
bun run --cwd plugins/plugin-bluesky typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-bluesky lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-bluesky clean        # rm dist .turbo
```

## Config / env vars

| Var | Required | Default | Description |
|---|---|---|---|
| `BLUESKY_HANDLE` | yes | — | AT Protocol handle (e.g. `agent.bsky.social`) |
| `BLUESKY_PASSWORD` | yes | — | BlueSky app password |
| `BLUESKY_ENABLED` | no | inferred | Explicit enable/disable override |
| `BLUESKY_SERVICE` | no | `https://bsky.social` | PDS URL |
| `BLUESKY_DRY_RUN` | no | `false` | Log operations without executing |
| `BLUESKY_POLL_INTERVAL` | no | `60` | Notification poll interval (seconds) |
| `BLUESKY_ENABLE_POSTING` | no | `true` | Enable automated posting loop |
| `BLUESKY_POST_INTERVAL_MIN` | no | `1800` | Min seconds between auto-posts |
| `BLUESKY_POST_INTERVAL_MAX` | no | `3600` | Max seconds between auto-posts |
| `BLUESKY_POST_IMMEDIATELY` | no | `false` | Post on first startup tick |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | no | `true` | Run mention/reply response cycle |
| `BLUESKY_ACTION_INTERVAL` | no | `120` | Action-processing interval (seconds) |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | no | `5` | Max notifications per action batch |
| `BLUESKY_ENABLE_DMS` | no | `true` | Enable DM connector |
| `BLUESKY_MAX_POST_LENGTH` | no | `300` | Character cap for posts |
| `BLUESKY_ACCOUNTS` | no | — | JSON array/object for multi-handle config |
| `BLUESKY_DEFAULT_ACCOUNT_ID` | no | `"default"` | Which account handle to use as default |

Config is resolved in priority order: per-account env/character settings → top-level character settings → env vars. See `utils/config.ts:validateBlueSkyConfig`.

## How to extend

**Add a new action** (e.g. `LIKE_POST`):
1. Create `plugins/plugin-bluesky/actions/like-post.ts` — export an `Action` that calls `BlueSkyService` → `getPostServiceForAccount` → `client.likePost`.
2. Import and add it to `blueSkyPlugin.actions` in `index.ts`.

**Add a new service** (e.g. list-management):
1. Create `plugins/plugin-bluesky/services/list.ts` — extend nothing; accept `BlueSkyClient` and `IAgentRuntime` in constructor.
2. Instantiate in `BlueSkyService.start` alongside the existing message/post services.
3. Expose via a new getter on `BlueSkyService`.

**Listen to plugin events** in another plugin or character handler:
```ts
runtime.on("bluesky.mention_received", (payload: BlueSkyNotificationEventPayload) => {
  // payload.notification, payload.accountId, payload.runtime
});
```

## Conventions / gotchas

- **No actions registered.** The plugin is a connector/service plugin only. Social behaviors (reply generation, post creation) are driven by event handlers in the application layer responding to `bluesky.*` events, not by elizaOS actions.
- **Dry-run mode.** When `BLUESKY_DRY_RUN=true`, `BlueSkyClient` records intended writes without calling Bluesky (post, delete, like, repost, sendMessage). `sendPost`/`sendMessage` return synthetic dry-run objects; `deletePost`/`likePost`/`repost` log the intended operation and return. Useful for testing without hitting the API.
- **Multi-account.** Pass `BLUESKY_ACCOUNTS` as a JSON object keyed by account ID, or an array with `accountId` fields. Each account gets its own `BlueSkyClient`, `BlueSkyAgentManager`, and sub-services. The `"default"` account ID reads top-level env vars.
- **Post limit.** AT Protocol enforces 300 grapheme-character posts. `BlueSkyPostService` uses LLM-assisted truncation via `prompts.ts` if generated content exceeds the limit.
- **Auth.** BlueSky uses app passwords — not the main account password. Generate at `https://bsky.app/settings/app-passwords`.
- **Dual build.** Both browser and node builds are emitted. The browser build is functionally identical; `@atproto/api` supports both environments.
- **`@noble/hashes` pin.** The `resolutions` and `overrides` in `package.json` pin `@noble/hashes` to `2.2.0` to avoid version conflicts from `@atproto/*` deps.
- **Root AGENTS.md** covers logger-only rule, ESM, architecture commandments, and git workflow. This file covers only plugin-specific conventions.

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
