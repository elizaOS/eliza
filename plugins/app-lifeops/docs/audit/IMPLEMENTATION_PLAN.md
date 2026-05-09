# LifeOps — Implementation Plan

**Companion document to:** `UX_JOURNEYS.md`, `HARDCODING_AUDIT.md`, `GAP_ASSESSMENT.md`, `JOURNEY_GAME_THROUGH.md`.

**Goal:** deliver the capability-driven LifeOps described in `GAP_ASSESSMENT.md` (one spine primitive `ScheduledTask`, supporting capabilities including the `ENTITY` + `RELATIONSHIP` knowledge-graph primitive, an extracted `plugin-health`, a first-run capability, and the new providers / stores surfaced by the journey game-through) using a **three-wave parallel-agent delivery model**.

**Date:** 2026-05-09 (revised from the prior 7-phase, 2-wave, and PEOPLE-consolidation plans).

**Status:** rewritten 2026-05-09 to incorporate (1) the user's ENTITY + RELATIONSHIP knowledge-graph revision (nodes carry per-connector identities; edges are typed extracted relationships with their own metadata; the prior PEOPLE-consolidation revision is replaced because it flattened nodes and edges), (2) the 10 top game-through findings + 6 review additions baked into the schema and supporting capabilities, and (3) a third "review + integration + finish" wave so the parallel work converges into a coherent shippable system rather than ending at "Wave 2 done."

---

## §1 Delivery model

### 1.1 Three waves

- **Wave 1 — Foundations.** 7 parallel agents. Land the spine (`ScheduledTask` with the schema fixes from the game-through), the `ENTITY` + `RELATIONSHIP` knowledge-graph primitive (nodes + typed edges, two stores), extracted `plugin-health`, the first-run capability + the inbound-correlation / quiet-user / global-pause providers, default-pack curation with the consolidation policy on `wake.confirmed`, the connector + transport contract drafts, and repo hygiene.
- **Wave 2 — Migration onto foundations.** 7 parallel agents. Migrate every scenario-named action onto `ScheduledTask`; rename `RELATIONSHIP` umbrella → `ENTITY` umbrella (the user-visible verb covers entity CRUD + relationship-edge CRUD; the data layer is two stores) and collapse the duplicate follow-up surface; unify connectors / channels through the contracts; decompose `CALENDAR`; generalize signal-bus + anchors; ship multilingual + the real `OwnerFactStore`; ship blocker registry; ship handoff verb + store; relax the contract test; e2e-test the spine end-to-end.
- **Wave 3 — Review + integration + finish.** **Sequential.** This is the human-in-the-loop wave: a curation pass over default packs against real journeys, prompt-content lint promoted from warning to CI-fail, full e2e replay across all 28 journey domains, AGENTS.md + docs updates reflecting the new architecture, and a final integration gate. No code surface changes that don't fall out of the review.

Parallelism is the lever for calendar time. The integration gate at the end of each wave is a hard gate; no work in the next wave begins until the previous wave's gate is clean.

### 1.2 Principles

1. **Owned surfaces don't overlap.** Every Wave-N agent's deliverable list names specific files / dirs; no two agents in the same wave touch the same file. File-conflict resolution is a wave-coordinator concern (§2.2), not a per-agent concern.
2. **Verification gate per wave.** `bun run verify` (typecheck + lint), targeted tests for every changed surface, smoke run of the journey-domain set, PII grep clean, lint-pass clean. No wave exits with red CI.
3. **Default packs ship with foundations.** Wave 1 lands the curation as W1-D; the agent doesn't feel empty mid-migration.
4. **Atomic moves preferred over phased re-plumbing.** `plugin-health` extraction is one atomic move in Wave 1, not a re-export dance.
5. **Capability-fication is registry-driven, not LLM-driven.** Per `GAP_ASSESSMENT.md` §8.3: umbrellas stay user-visible; registries are dispatcher-internal.
6. **Independent shippability inside each wave.** A single Wave-N agent's output is independently mergeable; the integration gate enforces cross-agent consistency.
7. **ENTITY (nodes) + RELATIONSHIP (edges) is the knowledge-graph model.** Per the user's revision: nodes are `Entity` rows (person, organization, place, project, concept) carrying per-connector identities; edges are typed `Relationship` rows extracted from observations and carrying their own metadata (cadence, role, sentiment). The PEOPLE design that flattened this into one record is replaced (`GAP_ASSESSMENT.md` §3.4). The user-visible umbrella is `ENTITY` (CRUD on the entity AND its edges); the data layer is two stores (`EntityStore` + `RelationshipStore`).
8. **Game-through fixes are baked into the schema, not deferred.** Multi-gate `shouldFire` array, terminal-state taxonomy, `output` destination, `contextRequest`, `subject`, `idempotencyKey`, `respectsGlobalPause`, `reopen` verb, snooze-resets-ladder, priority→posture mapping, quiet-hours-as-gate, late-inbound-reopen window — all in §2.3 of `GAP_ASSESSMENT.md`. Wave-1 agents build to that schema, not to the prior shape.

### 1.3 What changed from the prior 2-wave plan

| Prior (2 waves) | New (3 waves) |
|---|---|
| `RELATIONSHIP` → `CONTACTS` rename in W2-A | `RELATIONSHIP` umbrella → `ENTITY` umbrella (per the user's revision). The data layer splits into `EntityStore` (nodes with multi-identity) + `RelationshipStore` (typed edges with their own metadata). Supersedes both the original CONTACTS rename and the prior PEOPLE-consolidation revision. Owned by Wave-1 agent W1-E. |
| `IdentityGraph + ContactResolver` was W2-D | Subsumed by `EntityStore` + `RelationshipStore` (W1-E). The resolver becomes `EntityStore.resolve`; the graph IS the (Entity, Relationship) pair. W2-D narrows to signal-bus + anchors + identity-observations cleanup. |
| 10 top game-through findings flagged but not pinned | All 10 + 6 review additions pinned in `GAP_ASSESSMENT.md` §2.3 / §3.11–§3.17 / §8.7–§8.15; Wave-1 agents build to the pinned schema. |
| `ScheduledTask` had single-gate `shouldFire`, no `output`, no `subject`, no `kind` | Wave-1 W1-A builds the multi-gate / output / subject / kind / contextRequest / idempotencyKey schema directly. `subject.kind` accepts `"entity" | "relationship"` so cadence-bearing followups target the edge. |
| 6 Wave-1 agents | 7 Wave-1 agents (ENTITY + RELATIONSHIP added; first-run-capability agent expanded to also own the inbound-correlation / quiet-user / global-pause providers). |
| 7 Wave-2 agents | 7 Wave-2 agents (W2-D narrowed; W2-G expanded to own HandoffStore + handoff verb; renames updated). |
| Plan ended at Wave 2 integration gate | Wave 3 added: sequential review + integration + finish, with explicit deliverables and a final gate. |
| Default escalation / quiet hours / priority posture were "open questions" | Pinned in `GAP_ASSESSMENT.md` §8.7 / §8.8 / §8.11; Wave-1 agents implement. |

### 1.4 Wave coordinator

A single coordinator (the user, working with this assistant) governs each wave's gate. The coordinator's responsibilities:

- **Wave start:** publish the wave's `interfaces.md` (interface contract for the wave) within the first day. All agents read it; no agent ships against an outdated contract.
- **Mid-wave:** triage file-conflict claims. Two agents claiming the same file = wave-coordinator splits by section ownership.
- **Wave end:** run the integration gate. If gate fails, identify the failing agent(s), spin them on a fix; do not start the next wave until the gate is green.

The Wave-3 sequential agents run under coordinator supervision (one at a time; coordinator validates each before the next starts).

---

## §2 Pre-wave hygiene

A small batch of independent tasks that must land before parallel work begins, because they would either block parallel renames or are trivially independent.

### 2.1 Tasks

1. **Relax `prd-coverage.contract.test.ts:156-164`** — drop the "exactly 20 PRD journey rows" assertion; keep "every matrix row has a real test file" + "every test file is referenced by exactly one row". Add the spine-coverage assertion shape (`GAP_ASSESSMENT.md` §8.5). Wave-2 contract-test relaxation builds on it; Wave-1 PII renames trip the existing assertion.
   - File: `eliza/plugins/app-lifeops/test/prd-coverage.contract.test.ts:156-164`.

2. **Strip PII from source code** (independent of any other change).
   - `src/actions/calendar.ts:669` — `"daily time with Jill"` → `"recurring relationship block"`.
   - `src/actions/calendar.ts:1027` — `"sync with Marco"` → `"sync with a colleague"`.
   - `src/actions/calendar.ts:1081-1087` — `"time with Jill"` → `"recurring 1:1 with my partner"`.
   - `src/actions/lib/calendar-handler.ts:4227-4233` — same Jill example duplicated; same generic.
   - `src/actions/lib/scheduling-handler.ts:469-470` — `Jill / Marco / Sarah` literals → generic.
   - `src/actions/resolve-request.ts:489` — `"send that draft to Marco"` → `"send that draft"`.
   - `src/actions/life.ts:3509-3517` — Spanish brush-teeth ActionExample: keep generic Spanish, drop literal `"Brush teeth"` (multilingual extraction is W2-E).

3. **Strip the 18 "always-include" scenario-rehearsal tags from `src/actions/calendar.ts:663-684`** (`HARDCODING_AUDIT.md` §6 high-confidence #9). Run prompt-benchmark before commit; narrow the deletion if any calendar journeys regress.

4. **Rename PII fixtures and the chat-export catalog (atomic commit, all imports updated together).**
   - `test/scenarios/_catalogs/ice-bambam-executive-assistant.json` → `executive-assistant-transcript.catalog.json`.
   - `test/mocks/environments/lifeops-samantha.json` → `lifeops-presence-active.json`.
   - `scenarios/gmail-suran-routing.json` + `test/scenarios/gmail-suran-routing.scenario.ts` → `gmail-direct-message-sender-routing.{json,scenario.ts}`.
   - Inside the renamed catalog: replace `ea.schedule.daily-time-with-jill` etc. with `ea.schedule.recurring-relationship-block`; strip the absolute path.
   - `test/lifeops-chat.live.e2e.test.ts:811-830`, `test/lifeops-gmail-chat.live.e2e.test.ts:173-178` — replace `Suran Lee`, `suran@example.com` with `Pat Smith`, `pat@example.com`.
   - `test/helpers/lifeops-prompt-benchmark-cases.ts:138` — match catalog rename.
   - `coverage-matrix.md:13` — drop `(e.g. weekly Jill block)`.

5. **Fold `lifeops-extensions.ts` back into `lifeops.ts`** (`HARDCODING_AUDIT.md` §9 ordering hazard; the apologetic header comment is also gone). The `LifeOpsRelationship` types in this file are touched again by W1-E (knowledge-graph split), but the merge happens here so that W1-E starts from a single contracts file.

### 2.2 Verification

- `bun run verify` clean.
- `bun run test` clean.
- Prompt-benchmark suite confirms calendar routing parity post tag-strip.
- Source grep for `Jill | Marco | Sarah | Suran | ice bambam | samantha` returns zero hits in `src/`.

### 2.3 Out of scope here

- CHECKIN resolution — Wave 1 builds the spine; Wave 2 deletes the legacy action.
- PROFILE alias collapse — folds into Wave 2's `OwnerFactStore` work.
- Non-action helpers move out of `actions/` — folds into Wave-1 W1-G + Wave-2 W2-A.
- Duplicate follow-up actions — folds into Wave 2's `ScheduledTask` migration.
- `RELATIONSHIP` umbrella → `ENTITY` umbrella rename — folds into W2-A (depends on W1-E having shipped the `EntityStore` + `RelationshipStore`).

---

## §3 Wave 1 — Foundations (7 parallel agents)

### 3.1 Agent W1-A: `ScheduledTask` spine

**Scope:** the spine primitive — types matching `GAP_ASSESSMENT.md` §2.3 (with the game-through schema fixes), runner, persistence, REST surface, gate / completion-check / consolidation registries.

**Owned files / dirs (created):**
- `src/lifeops/scheduled-task/`
  - `types.ts` — types per §2.3 (multi-gate `shouldFire` array; pinned terminal-state union; `output`, `subject`, `kind`, `idempotencyKey`, `contextRequest`, `respectsGlobalPause` fields).
  - `runner.ts` — `ScheduledTaskRunner` (schedule / list / apply / pipeline; verbs `snooze | skip | complete | dismiss | escalate | acknowledge | edit | reopen`).
  - `gate-registry.ts` — `TaskGateRegistry` with built-in kinds (`weekend_skip`, `late_evening_skip`, `quiet_hours`, `during_travel`, `weekday_only`, `weekend_only`). Returns typed `GateDecision = { kind: "allow" } | { kind: "deny", reason } | { kind: "defer", until, reason }`.
  - `completion-check-registry.ts` — `CompletionCheckRegistry` (`user_acknowledged`, `user_replied_within { lookbackMinutes, requireSinceTaskFired }`, `subject_updated`, `health_signal_observed { signalKind, lookbackMinutes, requireSinceTaskFired }`).
  - `consolidation-policy.ts` — `AnchorConsolidationPolicy` registry (per §3.16); merges concurrent fires on the same anchor.
  - `escalation.ts` — escalation step evaluator. Snooze policy: resets ladder to step 0 (§8.11). Priority-default ladder: `low` = none; `medium` = 1 retry @ 30 min; `high` = 3-step cross-channel.
  - `state-log.ts` — append-only log writer; per-task `lastDecisionLog` updated on every transition; user-visible `GET /api/lifeops/scheduled-tasks/:id/history` and dev-only `GET /api/lifeops/dev/scheduled-tasks/:id/log`.
  - `index.ts` — module exports.
- `src/routes/scheduled-tasks.ts` — REST CRUD: `GET / POST /api/lifeops/scheduled-tasks`, `POST /api/lifeops/scheduled-tasks/:id/{snooze,skip,complete,acknowledge,dismiss,escalate,edit,reopen}`, `GET /api/lifeops/scheduled-tasks/:id/history`, `GET /api/lifeops/dev/scheduled-tasks/:id/log`, `GET /api/lifeops/dev/registries`.
- DB migration: `scheduled_tasks` table + `scheduled_task_log` table.

**Owned files / dirs (modified):**
- `src/lifeops/repository.ts` — add `scheduled_tasks` repository methods.
- `src/lifeops/schema.ts` — Zod schemas for `ScheduledTask`.

**Deliverables:**
- Types, runner, REST surface land green.
- Every trigger kind, every verb, every terminal state, multi-gate `shouldFire` composition, snooze-resets-ladder, `reopen` semantics covered by unit tests.
- The runner emits structured log lines on every state transition; user-visible `history` endpoint reads from the same log.
- Built-in gate kinds, completion-check kinds, anchor consolidation policy registered.

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete.

**Verification:**
- `bun run verify` clean.
- New unit tests pass: trigger kinds, verbs, multi-gate composition (`all` / `any` / `first_deny`), terminal-state assignments, snooze-resets-ladder, `reopen`-after-expired, idempotency-key dedupe, `respectsGlobalPause` skip.
- Smoke: scripted test creates a task, fires it, applies `complete`, asserts `pipeline.onComplete` fires; second test asserts `acknowledged` does NOT fire `onComplete`.

**Risk-and-tradeoff:**
- **State-log volume:** every fire / verb-application writes a row. Default 90-day retention with a nightly rollup pass — promoted from "open question" to Wave-1 deliverable per the prior review. Retention TTL is configurable; the rollup folds expired entries into a daily-summary row.
- **Migration of existing reminder/workflow data:** in Wave 1 the spine runs alongside the legacy reminder loop; the legacy loop continues to fire while Wave 2 migrates entries one at a time. No Wave-1 destructive deletes against `lifeops_workflows` / `lifeops_definitions`.
- **Stub anchor resolution:** `relative_to_anchor` triggers depend on `AnchorRegistry` content. Wave 1 ships stub anchors (`wake.confirmed = ownerFact.morningWindow.start`) so the spine isn't blocked on `plugin-health`. Real anchor resolution arrives via W1-B's contributions; the spine only needs the resolver protocol.

**Confidence:** **high** for typing / runner / registry shape (derived from existing reminder / workflow code). **Medium** for the `reopen` window default (24h is a guess; tunable via `metadata.reopenWindowHours`).

### 3.2 Agent W1-B: `plugin-health` extraction

**Scope:** atomic move of sleep / health / screen-time + the contract types into a new plugin tree.

**Owned files / dirs (created):** `eliza/plugins/plugin-health/`
- `package.json`, `tsconfig.json`, plugin entry.
- `src/contracts/health.ts` — sleep / circadian / health-metric types (moved from `packages/shared/src/contracts/lifeops.ts`).
- `src/sleep/` — `sleep-cycle.ts`, `sleep-episode-store.ts`, `sleep-regularity.ts`, `sleep-wake-events.ts`, `awake-probability.ts`, `circadian-rules.ts`.
- `src/health-bridge/` — `health-bridge.ts`, `health-connectors.ts`, `health-oauth.ts`, `service-normalize-health.ts`.
- `src/screen-time/` — `service-mixin-screentime.ts` content, refactored as a service.
- `src/connectors/` — registers `apple_health`, `google_fit`, `strava`, `fitbit`, `withings`, `oura`. Each `ConnectorContribution` reports a `DispatchResult`-typed `send` (per §3.17 — the contract is published by W1-F at wave start).
- `src/anchors/` — registers `wake.observed`, `wake.confirmed`, `bedtime.target`, `nap.start` (both `wake.observed` AND `wake.confirmed` per §10.1 — first signal vs sustained signal).
- `src/default-packs/` — bedtime / wake-up / sleep-recap default `ScheduledTask` records (consumes types from W1-A).
- `src/actions/health.ts` — moved.

**Owned files / dirs (deleted from app-lifeops):**
- `src/lifeops/sleep-cycle.ts`, `sleep-episode-store.ts`, `sleep-regularity.ts`, `sleep-wake-events.ts`, `awake-probability.ts`, `circadian-rules.ts`, `service-mixin-sleep.ts`, `health-bridge.ts`, `health-connectors.ts`, `health-oauth.ts`, `service-mixin-health.ts`, `service-mixin-screentime.ts`, `service-normalize-health.ts`, `checkin/sleep-cycle-dispatch.ts`.
- `src/actions/health.ts`, `src/actions/screen-time.ts`.
- The 8 sleep event-kinds + filter types in `packages/shared/src/contracts/lifeops.ts` (replaced with re-exports from `plugin-health` only if cross-package dependency is required; preferred: callers import from `plugin-health` directly).
- `screen-context.ts` — decision point during Wave 1: read it; if screen-time-coupled, move with W1-B; if general activity context, stays in app-lifeops. Document the decision.

**Owned files / dirs (modified):**
- `src/lifeops/service.ts` — drops sleep / health / screen-time mixins; calls `plugin-health` services through registered connectors.
- `src/plugin.ts` — declares `plugin-health` dependency; removes moved actions from registration list.
- All importers across the eliza tree of moved types are updated (~100 files; identified by grep).

**Deliverables:**
- `plugin-health` builds standalone.
- LifeOps consumes health data only through connector / signal-bus / anchor contracts.
- Existing health / sleep / screen-time tests pass against moved code.
- `wake.observed` AND `wake.confirmed` registered as separate anchors with documented hysteresis semantics (per `GAP_ASSESSMENT.md` §10.1).
- `health-platform-fallback.md` documents that non-darwin systems get `user_acknowledged` fallback for `health_signal_observed` completion checks (J8 / J15 / §10.2).

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete.
- **Soft dependency on W1-A and W1-F.** Mitigation: wave-start `interfaces.md` agreement (§1.4); W1-B builds against the contracts as published.

**Verification:**
- `bun run verify` clean across the eliza tree.
- Existing health / sleep / screen-time tests pass.
- LifeOps `bun run test` green; CI grep enforces no direct-import references to moved files.
- Smoke: sleep event fires, bus carries it, a `relative_to_anchor("wake.confirmed", 30)` task schedules correctly.
- Smoke: cross-platform — non-darwin `health_signal_observed` falls back to `user_acknowledged` with logged degradation.

**Risk-and-tradeoff:**
- **Massive import surface (~100 files):** highest-risk Wave-1 deliverable. Mitigation: this is the agent's single deliverable. Run `bun run verify` after every batch.
- **`screen-context.ts` ambiguity:** read first, decide; document in `wave1-interfaces.md`.
- **Telemetry-family discriminated union split:** Wave 1 keeps the union open as a temporary compromise if the bus contribution surface (W2-D) isn't ready; Wave 2 tightens.

**Confidence:** **high** for the move's bounds; **medium** on `screen-context.ts` placement and cross-package contract location.

### 3.3 Agent W1-C: First-run + correlation / aggregation / pause providers

**Scope:** the first-run provider + action + e2e tests for both paths, **plus** the three providers / stores surfaced by the journey game-through that are foundational for the spine to deliver on the user's check-in concern.

**Owned files / dirs (created):**

*First-run:*
- `src/providers/first-run.ts` — surfaces "first-run not yet completed" affordance to the planner. Concrete affordance schema (closes J1 finding 1): `{ kind: "first_run_pending", oneLine: "...", suggestedActionKey: "FIRST_RUN", paths: ["defaults", "customize"] }`.
- `src/actions/first-run.ts` — supports `path = "defaults" | "customize" | "replay"`. The defaults path now asks ONE question (wake time) before scheduling gm (per `GAP_ASSESSMENT.md` §8.13).
- `src/lifeops/first-run/`
  - `service.ts` — orchestrates the path; writes `OwnerFactStore` (interim wrapper around `LifeOpsOwnerProfile`); creates `ScheduledTask` records.
  - `defaults.ts` — Path A spec: ask wake time → derive morning window → schedule gm/gn/check-in/morning-brief stub. Default channel `in_app`.
  - `questions.ts` — Path B spec: 5-question set per `GAP_ASSESSMENT.md` §5.3. Q4 channel-validation per §8.15.
  - `state.ts` — completion-state read/write; partial-progress persisted (Q-by-Q) so abandon/resume works (J2 finding #4).
  - `replay.ts` — re-run semantics per `GAP_ASSESSMENT.md` §8.14: keeps existing tasks; only OwnerFactStore facts touched by questions update.
- `test/first-run-defaults.e2e.test.ts`, `test/first-run-customize.e2e.test.ts`, `test/first-run-config-validation.test.ts`, `test/first-run-replay.e2e.test.ts`, `test/first-run-abandon-resume.e2e.test.ts`.

*Inbound-correlation provider (closes J5 / J6 / J10):*
- `src/providers/pending-prompts.ts` — `PendingPromptsProvider.list(roomId)`. Ranks by recency; surfaces taskId + promptSnippet + expectedReplyKind + expiresAt. Used by the planner to route inbound to the open task's verb.
- `src/lifeops/pending-prompts/store.ts` — backing store; populated when a task with `completionCheck.kind === "user_replied_within"` (or implicit `user_acknowledged`) fires.

*Quiet-user / streak provider (closes J5 user concern, J4 streaks):*
- `src/providers/recent-task-states.ts` — `RecentTaskStatesProvider.summarize(opts)`. Returns `{ summary, streaks, notable }`.
- The "quiet-user watcher" `ScheduledTask` is registered by W1-D's daily-rhythm pack; this agent ships only the provider that watcher consumes.

*Global-pause / vacation mode (closes review addition #2):*
- `src/lifeops/global-pause/store.ts` — `GlobalPauseStore` (set / clear / current).
- `src/actions/lifeops-pause.ts` — verbs `pause`, `resume`, `wipe` (per §8.14). Confirmation gate on `wipe`.
- The runner consults `GlobalPauseStore.current()` pre-fire (W1-A's runner imports the store interface; W1-C ships the implementation).

**Owned files / dirs (modified):**
- `src/plugin.ts` — register provider + actions + stores.
- `src/lifeops/service-mixin-definitions.ts` — `checkAndOfferSeeding` / `applySeedRoutines` move into the first-run service; original methods deprecated.

**Deliverables:**
- Provider surfaces affordance; quiet after completion.
- Action runs all three paths (defaults / customize / replay).
- Defaults asks wake time; produces documented `ScheduledTask` set.
- Customize runs the 5-question flow with abandon/resume + Q4 channel-validation.
- `PendingPromptsProvider` is wired into the planner context assembly; `list(roomId)` returns open prompts.
- `RecentTaskStatesProvider` ships with `summarize` returning provider-injectable text.
- `GlobalPauseStore` + `LIFEOPS.pause/resume/wipe` actions ship; runner respects pause; tasks with `respectsGlobalPause = false` fire anyway.
- E2E + validation tests.

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete.
- **Soft dependency on W1-A** (consumes `ScheduledTask` types). Mitigation: wave-start `interfaces.md`.

**Verification:**
- E2E tests pass (defaults, customize, replay, abandon-resume).
- Validation tests confirm produced configuration is schema-valid.
- Provider goes silent post-completion; surfaces re-run affordance via `replay`.
- `PendingPromptsProvider` integration test: fire a check-in, send an inbound, assert the inbound routes to `complete` not to a fresh request.
- `GlobalPauseStore` integration test: pause, fire schedule, assert `respectsGlobalPause: true` tasks are skipped with `reason: "global_pause"`; `respectsGlobalPause: false` tasks fire.
- Re-entry: re-invoke first-run defaults after completion → routes to `replay`.

**Risk-and-tradeoff:**
- **OwnerFactStore stub:** W2-E lands the real store; Wave 1's first-run uses a thin wrapper around `LifeOpsOwnerProfile` whose interface matches the eventual shape so Wave-2 swap-in is local.
- **Affordance-noise risk:** mitigation = one short line; integration test verifies a fresh-boot chat scenario routes to first-run.
- **Pending-prompts staleness:** if a task expires while an inbound is en route, the inbound arrives after `expiresAt`. The store retains expired prompts for the `reopen` window (24h) so late replies still correlate.

**Confidence:** **high** for first-run shape (mirrors `enabled_skills`); **high** for `GlobalPauseStore` (single switch); **medium** for `PendingPromptsProvider` (correlation rule will need tuning against real journey traffic in Wave 3).

### 3.4 Agent W1-D: Default-pack curation + consolidation

**Scope:** the actual content of the default packs that ship enabled or offered; the consolidation policy on `wake.confirmed`; the prompt-content lint pass.

**Owned files / dirs (created):**
- `src/default-packs/`
  - `index.ts` — pack registration.
  - `daily-rhythm.ts` — gm reminder, gn reminder, daily check-in (`kind = "checkin"`, `priority = "medium"`, `completionCheck = { kind: "user_replied_within", params: { lookbackMinutes: 60 } }`, `pipeline.onSkip` → followup at 30 min then `expired`).
  - `morning-brief.ts` — morning-brief assembler `ScheduledTask` triggered on `wake.confirmed`.
  - `quiet-user-watcher.ts` — daily watcher that calls `RecentTaskStatesProvider.summarize` and surfaces "you've been quiet for N days" / "you missed yesterday's check-in" in the morning brief (closes J5 user concern).
  - `habit-starters.ts` — 8 habits from current `seed-routines.ts`, recast as **offered** (not auto-seeded) `ScheduledTask` records. Stretch's `shouldFire` is the multi-gate composition `{ compose: "first_deny", gates: [{ kind: "weekend_skip" }, { kind: "late_evening_skip" }, { kind: "stretch.walk_out_reset" }] }`.
  - `inbox-triage-starter.ts` — opt-in starter; if Gmail is connected, schedules a daily 9am triage `ScheduledTask`.
  - `followup-starter.ts` — cadence starter; ships the watcher `ScheduledTask` per `GAP_ASSESSMENT.md` §3.13. Reads `RelationshipStore.list({ "metadata.cadenceDays.<=": daysSinceLastInteraction })` (cadence lives on the edge, not the node — see §3.4) and creates child followup tasks with `subject = { kind: "relationship", id }`.
- `src/default-packs/consolidation-policies.ts` — registers `wake.confirmed` policy `{ mode: "merge", sortBy: "priority_desc" }` (closes J15 multi-fire spam); `bedtime.target` policy `{ mode: "sequential", staggerMinutes: 5 }`.
- `src/default-packs/escalation-ladders.ts` — registers `priority_low_default`, `priority_medium_default`, `priority_high_default` ladders consumed by the spine when a task has no explicit `escalation`.
- `src/default-packs/lint.ts` — prompt-content lint per `GAP_ASSESSMENT.md` §8.9. Scans for known-PII, absolute paths, hardcoded ISO times, embedded conditional logic. Wave-1: warnings only.
- `scripts/lint-default-packs.mjs` — runner; invoked by `bun run verify`.

**Owned files / dirs (modified):**
- `src/lifeops/seed-routines.ts` — kept as a transitional alias importing from `default-packs/habit-starters.ts`; deletion in Wave 2.
- `src/activity-profile/proactive-worker.ts:581-585` — `SEEDING_MESSAGE` is generated from default-pack metadata.

**Deliverables:**
- Documented set of `ScheduledTask` records per pack.
- Consolidation policies + default escalation ladders registered.
- Lint pass runs in `bun run verify` and warns (not fails).
- Pack-registration entry point first-run consumes.
- Curation rationale doc: per pack, why it's in / out, what the user sees on day one.

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete.
- **Soft dependency on W1-A** (uses `ScheduledTask` types).
- **Soft dependency on W1-E** (followup-starter pack reads `RelationshipStore` cadence metadata; W1-D writes the watcher task against the W1-E API surface published in `wave1-interfaces.md`).

**Verification:**
- Each pack registers without errors.
- Schema-validation tests pass per pack.
- Lint clean (zero warnings) on shipped packs.
- Smoke: fresh user picks defaults → 24 hours of simulated time produces ≤ 6 expected nudges (gm + check-in + check-in followup if no reply + gn + morning brief + sleep recap from plugin-health, all consolidated on anchor where applicable).
- Morning-brief pack's prompt + existing CHECKIN service's assembly logic produce parity content (fixture parity test).

**Risk-and-tradeoff:**
- **Curation is judgment work; not all of it is testable mechanically.** Mitigation: smoke test + Wave-3 review.
- **Habit-starters parity:** `proactive-worker.ts`'s `SEEDING_MESSAGE` continues to offer them; first-run customize path asks if user wants any.
- **Lint false positives:** Wave-1 ships warnings only; Wave-3 promotes to CI-fail once the corpus is calibrated.

**Confidence:** **medium** for content (review-validated); **high** for registration mechanics + lint pass mechanics.

### 3.5 Agent W1-E: ENTITY + RELATIONSHIP knowledge-graph primitive

**Scope:** the entity/relationship split per `GAP_ASSESSMENT.md` §3.4 — replaces `LifeOpsRelationship`, absorbs the identity-graph + contact-resolver pair, and ships the multi-identity-per-entity + first-class-edge data model. Owns the migration from existing `lifeops_relationships` rows into the `(Entity, Relationship)` pair.

**Owned files / dirs (created):**

*Entities:*
- `src/lifeops/entities/`
  - `types.ts` — `Entity`, `EntityIdentity`, `EntityAttribute` types per §3.4. Also `EntityTypeRegistry` (built-in types: `person`, `organization`, `place`, `project`, `concept`; open string with registered metadata).
  - `store.ts` — `EntityStore` implementation: `upsert`, `get`, `list`, `observeIdentity`, `resolve` (returns ranked candidates with confidence + evidence + `safeToSend`), `recordInteraction`, `merge`.
  - `merge.ts` — identity-merge engine called by `observeIdentity` and explicit `merge`; preserves full provenance (every collapsed identity keeps its evidence trail).
  - `resolver-shim.ts` — backward-compat `ContactResolver` shim for legacy callers; deleted by Wave-2 W2-D.
  - `index.ts`.

*Relationships:*
- `src/lifeops/relationships/`
  - `types.ts` — `Relationship`, `RelationshipState` per §3.4. `RelationshipTypeRegistry` (built-in types: `follows`, `colleague_of`, `partner_of`, `manages`, `managed_by`, `lives_at`, `works_at`, `knows`, `owns`; open string).
  - `store.ts` — `RelationshipStore`: `upsert`, `get`, `list` (with edge-direction + type + metadata filters), `observe` (extraction-time evidence-strengthening), `retire`.
  - `extraction.ts` — extraction helpers callable from the planner (and from chat ingest) to turn an observation into entity + edge writes (e.g. "Pat is my manager at Acme" → 2 entities, 3 edges).
  - `index.ts`.

*Migration + REST:*
- `src/lifeops/graph-migration/migration.ts` — one-shot migrator: `lifeops_relationships` row → paired `(Entity, Relationship)`. Promotes `primaryChannel + primaryHandle` to `Entity.identities[0]`; copies `relationshipType` (mapped via `relationship-type-mapping.json`) into `Relationship.type`; copies `notes` into `Relationship.metadata`; copies `lastContactedAt` into `Relationship.state.lastInteractionAt`. The existing `lifeops_relationship_interactions` rows have their FK column updated from "relationshipId pointing at the legacy record" to "relationshipId pointing at the new edge"; the prior column becomes `legacyEntityId` for one release.
- `src/routes/entities.ts` — REST: `GET / POST / PATCH /api/lifeops/entities`, `POST /api/lifeops/entities/:id/identities`, `POST /api/lifeops/entities/merge`, `GET /api/lifeops/entities/resolve?q=`.
- `src/routes/relationships.ts` — REST: `GET / POST / PATCH /api/lifeops/relationships`, `GET /api/lifeops/relationships?from=&to=&type=`, `POST /api/lifeops/relationships/observe`, `POST /api/lifeops/relationships/:id/retire`.
- `src/lifeops/identity-observations/observer.ts` — replaces `identity-observations.ts` and `getCanonicalIdentityGraph`; routes platform observations through `EntityStore.observeIdentity`. Edge-strengthening observations also call `RelationshipStore.observe`.
- DB migrations: `entities` + `entity_identities` + `entity_attributes` tables; `relationships` table with `(from_entity_id, to_entity_id, type)` index. `lifeops_relationships` retained read-only until Wave-2 W2-D removes the legacy reader.

**Owned files / dirs (deleted in Wave 2 — flagged here, not removed in W1-E):**
- `src/lifeops/identity-observations.ts` — replaced by W1-E observer; deletion deferred to W2-D.
- `getCanonicalIdentityGraph` — replaced; deletion in W2-D.
- `src/lifeops/entities/resolver-shim.ts` — temporary; deleted by W2-D once callers move to `EntityStore.resolve`.

**Owned files / dirs (modified):**
- `packages/shared/src/contracts/lifeops.ts` — adds `Entity`, `Relationship` types; `LifeOpsRelationship` retained as a deprecated alias whose shape is a narrowed view derived from `(Entity, Relationship)` so existing code compiles. Wave 2's W2-A removes the alias.
- `src/lifeops/repository.ts` — adds `EntityStore` + `RelationshipStore` queries; the existing `upsertRelationship` / `listRelationships` delegate to the new stores.
- `src/lifeops/service-mixin-relationships.ts` — methods delegate to `EntityStore` + `RelationshipStore`. Wave 2's W2-A deletes the file (the existing entry points become legacy; new code calls the stores directly via `service.ts`).

**Deliverables:**
- `EntityStore` + `RelationshipStore` shipped end-to-end (types, stores, merger, resolver, extraction helpers, REST, migration).
- Existing `LifeOpsRelationship`-shaped data accessible through the new stores (zero data loss; FK rewrites preserve interaction history).
- Identity-observation pipeline routes through `EntityStore.observeIdentity` and (for edge-strengthening) `RelationshipStore.observe`.
- An entity can have multiple identities per platform (J10 cross-channel reply scenario works).
- An entity-pair can have multiple typed relationships (Pat is `colleague_of` AND `friend_of`, with separate cadences).
- Migrator runs dry-run by default; `--apply` actually writes; produces a manual-review JSON of every entity created, every relationship inferred, every type-mapping decision, and every merge proposal.

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete (`lifeops-extensions.ts` collapse means W1-E starts from a single contracts file).

**Verification:**
- `bun run verify` clean.
- New `entities.test.ts` + `relationships.test.ts` cover: multi-identity upsert, `observeIdentity` merge with provenance, `resolve` with multiple candidates, `recordInteraction`, multi-type edges between same pair, `RelationshipStore.observe` strengthening, retire-with-audit, `extraction.ts` "Pat is my manager at Acme" producing 2 entities + 3 edges.
- Migration test: synthetic `lifeops_relationships` table with 50 rows → migrator dry-run produces a sane (entity-count, relationship-count, type-mapping) diff; `--apply` produces equivalent paired records and rewrites interaction FKs.
- Backward-compat: existing `service-mixin-relationships.ts` consumers continue to work.
- Existing `test/relationships.e2e.test.ts` (Priya Rao merge) passes through `EntityStore.observeIdentity`.

**Risk-and-tradeoff:**
- **Two stores, one mental model:** new contributors might write entity-only or edge-only code when they need both. Mitigation: `extraction.ts` is the canonical entry point for "ingest this observation into the graph"; tests verify it produces both nodes and edges; AGENTS.md update in Wave 3 documents the rule.
- **Schema migration:** the migrator is the highest-risk piece. Mitigation: dry-run by default, manual-review JSON, rollback script that restores `lifeops_relationships` from a snapshot taken at migration time, type-mapping table that's a one-file edit if a mapping is wrong.
- **`relationshipType` string drift:** users authored relationships with arbitrary strings (`"good friend"`, `"work husband"`). Mitigation: the mapping table normalizes known synonyms; unknown strings pass through verbatim; W3-A reviews the long tail and decides which to canonicalize.
- **Backward-compat alias:** `LifeOpsRelationship` retained one release; deleted by W2-A.
- **Resolver false-merges:** merging entities on wrong evidence is destructive. Mitigation: `verified` flag, provenance trail, `--apply` requires manual review, `merge` is reversible via the audit log for one release.

**Confidence:** **high** for the model and store shapes (the schema is the standard knowledge-graph shape); **medium** for the migrator's edge cases (interaction-FK rewrite, type-mapping coverage, multi-identity disambiguation when name collisions exist).

### 3.6 Agent W1-F: Connector + channel + transport contract draft

**Scope:** define the contracts so W1-B (`plugin-health`), Wave 2 connector migration, and the runner build to a stable surface. Includes the `ConnectorTransportContract` (§3.17) so dispatch failures are typed.

**Owned files / dirs (created):**
- `src/lifeops/connectors/`
  - `contract.ts` — `ConnectorContribution` interface, `ConnectorMode`, `ConnectorStatus`, capability namespacing rules, `ConnectorRegistry`. `send` returns `DispatchResult` per §3.17 (`{ ok: true, messageId? } | { ok: false, reason, retryAfterMinutes?, userActionable }`).
  - `dispatch-policy.ts` — runner-side fallback policy (advance escalation / retry-with-backoff / fail-loud / queue-for-recovery) per §3.17.
  - `default-pack.ts` — empty in Wave 1 (Wave 2 migrates the existing 12 connectors); entry point exists for Wave 2.
- `src/lifeops/channels/`
  - `contract.ts` — `ChannelContribution`, `ChannelRegistry`. Same shape: contract only in Wave 1.
  - `priority-posture.ts` — `PriorityToPostureMap` per `GAP_ASSESSMENT.md` §8.7 (low → in_app, medium → in_app + push, high → escalation ladder mandatory).
- `src/lifeops/send-policy/`
  - `contract.ts` — `SendPolicyContribution`. Same.

**Owned files / dirs (modified):**
- `src/plugin.ts` — registers the registries (empty in Wave 1, populated by W1-B and by Wave 2).

**Deliverables:**
- Three contract files plus their registries.
- `wave1-interfaces.md` published the first day of the wave; lists exact signatures W1-B / W1-A / W1-C / W1-D / W1-E build against.
- Validation tests for the registries (register / get / list).
- `DispatchResult` type frozen; Wave-2 connectors implement against it.

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete.
- W1-F is a hard dependency for W1-B (and a soft dependency for everyone else). Mitigation: W1-F's contracts are the **first thing produced in Wave 1** (one-pass deliverable on day 1); other agents read it.

**Verification:**
- Contracts typecheck.
- Registry tests pass.
- W1-B's `plugin-health` connector contributions conform (validated at integration gate).

**Risk-and-tradeoff:**
- **Contract drift mid-wave:** W1-F freezes the contract within day 1; subsequent changes only via the integration gate.

**Confidence:** **high.**

### 3.7 Agent W1-G: Repo hygiene + non-action helper relocation

**Scope:** the file moves and stale-TODO resolution; the housekeeping that doesn't fit the pre-wave because it touches more than string literals.

**Owned files / dirs (modified / moved):** 9 non-action files out of `src/actions/`:
- `extractor-pipeline.ts` → `src/lifeops/llm/extractor-pipeline.ts`.
- `gmail.ts` (extractor helper) → `src/lifeops/llm/extract-gmail-plan.ts`.
- `lifeops-extraction-config.ts` → fold into `src/lifeops/defaults.ts`.
- `lifeops-google-helpers.ts` → split into `src/lifeops/access.ts` and `src/lifeops/google/format-helpers.ts`.
- `lifeops-grounded-reply.ts` → `src/lifeops/voice/grounded-reply.ts`.
- `non-actionable-request.ts` → `src/lifeops/validate/coding-task-request.ts`.
- `scheduled-trigger-task.ts` → `src/lifeops/triggers/schedule-once.ts`.
- `timezone-normalization.ts` → `src/lifeops/time/timezone.ts`.
- `CHECKIN_MIGRATION.TODO.md` — delete (superseded by the spine).

**Deliverables:**
- All moves landed with imports updated.
- `src/actions/` contains only `Action` exports (modulo CHECKIN, which Wave-2 W2-A removes).

**Dependencies (Wave 0 only):**
- Pre-wave hygiene complete.

**Verification:**
- `bun run verify` clean.
- `bun run test` clean.

**Risk-and-tradeoff:** Pure import churn; mitigation is typecheck after each batch.

**Confidence:** **high.**

---

## §4 Wave 1 integration gate

Before any Wave-2 work begins, the wave coordinator verifies:

1. `bun run verify` clean across the eliza tree.
2. `bun run test` green (full suite).
3. `bun run test:e2e` green for first-run defaults / customize / replay / abandon-resume.
4. **PII grep** clean: zero hits in `src/`.
5. **Import-boundary grep:** no file in `app-lifeops/src/` imports moved sleep / health / screen-time paths (CI grep rule).
6. **Smoke: `ScheduledTask` end-to-end** — every trigger kind, multi-gate composition, terminal-state taxonomy, snooze-resets-ladder, `reopen` after expired, idempotency dedupe, `respectsGlobalPause`.
7. **Smoke: `plugin-health`** — sleep event published; bus carries it; `wake.observed` AND `wake.confirmed` resolve.
8. **Smoke: ENTITY + RELATIONSHIP graph** — multi-identity entity upsert; `observeIdentity` merge with provenance; `EntityStore.resolve` with multiple candidates; multi-typed-edge between same entity pair (Pat is `colleague_of` AND `friend_of`); `RelationshipStore.observe` strengthens existing edge instead of creating duplicate; `extraction.ts` "Pat is my manager at Acme" produces 2 entities + 3 edges; migrator dry-run produces sane (entity-count, relationship-count, type-mapping) diff with interaction FKs rewritten correctly.
9. **Smoke: pending-prompts correlation** — fire check-in, send inbound, assert routing to `complete`.
10. **Smoke: GlobalPauseStore** — pause respected by `respectsGlobalPause: true` tasks; emergencies fire anyway.
11. **First-run paths:** all four e2e tests pass.
12. **Default packs registered:** all packs listed in `GET /api/lifeops/dev/registries`.
13. **Lint pass:** zero warnings on shipped default packs.
14. **Contract docs shipped:** `wave1-interfaces.md` exists and matches the code.

Failure on any check → corresponding agent re-spins on their owned surface; Wave 2 does not begin.

---

## §5 Wave 2 — Migration onto foundations (7 parallel agents)

### 5.1 Agent W2-A: Scenario-named action migration onto `ScheduledTask`; `RELATIONSHIP` → `ENTITY` rename

**Scope:** every scenario-named action becomes a `ScheduledTask` (or pipeline). `RELATIONSHIP` umbrella renames to `ENTITY` (covering entity CRUD + relationship-edge CRUD; the data layer is the two stores W1-E shipped). Confirmed against `HARDCODING_AUDIT.md` §7 — none of the items below are on the §7 "stays compound" list.

**Migrations:**
- **`CHECKIN` action** (`src/actions/checkin.ts`, 148 lines) — replaced by a `ScheduledTask` with daily cron trigger whose prompt invokes the existing CHECKIN service's assembly logic. Action deleted; service kept.
- **Brush-teeth / shower / shave / invisalign / vitamins / stretch / water / workout seeded routines** — already covered by W1-D's habit-starter pack; W2-A only deletes legacy `seed-routines.ts` and `applySeedRoutines` API.
- **Stretch carve-out** (`service-mixin-reminders.ts:567-606` `isStretchDefinition` / `evaluateStretchReminderGate`; `stretch-decider.ts`) — replaced by the multi-gate composition on the stretch starter task. Files deleted.
- **`STRETCH_ROUTINE_TITLE`** export — deleted.
- **Standalone follow-up trio** (`LIST_OVERDUE_FOLLOWUPS`, `MARK_FOLLOWUP_DONE`, `SET_FOLLOWUP_THRESHOLD`) — collapsed into `SCHEDULED_TASK` queries (`list({ kind: "followup", subject: { kind: "relationship", id } })` — cadence lives on the edge per §3.4). Standalone actions become similes of the umbrella for one release.
- **`RELATIONSHIP.list_overdue_followups` / `mark_followup_done` / `set_followup_threshold` subactions** — collapsed onto `SCHEDULED_TASK` queries.
- **`RELATIONSHIP` umbrella renamed to `ENTITY`** (per the user's revision — supersedes both the original `CONTACTS` rename in `HARDCODING_AUDIT.md` §6 #6 and the prior PEOPLE-consolidation revision). The new umbrella exposes entity CRUD AND relationship-edge CRUD (the data layer is two stores; the user-visible verb is one umbrella). `RELATIONSHIP` kept as a simile of `ENTITY` for one release; the prompt-benchmark suite asserts no planner regression on "follow up with David" / "add Pat to my contacts" / "Pat is my manager" routing. Subactions narrowed to `ENTITY.{add, list, set_identity, set_relationship, log_interaction, merge}`; follow-up subactions removed (collapsed onto `SCHEDULED_TASK` queries).
- **`PROFILE.save` ≡ `set` aliases** — collapse.
- **`set_reminder_preference` / `configure_escalation`** — moved off PROFILE into `LIFE.policy.*` (or onto `ScheduledTask` policy verbs once OwnerFactStore is in place via W2-E).
- **Compound briefings** (morning brief, night brief, dossier, daily-left-today) — already represented by W1-D pack records; W2-A deletes the bespoke action paths.

**Owned files (deleted / modified):**
- `src/actions/checkin.ts` — deleted.
- `src/lifeops/seed-routines.ts` — deleted.
- `src/lifeops/stretch-decider.ts` — deleted.
- `src/lifeops/service-mixin-reminders.ts:567-606` — stretch carve-out removed.
- `src/lifeops/service-mixin-definitions.ts:75,247-348` — `checkAndOfferSeeding` / `applySeedRoutines` removed (already in first-run via W1-C).
- `src/actions/relationship.ts` — renamed to `entity.ts`; follow-up subactions removed; new subactions wire to `EntityStore` + `RelationshipStore` (`set_identity` → `EntityStore.observeIdentity` with `verified: true`; `set_relationship` → `RelationshipStore.upsert`).
- `src/lifeops/service-mixin-relationships.ts` — deleted (callers move to `EntityStore` / `RelationshipStore` via `service.ts`).
- `packages/shared/src/contracts/lifeops.ts` — `LifeOpsRelationship` deprecated alias removed (W1-E flagged this).
- `src/followup/actions/*` — collapsed onto `SCHEDULED_TASK` similes.
- `src/actions/profile.ts:90-91` — alias collapse.

**One-shot migrator deliverable:** legacy `LifeOpsDefinition` rows whose `key` matches the legacy seed keys map to the new `default-packs/habit-starters.ts` `ScheduledTask` entries. Dry-run by default; produces a manual-review JSON; `--apply` to write.

**Deliverables:**
- All scenario-named code is gone.
- `ENTITY` umbrella subsumes the prior `RELATIONSHIP` surface (CRUD + relationship-edge CRUD); CONTACTS / PEOPLE do not appear anywhere as separate concepts.
- `SCHEDULED_TASK` umbrella subsumes follow-up CRUD verbs (`subject.kind = "relationship"` for cadence-bearing tasks).
- Tests updated.

**Dependencies (Wave 1 only):**
- W1-A (`ScheduledTask` spine).
- W1-D (default packs already cover legacy seed routines).
- W1-E (`EntityStore` + `RelationshipStore` shipped; this agent only renames the action surface and deletes legacy delegation).

**Verification:**
- `bun run verify` clean.
- Reminder + follow-up + check-in tests pass against the new spine.
- Parity replay test: 30 days of synthetic stretch occurrences against the registered gates produce identical decisions to the legacy `stretch-decider`.
- Planner regression check: prompt-benchmark suite asserts `RELATIONSHIP` → `ENTITY` rename doesn't regress "follow up with David" / "add Pat to my contacts" / "Pat is my manager" routing.
- Migrator dry-run on staging data produces a sane diff.

**Risk-and-tradeoff:**
- **`ENTITY` planner regression:** mitigation = `RELATIONSHIP` simile for one release; prompt-benchmark gates.
- **Stretch parity:** parity replay test catches drift.
- **Default-pack swap-over:** users with existing seeded routines must keep them; one-shot migrator handles this with dry-run.

**Confidence:** **high.**

### 5.2 Agent W2-B: Connector + channel migration

**Scope:** every existing connector + channel into the contracts drafted in W1-F. Implements the `DispatchResult`-typed `send` per §3.17.

**Owned files (created / modified):**
- `src/lifeops/connectors/<provider>.ts` — one file per connector: `google.ts`, `x.ts`, `telegram.ts`, `discord.ts`, `signal.ts`, `whatsapp.ts`, `imessage.ts`, `twilio.ts`, `calendly.ts`, `duffel.ts`. Each wraps the existing `service-mixin-{provider}.ts` into a `ConnectorContribution`; each `send` returns `DispatchResult`.
- `src/lifeops/channels/default-pack.ts` — registers the union of `LIFEOPS_REMINDER_CHANNELS ∪ LIFEOPS_CHANNEL_TYPES ∪ LIFEOPS_MESSAGE_CHANNELS` with explicit capability descriptors.
- `src/actions/connector.ts:18-36, 105-114, 1294-1304` — `VALID_CONNECTORS` and `CONNECTOR_DISPATCHERS` removed; action iterates the registry.
- `src/lifeops/messaging/owner-send-policy.ts:3-4` — `OWNER_APPROVAL_REQUIRED = new Set(["gmail"])` removed; Gmail's connector contribution declares `requiresApproval: true`.
- Contracts: `LIFEOPS_CONNECTOR_PROVIDERS`, `LIFEOPS_REMINDER_CHANNELS`, `LIFEOPS_CHANNEL_TYPES`, `LIFEOPS_MESSAGE_CHANNELS` collapsed; literal-only types kept for autocomplete.

**Deliverables:**
- All 12 connectors registered through `ConnectorRegistry` with typed `DispatchResult`.
- All channels registered through `ChannelRegistry`.
- `CONNECTOR_DISPATCHERS` map deleted.
- `OWNER_APPROVAL_REQUIRED` set deleted.
- Three channel enums collapsed.
- Connector-degradation provider (existing `LifeOpsConnectorDegradation`) consumes `ConnectorRegistry.status` so it surfaces `auth_expired` / `disconnected` in the morning brief.

**Dependencies (Wave 1 only):**
- W1-F (contracts).
- W1-B (`plugin-health` already registers its own connectors; W2-B does not touch health).

**Verification:**
- Each connector's existing test passes against the registry-loaded version.
- Connector certification matrix runs through the registry.
- Channel coverage invariant: `ChannelRegistry.list({ supports: { send: true } }).length >= ConnectorRegistry.list({ capability: "send" }).length`.
- DispatchResult shape: a forced-failure test for each connector confirms typed failure (auth_expired returns `userActionable: true`).
- Gmail send still requires approval (integration test).

**Risk-and-tradeoff:**
- **Connector registration order:** synchronous default-pack registration at plugin init.
- **Send-policy correctness:** Gmail send must still require approval — integration-test guarded.

**Confidence:** **high.**

### 5.3 Agent W2-C: CALENDAR / compound-action decomposition

**Scope:** decompose the CALENDAR umbrella per `HARDCODING_AUDIT.md` §6 medium-confidence #13. Confirmed against §7: only `bulk_reschedule` and `negotiate_*` lifecycle stay compound; the rest narrow.

**Migrations:**
- Move `calendly_*` subactions into a Calendly contribution registered via `ConnectorRegistry` (built by W2-B).
- Move `negotiate_*` subactions into a workflow-lifecycle action `src/actions/scheduling-negotiation.ts` (one action, all 7 verbs, per §7).
- CALENDAR umbrella narrows from 24 subactions to ~12 irreducible calendar-provider verbs.

**Owned files:**
- `src/actions/calendar.ts` — narrowed.
- `src/actions/scheduling-negotiation.ts` — new.
- `src/lifeops/connectors/calendly.ts` — new (also touched by W2-B; ownership split: W2-B owns the connector wrapper, W2-C owns the subaction extraction; these are different files — `connectors/calendly.ts` vs `actions/calendar.ts`).

**Deliverables:**
- CALENDAR narrows to ~12 subactions.
- Calendly + negotiation extracted.
- Multilingual subaction matrix tests still pass.

**Dependencies:**
- W2-B (Calendly connector contribution).

**Verification:**
- `test/multilingual-action-routing.integration.test.ts` — 7×4 matrix still classifies correctly.
- Negotiation lifecycle integration test covers the 7-verb flow.

**Risk-and-tradeoff:**
- **CALENDAR planner ambiguity:** mitigation per `GAP_ASSESSMENT.md` §8.3: keep CALENDAR as the user-visible verb; Calendly is a provider it dispatches to.

**Confidence:** **medium** (planner-sensitive); covered by prompt-benchmark.

### 5.4 Agent W2-D: Signal-bus + anchors + identity-observation cleanup

**Scope:** lift the closed telemetry-family union into the bus contribution surface; register sleep-and-calendar-driven anchors; delete the legacy identity-observations layer that the W1-E knowledge graph replaced; remove the W1-E backward-compat resolver shim. Narrowed from the prior plan (graph moved to W1-E).

**Migrations:**
- Migrate the closed `LIFEOPS_TELEMETRY_FAMILIES` union into namespaced family strings + a per-family schema in a `FamilyRegistry`. Bus contribution surface is the destination for `plugin-health`'s health families.
- Register anchors: `wake.observed`, `wake.confirmed`, `bedtime.target` (already from `plugin-health`), plus `meeting.ended`, `lunch.start`, `morning.start`, `night.start` from calendar / time-window contributions.
- Delete `src/lifeops/identity-observations.ts` and `getCanonicalIdentityGraph` (W1-E shipped the replacement; observations now route through `EntityStore.observeIdentity` and `RelationshipStore.observe`).
- Delete `src/lifeops/entities/resolver-shim.ts` (the temporary `ContactResolver` shim from W1-E); migrate any remaining callers to `EntityStore.resolve`.

**Owned files:**
- `src/lifeops/signals/bus.ts` — new (lifts the union).
- `src/lifeops/registries/anchor-registry.ts` — new.
- `src/lifeops/registries/event-kind-registry.ts` — new.
- `src/lifeops/registries/family-registry.ts` — new.
- `src/lifeops/identity-observations.ts` — deleted.
- `src/lifeops/entities/resolver-shim.ts` — deleted.
- `packages/shared/src/contracts/lifeops.ts` — telemetry-families closed union widened.

**Dependencies:**
- W1-A (anchors feed `ScheduledTask` triggers).
- W1-B (sleep events / anchors registered by `plugin-health` through the contracts).
- W1-E (`EntityStore` + `RelationshipStore` shipped; identity-observations + resolver-shim safe to delete).

**Verification:**
- `test/relationships.e2e.test.ts` — Priya Rao merge passes through `EntityStore.observeIdentity` (no shim involved).
- `test/lifeops-activity-signals.remote.live.e2e.test.ts` — signal bus accepts known + new families.
- Workflow event-trigger tests — sleep / calendar / new anchors fire.
- Grep clean: no remaining imports of `getCanonicalIdentityGraph` or the resolver-shim.

**Confidence:** **high** (the riskiest piece — the graph itself — landed in W1-E; W2-D is bus + cleanup).

### 5.5 Agent W2-E: Multilingual + OwnerFactStore generalization

**Scope:** `MultilingualPromptRegistry` lands; the real `OwnerFactStore` lands and absorbs the existing `LifeOpsOwnerProfile` and the W1-C interim wrapper.

**Migrations:**
- New `src/lifeops/i18n/prompt-registry.ts`. Default pack registers existing `ActionExample` translations; the inline Spanish brush-teeth example moves to the table; action examples reference the registry by `exampleKey`.
- New `src/lifeops/owner/fact-store.ts`. Generalizes `LifeOpsOwnerProfile`; `PROFILE.save` persists through it; `travelBookingPreferences`, `quietHours`, `morningWindow`, `eveningWindow`, `preferredNotificationChannel`, `locale` are typed entries with provenance.
- The W1-C interim wrapper deletes; first-run service swaps to the real store.

**Dependencies:**
- W1-C (interim wrapper exists; this agent swaps it).

**Verification:**
- `test/multilingual-action-routing.integration.test.ts` — 7×4 matrix still classifies.
- `test/lifeops-memory.live.e2e.test.ts` — owner profile extraction passes against fact-store.
- First-run customize re-runs with the real store; no regression on Wave-1 e2e suite.

**Confidence:** **high.**

### 5.6 Agent W2-F: BlockerRegistry + autofill cleanup

**Scope:** `BlockerRegistry` lands; the website / app blocker collisions resolve; autofill whitelist becomes a default-pack contribution.

**Migrations:**
- New `src/lifeops/registries/blocker-registry.ts`. Migrate website-blocker (hosts file) and app-blocker (iOS Family Controls / Android Usage Access) into registered enforcers. **Resolve collision** (`HARDCODING_AUDIT.md` §6 high-confidence #6): keep `WEBSITE_BLOCK` umbrella; delete the standalone `RELEASE_BLOCK` and `LIST_ACTIVE_BLOCKS` actions.
- Move `DEFAULT_AUTOFILL_WHITELIST` (49 brand domains) from `src/lifeops/autofill-whitelist.ts:7-55` into a default-pack contribution.

**Dependencies:**
- W1-A (relock callbacks become `ScheduledTask` `after_task` triggers).

**Verification:**
- `test/selfcontrol-chat.live.e2e.test.ts` — block/unblock through registry passes.

**Confidence:** **high.**

### 5.7 Agent W2-G: Test infrastructure + contract relaxation + handoff

**Scope:** the contract test relaxes; e2e tests for spine + first-run + plugin-health-bridge; **plus** the HandoffStore + `MESSAGE.handoff` verb (closes J13).

**Migrations:**
- `test/prd-coverage.contract.test.ts` — final relaxation per `GAP_ASSESSMENT.md` §8.5 (set-equality + spine-coverage).
- `coverage-matrix.md` — domain-anchored, not scenario-anchored.
- E2E test: `ScheduledTask` end-to-end (create from chat → fire → verb → pipeline → completion → reopen).
- E2E test: spine + first-run integration.
- E2E test: `plugin-health` consumed through the bus + a `relative_to_anchor` `ScheduledTask` triggered by a sleep event.
- E2E test: handoff verb + resume condition.
- New `src/lifeops/handoff/store.ts` per `GAP_ASSESSMENT.md` §3.14.
- New `src/actions/message-handoff.ts` — `MESSAGE.handoff` verb and resume actions.
- New `src/providers/room-policy.ts` — gates agent contributions when `HandoffStore.status(roomId).active`.

**Owned files:**
- `test/prd-coverage.contract.test.ts` — relaxed.
- `test/scheduled-task-end-to-end.e2e.test.ts` — new.
- `test/spine-and-first-run.integration.test.ts` — new.
- `test/plugin-health-anchor.integration.test.ts` — new.
- `test/handoff.e2e.test.ts` — new.
- `coverage-matrix.md` — updated.
- `src/lifeops/handoff/`, `src/actions/message-handoff.ts`, `src/providers/room-policy.ts` — new.

**Dependencies:**
- W1-A, W1-B, W1-C, W1-D, W1-E, W2-A (spine in production-ish state).

**Verification:**
- Test suite green.
- Coverage matrix domain-set matches `UX_JOURNEYS.md` chapter set.
- Handoff e2e: agent enters handoff in 3-way thread → stops contributing → resumes on `@mention` per the test's `ResumeCondition`.

**Confidence:** **high** for tests; **medium** for handoff (J13 is the journey with zero existing architecture, so this is greenfield).

---

## §6 Wave 2 integration gate

Final gate before Wave 3:

1. `bun run verify` clean.
2. `bun run test` clean.
3. `bun run test:e2e` clean.
4. `bun run db:check` clean.
5. PII grep still clean.
6. No legacy seed-routines / stretch-decider / closed channel-enum imports remain (CI grep rules).
7. All capabilities in `GAP_ASSESSMENT.md` §3 are implemented (capability-coverage assertion in test suite enumerating expected registries).
8. Manual smoke of 5 of the 28 journey domains (onboarding, habits, calendar, follow-up, travel) — confirms no journey requires source-code edits to add a new variant.
9. First-run replay path runs idempotently.
10. Default-pack content review: all packs from W1-D are still present and still register cleanly.
11. ENTITY + RELATIONSHIP migration: production migrator dry-run produces zero unresolvable cases (every legacy `lifeops_relationships` row maps to a paired `(Entity, Relationship)`; every `lifeops_relationship_interactions` row's FK is rewritten cleanly; every relationship-type string maps to either a known type or passes through verbatim with a note).
12. Handoff: `RoomPolicyProvider` gates contributions; planner regression suite passes.

---

## §7 Wave 3 — Review + integration + finish (sequential)

This wave is **sequential, not parallel.** Each agent runs under coordinator supervision; the next does not start until the prior is signed off. Wave 3 exists because Waves 1 and 2 produce a lot of independent changes and the system needs a coherent end-to-end pass before declaring the work done.

### 7.1 Agent W3-A: Default-pack curation review

**Scope:** the default packs from W1-D are reviewed against the real journey set in `UX_JOURNEYS.md` and the game-through findings in `JOURNEY_GAME_THROUGH.md`. This is the curation work that judgment-tests the pack content, not just the pack mechanics.

**Activities:**
- Run a fresh-user simulated 7-day session against the default packs; record every fire, snooze, escalation, completion, skip.
- Review qualitatively: is the agent feeling alive? annoying? silent? Are any default packs producing redundant fires post-consolidation?
- Tune prompt content where the lint pass surfaced warnings.
- Re-validate the morning-brief assembler against the existing CHECKIN service's fixture set.
- Tune the quiet-user-watcher's threshold ("you've been quiet for N days" — what's N? default 3).
- Tune the followup-watcher cadence default (default 14 days, configurable per-edge via `Relationship.metadata.cadenceDays` — different cadences for the same person across different edges, e.g. `colleague_of` vs `friend_of`).

**Deliverables:**
- Updated default-pack records (content tuning only — no schema changes).
- Curation rationale doc: per pack, what was kept / changed / removed and why.
- 7-day simulation log.

**Verification:**
- W1-D's smoke test still passes (fresh user → ≤ 6 nudges in 24h).
- Coordinator review of the curation rationale doc.

### 7.2 Agent W3-B: Prompt-content lint pass promotion

**Scope:** the lint pass from W1-D was warnings-only in Wave 1. In Wave 3, after the corpus has been calibrated by W3-A's curation review, promote it to CI-fail.

**Activities:**
- Calibrate false-positive rate against the curated default packs.
- Add the lint corpus expansion: any patterns observed in the wild that should be flagged.
- Promote `bun run verify` to fail on lint warnings (not just emit them).
- Document the lint corpus in `docs/audit/prompt-content-lint.md`.

**Deliverables:**
- Lint pass fails CI on findings.
- Corpus documented; contributor guide updated.

**Verification:**
- A synthetic prompt with PII / absolute path / hardcoded ISO time / embedded conditional fails CI.
- All shipped default packs pass.

### 7.3 Agent W3-C: Full e2e replay across 28 journey domains

**Scope:** end-to-end replay of the 18 journeys traced in `JOURNEY_GAME_THROUGH.md` plus the remaining 10 domains in `UX_JOURNEYS.md`'s table of contents that didn't get a journey trace. Each replay confirms no journey requires source-code edits to add a new variant.

**Activities:**
- For each journey domain, run a synthetic chat-session → assert the planner picks the right action → assert the resulting `ScheduledTask` records have the right shape → assert the runner fires correctly → assert pipelines compose → assert terminal state is correct.
- For the 10 game-through findings explicitly resolved in Wave 1/2 (inbound correlation, multi-gate, terminal-state, …), assert each fix lands in a runnable test.
- Identify any remaining ambiguity that wasn't pinned in `GAP_ASSESSMENT.md`; surface to coordinator as a P1 finding.

**Deliverables:**
- A new `test/journey-domain-coverage.e2e.test.ts` covering all 28 domains.
- A "post-Wave-2 ambiguity register" doc listing anything the replay surfaced that the spec missed.
- Updated coverage matrix reflecting the final shape.

**Verification:**
- All 28 journey-domain tests pass.
- Coordinator triages the ambiguity register: each entry is either fixed in W3-C or explicitly punted with a written justification.

### 7.4 Agent W3-D: Documentation + AGENTS.md + README updates

**Scope:** the architectural changes need to be reflected in the user-facing and contributor-facing docs.

**Activities:**
- Update `docs/launchdocs/14-lifeops-qa.md` to reflect the new architecture (spine + supporting capabilities + plugin-health + ENTITY/RELATIONSHIP graph).
- Update `docs/user/lifeops-setup.mdx` with the first-run flow (defaults / customize / replay / pause / wipe).
- Update `docs/rest/lifeops.md` with the new endpoints (`/api/lifeops/scheduled-tasks/*`, `/api/lifeops/entities/*`, `/api/lifeops/relationships/*`, etc.).
- Update `coverage-matrix.md` to be domain-anchored.
- Update plugin-level READMEs (`plugins/app-lifeops/README.md`, `plugins/plugin-health/README.md`).
- Update `AGENTS.md` (the CLAUDE.md companion) with notes for future contributors: how the spine works, what NOT to add, how to register a new default pack.
- Audit doc updates land minimally — no doc rewrite, just reflect the new architecture.

**Deliverables:**
- All listed docs updated.
- A short `docs/audit/post-cleanup-architecture.md` summarizing what changed and what to read next.

**Verification:**
- Docs compile (mdx + md).
- A spot-check pass: pick 3 journeys and verify the user-facing doc explains them correctly against the new architecture.

### 7.5 Agent W3-E: Final integration gate

**Scope:** the coordinator-led final gate. Pulls the threads together and ships.

**Activities:**
- Run the full verification suite end to end: `bun run verify && bun run test && bun run test:e2e && bun run db:check`.
- Confirm every Wave-1 and Wave-2 gate criterion is still met (regressions are possible after sequential Wave-3 work).
- Confirm Wave-3 deliverables landed: lint promoted, journey replay green, docs updated, ambiguity register triaged.
- Tag the final commit.

**Deliverables:**
- Full verification clean.
- Tag.

**Verification:**
- Coordinator sign-off.

---

## §8 Cross-wave risks

### 8.1 Coordinator overhead
**Risk:** parallel agents need a shared interface contract within each wave; without it, integration breaks.
**Mitigation:** wave-start interface freeze. W1-F's `wave1-interfaces.md` is produced first; all other Wave-1 agents read it. Equivalent freeze at Wave-2 start (`wave2-interfaces.md` reflecting any post-gate adjustments).

### 8.2 File-conflict resolution
**Risk:** two agents claim the same file (e.g. W2-B and W2-C both touch `connectors/calendly.ts`).
**Mitigation:** owned-surface lists are explicit and reviewed at wave start; if a file is genuinely shared, the wave coordinator splits by section ownership. The `calendly.ts` case is split by file: W2-B owns `connectors/calendly.ts`; W2-C owns `actions/calendar.ts`.

### 8.3 Integration breakage if a wave fails partial-way through
**Risk:** Wave 1 has 7 parallel agents; if one fails the gate, the others have already merged.
**Mitigation:** the gate is hard. If gate fails, the failing surface re-spins; no Wave-2 work begins. The coordinator can merge non-failing branches into the integration branch incrementally and only land the full wave when the gate passes.

### 8.4 Debug strategy if a wave fails
- Bisect by agent: each commit is on its own branch; the integration branch shows which merge broke things.
- Smoke-test invariants (`GET /api/lifeops/dev/registries`, `GET /api/lifeops/scheduled-tasks/:id/history`) help identify which registry isn't populated.
- If the spine (W1-A) breaks, fix-in-place — it's load-bearing.

### 8.5 Rollback posture
- Each agent's deliverable is in its own commit on its own branch; reverting one commit on the integration branch is mechanical.
- The legacy reminder/workflow loop continues alongside the new spine in Wave 1, so a Wave-2 partial revert doesn't take the agent off-air. Only the legacy CHECKIN action delete (W2-A) is destructive; that step is the last to land.

### 8.6 Default-pack staleness across waves
**Risk:** W1-D ships against an early `ScheduledTask` shape; if W1-A's contract drifts, packs break.
**Mitigation:** wave1-interfaces.md is the contract; W1-D builds against it; Wave-1 gate validates pack registration.

### 8.7 LLM round-trip latency creep
**Risk:** the spine umbrella might invite the planner to chain too many calls.
**Mitigation:** `GAP_ASSESSMENT.md` §8.3 governs (one umbrella with subactions). Wave-2 prompt-benchmark suite asserts no per-turn latency regression.

### 8.8 Cloud / local mode skew
**Risk:** features work locally but fail in Cloud (or vice versa).
**Mitigation:** every connector contribution declares `modes: ConnectorMode[]`. Wave-2 gate runs at least one Cloud-mode pass.

### 8.9 ENTITY + RELATIONSHIP migration failure
**Risk:** the migrator silently drops a row, mis-merges two entities, mis-rewrites an interaction FK, or normalizes a relationship-type incorrectly.
**Mitigation:** dry-run by default; manual-review JSON listing every entity created, every relationship inferred, every type-mapping decision, every merge proposal, and every FK rewrite; rollback script that restores `lifeops_relationships` from a snapshot taken at migration time; the type-mapping table (`relationship-type-mapping.json`) is one file edit if a mapping is wrong. Wave-2 gate runs the migrator on staging data before production.

### 8.10 Game-through findings re-emerging
**Risk:** schema fixes pinned in `GAP_ASSESSMENT.md` §2.3 are large; agents may build to an outdated mental model.
**Mitigation:** wave1-interfaces.md restates §2.3 verbatim; W1-A's tests cover every game-through finding explicitly; Wave-3 W3-C replays journeys end-to-end and surfaces any drift.

---

## §9 Open decisions / human-in-the-loop

After integrating the user's ENTITY + RELATIONSHIP knowledge-graph revision and the game-through findings, the following remain open and warrant human input.

### 9.1 First-run customize question set (Wave 1, W1-C / W1-D)
**Question:** is the recommended 5-question set in `GAP_ASSESSMENT.md` §5.3 right? Locked at wave start.
**Recommendation:** lock with a 30-min review by user / product before W1-C starts.

### 9.2 Default-pack content (Wave 1, W1-D)
**Questions:** check-in fire time (9am sharp vs wake+30 min)? morning-brief vs check-in subsume each other? habit-starters offered explicitly during first-run vs surfaced later? followup-starter cadence default?
**Recommendation:** treat curation as W1-D's primary deliverable; final tuning in Wave 3 W3-A.

### 9.3 `screen-context.ts` placement (Wave 1, W1-B)
**Question:** moves to `plugin-health` (screen-time-coupled) or stays in app-lifeops (general)?
**Recommendation:** W1-B reads in full and decides on the spot; documents in wave1-interfaces.md.

### 9.4 Cross-package contract location for health types (Wave 1, W1-B)
**Question:** `plugin-health/src/contracts/health.ts` vs `packages/shared/src/contracts/health.ts`?
**Recommendation:** default `plugin-health/src/contracts/health.ts`; only fall back if cross-plugin import is required.

### 9.5 BOOK_TRAVEL stays compound (Wave 2, confirmation)
**Recommendation:** stays compound per `GAP_ASSESSMENT.md` §7.1 and `HARDCODING_AUDIT.md` §7.

### 9.6 ENTITY identity conflicts (Wave 1, W1-E)
**Question:** when `EntityStore.observeIdentity` sees the same `(platform, handle)` already attached to a different `Entity`, what wins?
**Recommendation:** the highest-`confidence` claim wins; ties go to `verified: true`. If still ambiguous, the merger surfaces the conflict via a `ScheduledTask` (`kind = "approval"`) for the user to resolve. Same rule applies to `RelationshipStore.observe` proposing an edge between two entities that the user explicitly retired previously — the retire takes precedence; the new observation is logged as evidence but does not auto-revive.

### 9.7 Multilingual prompt source-of-truth (Wave 2, W2-E)
**Recommendation:** TypeScript registry for v1; revisit if community translations become important.

### 9.8 State-log retention policy (Wave 1, W1-A — promoted from prior open question)
**Recommendation:** 90-day rolling retention; nightly rollup pass. Pinned, not deferred.

### 9.9 Plugin-health initial connector enablement default (Wave 1, W1-B / W1-D)
**Recommendation:** disabled by default; customize path opts in. Matches "leave it up to the user."

### 9.10 First-run defaults wake-time question (Wave 1, W1-C — promoted from prior open question)
**Recommendation:** ASK ONE QUESTION (wake time) on Path A before scheduling gm. Pinned per `GAP_ASSESSMENT.md` §8.13.

### 9.11 Quiet-user watcher threshold (Wave 1, W1-D / Wave 3, W3-A)
**Question:** "quiet for N days" — what N?
**Recommendation:** start at 3; tune in W3-A based on simulation.

---

## §10 Out of scope

Things this plan explicitly does NOT cover:

- New product features. Onboarding is improved structurally (first-run capability), not redesigned.
- UI redesign. `apps/app-lifeops/` UI may consume new endpoints but visual design is not in scope.
- Eliza Cloud schema changes.
- Memory architecture changes beyond `OwnerFactStore` generalization.
- Browser-bridge plugin internal changes.
- `plugin-computeruse`, `plugin-remote-desktop`, `plugin-voice-affect` internal changes.
- Documentation site rewrite (only minimal updates per W3-D).
- Performance optimization beyond not-regressing.
- Telemetry-retention policy (independent of family-union changes).
- Observability dashboards beyond loopback dev endpoints + the user-visible task history.
- Authentication / multi-user / org features. LifeOps remains single-owner.
- Plugin-health UI surface.
- Migration of historical reminder / workflow data into `ScheduledTask` rows. Wave 2 ships a one-shot migrator only for active legacy seed-routine definitions; historical occurrences stay where they are.
- CONTACTS or PEOPLE as a separate top-level concept. ENTITY + RELATIONSHIP supersedes — no CONTACTS or PEOPLE module is created.

---

## §11 Sequence summary

```
Pre-wave hygiene (1 short pass)
  ↓
Wave 1 — Foundations (7 parallel agents)
  W1-A ScheduledTask spine
  W1-B plugin-health extraction
  W1-C First-run + correlation/aggregation/pause providers
  W1-D Default-pack curation + consolidation + lint
  W1-E ENTITY + RELATIONSHIP knowledge-graph primitive
  W1-F Connector + channel + transport contract draft
  W1-G Repo hygiene + non-action helper relocation
  ↓
Wave 1 integration gate (hard)
  ↓
Wave 2 — Migration onto foundations (7 parallel agents)
  W2-A Scenario-named action migration; RELATIONSHIP → ENTITY umbrella rename
  W2-B Connector + channel migration
  W2-C CALENDAR / compound-action decomposition
  W2-D Signal-bus + anchors + identity-observation cleanup
  W2-E Multilingual + OwnerFactStore generalization
  W2-F BlockerRegistry + autofill cleanup
  W2-G Test infra + contract relaxation + handoff
  ↓
Wave 2 integration gate (hard)
  ↓
Wave 3 — Review + integration + finish (sequential)
  W3-A Default-pack curation review
  W3-B Prompt-content lint pass promotion
  W3-C Full e2e replay across 28 journey domains
  W3-D Documentation + AGENTS.md + README updates
  W3-E Final integration gate
  ↓
Done
```

*End of implementation plan.*
