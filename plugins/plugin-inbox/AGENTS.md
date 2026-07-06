# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher for Eliza agents.

## Purpose / role

Adds the inbox-zero workflow to an agent: a single `INBOX` umbrella action (op-based dispatch), `INBOX_TRIAGE` + `CROSS_CHANNEL_CONTEXT` providers that surface unresolved threads to the planner each turn, and a registered `/inbox` view for human review. Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar non-SMS channels. Android SMS stays in `@elizaos/plugin-messages`.

This package owns the triage domain carved out of `plugin-lifeops`: the persisted queue, queue operations, providers, schema, migration, and terminal/app view registration. It also owns the cross-channel **aggregation domain** (`src/inbox/aggregate.ts`: channel normalization, `buildInbox` thread grouping, `resolveInboxRequest`, LLM priority orchestration, and the cached read-through `InboxDomain`) plus the LLM priority scorer (`src/inbox/priority-scoring.ts`). `@elizaos/plugin-personal-assistant` keeps the transport route (`GET /api/lifeops/inbox`), the `life_inbox_messages` cache tables in `app_lifeops`, and the Gmail/X connector projections — it composes the `InboxDomain` by injecting those through the typed seams (`InboxMessageCache`, `PriorityScoringSettingsLoader`, `GmailInboxSource`/`XDmInboxSource`) and keeps behavior-identical re-export shims at the old import paths.

## Plugin surface

### Action

- `INBOX` (`src/actions/inbox.ts`) — single umbrella action with op-based dispatch. Accepted ops: `list`, `search`, `summarize`, `triage`, `reply`, `snooze`, `archive`, `approve`. `list`/`search`/`summarize` fan out through per-platform fetchers; `triage` reads the persisted unresolved queue; `reply` drafts/sends via MESSAGE triage adapters; `snooze` hides entries until an ISO timestamp; `archive` runs connector archive and resolves on success; `approve` sends the stored draft or suggested response.

### Providers

- `INBOX_TRIAGE` (`src/providers/inbox-triage.ts`) — position `14`. Emits the owner's pending urgent/needs-reply queue and recent auto-replies from `InboxRepository`.
- `CROSS_CHANNEL_CONTEXT` (`src/providers/cross-channel-context.ts`) — position `-3`. Emits recent unresolved activity for the current counterparty across other channels.

### Routes

- `GET /api/lifeops/inbox/triage` — list unresolved triage entries, optionally filtered by `classification`, `limit`, and `includeSnoozed`.
- `POST /api/lifeops/inbox/triage` — classify/persist inbound messages through `InboxService.triage`.
- `POST /api/lifeops/inbox/:id/reply` — draft or send a connector-backed reply.
- `POST /api/lifeops/inbox/:id/snooze` — set `snoozed_until`.
- `POST /api/lifeops/inbox/:id/archive` — archive through the connector adapter and resolve on success.
- `POST /api/lifeops/inbox/:id/approve` — send the stored draft/suggested response.

### Schema

- `inboxSchema` (`src/db/schema.ts`) — `pgSchema("app_inbox")` with the three
  inbox-triage tables carved out of PA's `app_lifeops`:
  - `life_inbox_triage_entries` — per-thread triage decisions + draft replies.
  - `life_inbox_triage_examples` — owner-labeled few-shot classification examples.
  - `life_email_unsubscribes` — email unsubscribe attempts + outcomes.
  Registered via the plugin `schema` field; `InboxMigrationService`
  (`src/inbox/migration.ts`) does the non-destructive `app_lifeops -> app_inbox`
  copy (skip if source missing / target non-empty, never drop the source) and
  repairs older `app_inbox.life_inbox_triage_entries` tables by adding
  `snoozed_until` if missing. PA
  auto-registers this plugin (`ensureLifeOpsInboxPluginRegistered`) so the schema
  exists + the migration runs whenever PA is loaded. The gmail sync/projection
  tables (`life_gmail_*`, `life_inbox_messages`) are NOT part of this domain —
  they stay PA-owned in `app_lifeops`.

### View

- `inbox` — `InboxView` component, path `/inbox`, bundle at `dist/views/bundle.js`. Shows the cross-channel inbox surface using the shared app client.

## Layout

```
src/
  index.ts                            Public API barrel
  plugin.ts                           inboxPlugin definition (action + providers + schema + view)
  types.ts                            TriageDecision, ThreadSummary, channel + decision enums
  actions/
    inbox.ts                          INBOX umbrella action — fan-out + triage queue ops
  routes/
    inbox-routes.ts                   Triage read/write + reply/snooze/archive/approve HTTP routes
  providers/
    inbox-triage.ts                   INBOX_TRIAGE provider
    cross-channel-context.ts          CROSS_CHANNEL_CONTEXT provider
  inbox/
    service.ts                        InboxService — classify/curate/search/list/digest/resolve/snooze
    repository.ts                     InboxRepository — raw SQL over app_inbox.life_inbox_triage_*
    migration.ts                      app_lifeops -> app_inbox copy + additive repair
    types.ts                          InboundMessage, TriageEntry, TriageClassification, etc.
    triage-classifier.ts              LLM classification of inbound messages
    aggregate.ts                      Cross-channel aggregation domain: builders,
                                      resolveInboxRequest, LLM-score orchestration,
                                      cached read-through InboxDomain (host seams:
                                      InboxMessageCache, PriorityScoringSettingsLoader,
                                      Gmail/X sources)
    priority-scoring.ts               LLM inbox priority scorer (batched, cached,
                                      concurrency-capped)
  db/
    index.ts                          re-exports schema.ts
    schema.ts                         drizzle pgSchema('app_inbox') + 3 tables
  components/
    inbox/
      InboxView.tsx                   Minimal React inbox view (placeholder)
      inbox-view-bundle.ts            Vite bundle entry — re-exports InboxView
```

## Commands

```bash
bun run --cwd plugins/plugin-inbox typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-inbox lint         # biome check src/
bun run --cwd plugins/plugin-inbox test         # vitest run
bun run --cwd plugins/plugin-inbox build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-inbox build:js     # tsup
bun run --cwd plugins/plugin-inbox build:views  # vite build (overlay bundle)
bun run --cwd plugins/plugin-inbox build:types  # tsc declaration emit
bun run --cwd plugins/plugin-inbox clean        # rm -rf dist
```

## Config / env vars

None. Channel credentials are read from each provider plugin (`plugin-discord`, `plugin-telegram`, etc.).

## How to extend

**Add a new op:** add the name to `SUBACTIONS` in `src/actions/inbox.ts`, add a case to the handler or `executeInboxQueueOperation`, and extend the action `parameters` array when the op needs new inputs. Queue ops should go through `InboxRepository` and, for connector dispatch, the shared MESSAGE triage service.

**Add a provider:** create `src/providers/<name>.ts` exporting a `Provider`, then add it to the `providers` array in `src/plugin.ts`.

**Add a service:** define the class in `src/service.ts`, add it to the `services` array in `src/plugin.ts`, and export it from `src/index.ts` so callers can resolve it via `runtime.getService`.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first.** The schema registration relies on the runtime's `runtime.db`. The plugin declares this in `dependencies: ["@elizaos/plugin-sql"]`.
- **No Android SMS.** SMS routing intentionally stays in `plugin-messages`. Do not add SMS channel handling here.
- **Schema name is `app_inbox`** (not `inbox`) to avoid collisions with any host-app `inbox` table the runtime might also surface.
- **Snooze is additive.** `snoozed_until` is append-only schema growth on `life_inbox_triage_entries`; migration repairs old targets and maps old `app_lifeops` rows with `NULL AS snoozed_until`.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. The views bundle (`dist/views/bundle.js`) is what the view registration's `bundlePath` points to. Both must be run for a complete build.
- **Peer deps.** React 19 and react-dom 19 are peer dependencies. The host app must provide them.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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
