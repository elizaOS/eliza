# #8652 — plugin-inbox real port (Leg W8, wave 3)

Branch: `feat/ui-mobile-gap-burndown` (worktree `ui-mobile-wave3`, base develop 5471346e7a6).

## Research inventory (before code changes)

### What already lives in `plugins/plugin-inbox` (verified 2026-07-02, develop tip)

The #8652 reopen prose ("#8670 only registered a cross-channel context provider") is
STALE. Since then (#10778 "complete inbox ops" + follow-ups) plugin-inbox already owns:

- `INBOX` umbrella action (`src/actions/inbox.ts`) with op dispatch
  (list/search/summarize/triage/reply/snooze/archive/approve).
- `inboxTriage` + `inboxCrossChannelContext` providers.
- `InboxService` / `InboxRepository` / `triage-classifier` / `unsubscribe-service` /
  `email-curation` / `gmail-normalize` / `message-fetcher` (cross-channel fetch seam).
- Routes: `GET/POST /api/lifeops/inbox/triage`, `POST /api/lifeops/inbox/:id/{reply,snooze,archive,approve}`.
- `app_inbox` drizzle schema + `InboxMigrationService` (app_lifeops -> app_inbox copy).
- `InboxView` / `InboxSpatialView` UI + view registration (`/inbox`).
- 12 test suites incl. `inbox-routes.test.ts`, `inbox.real-db.test.ts`, `inbox.live-llm.test.ts`.

PA already carries re-export shims for `inbox/repository`, `inbox/types`,
`inbox/message-fetcher`, `actions/inbox`.

### What was still left UN-ported in plugin-personal-assistant (the gap this leg closes)

1. **The cross-channel inbox aggregation domain** —
   `src/lifeops/domains/inbox-service.ts` (914 lines): `normalizeInboxChannel`,
   `toInboxMessage(s)`, `buildInbox(FromMessages)`, thread grouping + small-group
   heuristic scoring, missed-message filter, `resolveInboxRequest`, LLM-score
   orchestration (`buildInboxWithLlm`/`fetchInbox`) and the `InboxDomain` cached
   read-through spine. Its input type (`InboundMessage`) and fetcher
   (`fetchAllMessages`) ALREADY live in plugin-inbox — the builders were stranded.
2. **`src/lifeops/priority-scoring.ts`** (442 lines) — LLM inbox priority scorer.
   Only importer: inbox-service.ts. Deps: `@elizaos/core` + `@elizaos/shared` only.
   Pure inbox-domain code sitting in PA.
3. **Runtime-dead duplicate provider**: PA's `src/providers/inbox-triage.ts`
   (179-line copy with LifeOps egress plumbing). Verified against
   `packages/core/src/runtime.ts` `registerPlugin`: plugin `init()` runs BEFORE the
   plugin's own `actions`/`providers` arrays register, and PA's `init()` calls
   `ensureLifeOpsInboxPluginRegistered` -> plugin-inbox's `inboxTriage` provider
   registers FIRST -> PA's same-named copy is skipped as a duplicate. PA's copy is
   dead code at runtime. Same for PA's `...promoteSubactionsToActions(inboxAction)`
   spread. See `registration-dedup-proof.txt`.
4. **Registration gap**: plugin-inbox registered only the raw INBOX umbrella, so
   standalone plugin-inbox (without PA) was missing the INBOX_LIST/INBOX_TRIAGE/...
   virtual actions that PA scenarios (`inbox-triage-capability.scenario.ts`) rely on.

### What stays in PA (owner-policy projections, per plugin-boundary doctrine)

- `GET /api/lifeops/inbox` route (in `routes/lifeops-routes.ts`) — the transport
  home for the aggregated read; UI (`packages/ui` conversations sidebar/widgets)
  consumes this path. Route stays; its implementation delegates to the moved
  domain via `LifeOpsService.getInbox`.
- The `life_inbox_messages` cache tables + `LifeOpsRepository` cache methods
  (frozen decision: gmail/projection tables stay PA-owned in `app_lifeops`).
  Injected into the moved `InboxDomain` behind the typed `InboxMessageCache` seam
  (LifeOpsRepository satisfies it structurally — verified by PA typecheck).
- Gmail/X connector sources (LifeOps service mixins) — injected via the existing
  `GmailInboxSource`/`XDmInboxSource` interfaces (already plugin-inbox types).
- Priority-scoring *settings* (LifeOps app-state) — injected as the typed
  `PriorityScoringSettingsLoader` seam (PA keeps the load-failure fallback +
  structured warn; the domain default is enabled + default small model).
- PA's `crossChannelContext` provider (`providers/cross-channel-context.ts`) is NOT
  a duplicate of plugin-inbox's `inboxCrossChannelContext`: PA's is signal-driven
  memory search (WS1), plugin-inbox's reads the triage store. Different names,
  different data sources — both intentionally live.

## Implemented split

- MOVED to `plugins/plugin-inbox/src/inbox/aggregate.ts` (verbatim except the
  seam injection — diffed by hand against the original): the whole aggregation
  domain with three injected seams (`InboxMessageCache`,
  `PriorityScoringSettingsLoader`, Gmail/X source interfaces).
  `InboxDomain.markInboxEntryRead` returns `null` on miss; PA's service keeps the
  `requireNonEmptyString` input check + HTTP 404 mapping (transport concern stays
  at the host boundary).
- MOVED to `plugins/plugin-inbox/src/inbox/priority-scoring.ts`: the LLM scorer
  (comment-only diff vs the PA original).
- plugin-inbox `plugin.ts` registers `...promoteSubactionsToActions(inboxAction)`
  so the INBOX_* virtuals exist wherever the plugin loads (incl. standalone);
  exports + `/inbox/aggregate`, `/inbox/priority-scoring` subpaths via the
  package's `./*` export map.
- PA keeps behavior-identical back-compat shims at every old import path
  (`lifeops/domains/inbox-service.ts`, `lifeops/priority-scoring.ts`,
  `providers/inbox-triage.ts`) and DROPS the runtime-dead duplicate
  registrations from `plugin.ts` (provider array entry + INBOX promote spread).
- PA `lifeops/service.ts` composes the moved domain: `new InboxDomain({ runtime,
  cache: this.repository, sources: {...}, loadPriorityScoringSettings })` and maps
  the null miss to `fail(404, ...)` in `markInboxEntryRead`.
- Pre-existing develop-tip red fixed in the inbox domain:
  `test/lifeops-inbox-triage.integration.test.ts` seeded classification `"fyi"`,
  which the carved plugin-inbox repository vocabulary
  (ignore/info/notify/needs_reply/urgent, #10778) rejects at row-parse. Changed to
  `"info"` (same low-priority ranking intent); integration lane now green.
- LifeOps commandments respected: no second store (cache stays PA, triage store
  stays plugin-inbox), no promptInstructions-driven behavior, typed seams only.

## New tests

- `plugins/plugin-inbox/test/inbox-routes.real-runtime.test.ts` — route-level e2e:
  REAL `inboxPlugin` registered STANDALONE on a REAL PGLite AgentRuntime, driving
  the runtime-registered route handlers (403 non-owner on all six routes, empty
  read, invalid-body 400s, real triage POST persisting real `app_inbox` rows,
  classification/limit filters + bogus-filter fallback, snooze round-trip incl.
  includeSnoozed, unknown-id and bad-timestamp errors, approve-without-draft,
  reply validation, source-id dedup on re-triage). Also asserts the #8652
  registration contract (INBOX_* virtuals + both providers standalone). Only
  TEXT_SMALL is deterministic (the LLM boundary).
- `plugins/plugin-inbox/test/inbox-aggregate.real-runtime.test.ts` — the moved
  aggregation domain on a real runtime: builder edge cases
  (normalizeInboxChannel, resolveInboxRequest clamping/filtering, buildInbox
  thread grouping + allow-list + channel counts), and the `InboxDomain` cached
  read-through spine through contract-true seam implementations (cache-only mode
  never touches sources, fresh-cache short-circuit, refresh fetch + double upsert
  + LLM scores round-tripped into the cache, scoring-disabled policy never
  consults the model, markInboxEntryRead null-on-miss).
- Both are in the default vitest lane (`test/**/*.test.ts`, not matching the
  `*.e2e.test`/`*.integration.test` excludes) — they run in CI with the package
  suite.

## Evidence files (all reviewed by hand)

- `test-plugin-inbox.txt` — full plugin-inbox suite: 18 files passed, 1 skipped
  (live-llm gate), 135 tests passed / 2 skipped, exit 0.
- `test-pa-inbox-subset.txt` — PA inbox-adjacent suites via the shims
  (service-mixin-inbox, connector-adversarial-injection, inbox-action) 19/19 +
  integration lane lifeops-inbox-triage 4/4 (incl. the fyi->info fix), green.
- `test-pa-full.txt` — FULL PA suite after all changes: 123 files, 997 passed /
  2 skipped, exit 0.
- `typecheck.txt` — plugin-inbox (tsgo) + PA (tsc) both exit 0.
- `registration-dedup-proof.txt` — registration-order proof that PA's provider
  copy + INBOX spread were dead at runtime, and the standalone-registration test
  that pins the post-port contract.
- `live-priority-scoring-run.ts` + `live-cerebras-priority-scoring.json` —
  LIVE-LLM trajectory: the REAL moved scorer (`scoreInboxMessages` — real prompt
  builder, batching, parser) against LIVE Cerebras `gpt-oss-120b`. Reviewed by
  hand: overdue invoice -> 90/important [money,deadline,urgent]; casual gaming
  ping -> 20/casual; appointment confirm -> 78/planning; family dinner ask ->
  70/planning. Raw prompt + raw model output captured; swept for key material
  (none).
- Lint: `bun run --cwd plugins/plugin-inbox lint` exit 0; biome check clean on
  every touched PA file (remaining warnings are pre-existing in verbatim-moved
  code and neighboring suites).

## Explicit N/A rows (PR_EVIDENCE matrix)

- Screenshots / video / audit:app — N/A: no UI pixels change; the port is a
  domain re-home with behavior-identical shims (InboxView untouched; the
  `GET /api/lifeops/inbox` DTO is byte-identical, proven by the verbatim-move
  diff + full PA suite).
- Device/simulator captures — N/A: no native surface touched.
- Backend `[ClassName]` logs — covered by the real-runtime suites' structured
  logs inside the captured vitest runs (migration service + SQL plugin boot in
  test-plugin-inbox.txt).
