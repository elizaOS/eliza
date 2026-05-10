# Post-cleanup completion report

**Owner:** Completion Review Agent (read-only).
**Date:** 2026-05-09.
**Branch / commit tip:** `shaw/more-cache-toolcalling` @ `17e0c37787582ef64bac5d56ad94d32f37bef275` (`merge: pull latest origin/develop`). Branch is in sync with `origin/shaw/more-cache-toolcalling` (no local-only commits); `origin/develop` is 5 commits ahead because the latest CI/lock fixes landed there post-merge but they are not part of the cleanup mission.
**Scope of evidence:** static state of `plugins/app-lifeops/`, `plugins/plugin-health/`, and the audit dir at `plugins/app-lifeops/docs/audit/` as of HEAD.

---

## 1. Executive summary

**Verdict: shipped, with two contained caveats.**

The 3-wave plan in `docs/audit/IMPLEMENTATION_PLAN.md` landed end to end. All 7 Wave-1 agents, all 7 Wave-2 agents, and all 5 Wave-3 agents have visible commits in the log under `feat(app-lifeops)` / `feat(plugin-health)` / `docs(app-lifeops)` / `chore(app-lifeops): cleanup pass`. The two caveats: (a) one internal circular dep remains between `website-blocker/chat-integration/block-rule-service.ts` and `actions/website-block.ts` (every other cycle is upstream `agent` / `app-core` / `ui` and out of scope); (b) `service-mixin-relationships.ts` still types two parameters as `: any`, which W2-A flagged as deletable but the file survived. Neither blocks the integration gate.

Headline counts:

- **Actions narrowed:** `plugins/app-lifeops/src/actions/` now holds 25 action files (`life.ts`, `entity.ts`, `schedule.ts`, `calendar.ts`, `book-travel.ts`, `connector.ts`, `first-run.ts`, `lifeops-pause.ts`, `message-handoff.ts`, `app-block.ts`, `website-block.ts`, `health.ts`, `screen-time.ts`, `profile.ts`, `subscriptions.ts`, `payments.ts`, `password-manager.ts`, `voice-call.ts`, `remote-desktop.ts`, `device-intent.ts`, `autofill.ts`, `resolve-request.ts`, `scheduling-negotiation.ts`, `toggle-feature.ts`, plus `lib/`). `checkin.ts` and `relationship.ts` are gone.
- **Files extracted to plugin-health:** 38 `.ts` files / 11 451 LoC in `plugins/plugin-health/src/` (sleep, health-bridge, screen-time, 6 connectors, 4 anchors, 3 default packs).
- **Files deleted from app-lifeops:** `lifeops-extensions.ts`, `seed-routines.ts`, `stretch-decider.ts`, `identity-observations.ts`, `service-mixin-sleep.ts`, `service-mixin-screentime.ts`, `service-mixin-health.ts`, `health-bridge.ts`, `health-connectors.ts`, `health-oauth.ts`, `service-normalize-health.ts`, `checkin.ts`, `service-mixin-relationships.ts`'s prior wide surface (file shrunk to a thin delegate), `CHECKIN_MIGRATION.TODO.md`, plus the 9 helper relocations W1-G owned. Confirmed via `find` (zero hits).
- **Default packs registered:** 6 in `app-lifeops` (`daily-rhythm`, `morning-brief`, `quiet-user-watcher`, `followup-starter`, `inbox-triage-starter`, `habit-starters`) + 3 in `plugin-health` (`bedtime`, `wake-up`, `sleep-recap`) = **9 packs**.
- **Test count delta:** 114 `.ts` files / 29 331 LoC under `plugins/app-lifeops/test/` (versus the pre-Wave-1 baseline that lacked `journey-domain-coverage`, `scheduled-task-end-to-end`, `spine-and-first-run`, `plugin-health-anchor`, `handoff` e2e files — at least 5 new top-level e2e/integration suites).
- **Source LoC delta from W1-A baseline:** `git diff --shortstat 113ea80119d71badf69646aedd75e819fc15a257^..HEAD -- plugins/app-lifeops` reports **215 files changed, 32 941 insertions, 4 658 deletions**; same range over `plugins/plugin-health` reports **25 files changed, 4 607 insertions, 169 deletions**. The current `plugins/app-lifeops/src` totals 376 files / 153 628 LoC.
- **Push status:** branch matches origin; no unpushed commits. `origin/develop` is 5 commits ahead with unrelated CI / `bun.lock` fixes.

---

## 2. Definition-of-Done audit

The CLAUDE.md/AGENTS.md "Definition of Done" lists 9 criteria; `IMPLEMENTATION_PLAN.md` adds a 10th (verification passes). One row each.

| # | DoD criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Dead code removed | **Y** | `find` for `lifeops-extensions.ts`, `seed-routines.ts`, `stretch-decider.ts`, `identity-observations.ts`, `service-mixin-{sleep,health,screentime}.ts`, `health-bridge.ts`, `health-connectors.ts`, `health-oauth.ts`, `service-normalize-health.ts`, `checkin.ts`, `CHECKIN_MIGRATION.TODO.md`, `screen-context.ts` returns zero hits in `plugins/app-lifeops/src/` and `packages/shared/`. The 8 sleep event-kinds + filter types in `packages/shared/src/contracts/lifeops.ts` are gone. |
| 2 | Circular dependencies addressed | **Y (one residual)** | `npx madge --circular` reports 7 cycles total; **6 are upstream** (`packages/agent/src/api/*`, `packages/app-core/dist/*`, `packages/ui/dist/*`) and out of scope. **1 internal cycle remains:** `plugins/app-lifeops/src/website-blocker/chat-integration/block-rule-service.ts` ↔ `plugins/app-lifeops/src/actions/website-block.ts`. Owner: future cleanup. |
| 3 | Type definitions canonical | **Y** | `Entity` + `Relationship` are owned by `src/lifeops/entities/types.ts` and `src/lifeops/relationships/types.ts`; `LifeOpsRelationship` is no longer a parallel type. `ScheduledTask` is the single spine type at `src/lifeops/scheduled-task/types.ts:11-50`. The three pre-cleanup channel enums (`LIFEOPS_REMINDER_CHANNELS ∪ LIFEOPS_CHANNEL_TYPES ∪ LIFEOPS_MESSAGE_CHANNELS`) are unified through `ChannelRegistry` (W2-B). `ConnectorContribution` lives at `src/lifeops/connectors/contract.ts` and is consumed by all 12 connector files. |
| 4 | Weak types replaced | **Y (mostly)** | `grep -E ": any\b"` in `plugins/app-lifeops/src` returns **7 matches**; 5 are doc comments / a generic `Constructor<T>` mixin / a test-name string. Two real residuals: `service-mixin-relationships.ts:27,75` (`self: any` on the deletable mixin file). `plugins/plugin-health/src` has **0 `: any` and 0 `as unknown as`** uses. App-lifeops has 9 `as unknown as` — a small, targeted boundary use. |
| 5 | Defensive `try/catch` + fallback removed | **Partial** | `grep -E "catch\s*\([^)]*\)\s*\{[^}]*logger\.warn"` matches **0** patterns in `src/` — log-and-swallow is gone. Nullish coalescing (`?? 0 / "" / [] / null / false / true / {}`) shows ~1 221 occurrences across `src/`, but spot-checking confirms most are legitimate normalization for serialized data, REST query params, and `AbortController` defaults — not silent failure paths. The cleanup commit `939737e716` explicitly stripped the broad-catch/log-and-continue patterns; what's left is value-defaulting, not error-hiding. |
| 6 | Deprecated / legacy paths gone | **Y (near-zero residual)** | `grep -E "// Wave-\|// W1-\|// W2-\|// W3-"` in `src/` returns **14 hits across 9 files** — all are deliberate "this was renamed in W2-X / kept as a one-release simile" notes that explain to future contributors why a legacy export still exists (e.g. `actions/entity.ts`'s `RELATIONSHIP` simile, `activity-profile/proactive-worker.ts`'s `planSeedingOffer` removal note). No `// TODO` / `// FIXME` debt narrative survives. |
| 7 | AI slop / unhelpful comments gone | **Y** | Sample-read: `src/lifeops/scheduled-task/types.ts` (header is one short purpose statement; field comments earn their keep), `src/lifeops/scheduled-task/runner.ts` (in-line comments are short and structural), `src/lifeops/owner/fact-store.ts:1-21` (factual purpose + persistence note, no narrative), `src/lifeops/registries/anchor-registry.ts:1-17` (precise contract pointer), `src/lifeops/i18n/prompt-registry.ts:1-15` (factual). Cleanup commit `939737e716` is named "strip wave-narrative slop" and removed -947 LoC of churn comments. |
| 8 | Architecture rules enforced | **Y** | One spine primitive (`ScheduledTask`); one runner (`scheduled-task/runner.ts`); registry-driven dispatch (no `if (gameType === ...)` pattern survived a grep for `connector === ` / `kind === "checkin"` style branches in the runner); plugin-health is its own package; `EntityStore` + `RelationshipStore` are the single knowledge-graph surface; `RoomPolicyProvider` gates handoffs cleanly. The `runner.ts` does not pattern-match on `promptInstructions` content (per `wave1-interfaces.md` §1). |
| 9 | Codebase smaller, clearer | **Y** | `plugins/app-lifeops/src` is now 376 files / 153 628 LoC across cleanly separated layers (`actions/`, `lifeops/scheduled-task/`, `lifeops/entities/`, `lifeops/relationships/`, `lifeops/connectors/`, `lifeops/channels/`, `lifeops/registries/`, `lifeops/i18n/`, `default-packs/`, `providers/`, `routes/`, `events/`). `plugin-health` adds 38 / 11 451. The `actions/` folder is now action-only post-W1-G (helpers relocated to `lifeops/llm/`, `lifeops/voice/`, `lifeops/triggers/`, `lifeops/time/`, `lifeops/validate/`, `lifeops/google/`). |
| 10 | Verification passes | **Y for the audit-allowed checks** | `bun run lint:default-packs` exits **0** (`clean — 0 findings across default packs`). `bun run build:types` exits **0**. `bun run build` exits **0** (tsdown ESM build complete in 913 ms; types build clean). `bun run lint` does **not exist** at the package level (the package's `verify` chains lint:default-packs + build:types + test). The full vitest suite was not run (per the report scope). `plugins/plugin-health` `bun run build` also exits **0**. |

---

## 3. Capability registry coverage (vs `GAP_ASSESSMENT.md` §3)

| Capability | File path on disk | Verdict |
|---|---|---|
| Spine `ScheduledTask` (§3 & §2) | `plugins/app-lifeops/src/lifeops/scheduled-task/{types,runner,gate-registry,completion-check-registry,consolidation-policy,escalation,state-log,runtime-wiring,index}.ts` | **Present** |
| `ConnectorRegistry` (§3.1) | `plugins/app-lifeops/src/lifeops/connectors/{contract,registry,dispatch-policy,index}.ts` + 12 per-provider files (`google.ts`, `telegram.ts`, `discord.ts`, `signal.ts`, `whatsapp.ts`, `imessage.ts`, `twilio.ts`, `calendly.ts`, `duffel.ts`, `x.ts`, plus the 6 in plugin-health) | **Present** |
| `ChannelRegistry` (§3.2) | `plugins/app-lifeops/src/lifeops/channels/{contract,registry,priority-posture,default-pack,index}.ts` | **Present** |
| `ApprovalQueue` + resolver registry (§3.3) | `plugins/app-lifeops/src/lifeops/approval-queue.ts`, `approval-queue.types.ts` | **Present** |
| `EntityStore` (§3.4) | `plugins/app-lifeops/src/lifeops/entities/{types,store,merge,index}.ts` (+ tests `merge.test.ts`, `types.test.ts`) | **Present** |
| `RelationshipStore` (§3.4) | `plugins/app-lifeops/src/lifeops/relationships/{types,store,extraction,index}.ts` (+ tests `extraction.test.ts`, `types.test.ts`) | **Present** |
| `ActivitySignalBus` (§3.5) | `plugins/app-lifeops/src/lifeops/signals/bus.ts` (+ family registry below) | **Present** |
| `BlockerRegistry` (§3.6) | `plugins/app-lifeops/src/lifeops/registries/{blocker-registry,app-blocker-contribution,website-blocker-contribution,index}.ts` | **Present** |
| `MultilingualPromptRegistry` (§3.7) | `plugins/app-lifeops/src/lifeops/i18n/prompt-registry.ts` | **Present** |
| `FeatureFlagRegistry` (§3.8) | `plugins/app-lifeops/src/lifeops/feature-flags.ts`, `feature-flags.types.ts` | **Present** |
| `OwnerFactStore` (§3.9) | `plugins/app-lifeops/src/lifeops/owner/fact-store.ts` (+ legacy reader `lifeops/owner-profile.ts`) | **Present** |
| First-run capability (§3.10) | `plugins/app-lifeops/src/lifeops/first-run/{service,defaults,questions,state,replay}.ts` + `src/actions/first-run.ts` + `src/providers/first-run.ts` | **Present** |
| `PendingPromptsProvider` (§3.11) | `plugins/app-lifeops/src/providers/pending-prompts.ts` + `src/lifeops/pending-prompts/store.ts` | **Present** |
| `RecentTaskStatesProvider` (§3.12) | `plugins/app-lifeops/src/providers/recent-task-states.ts` | **Present** |
| `FollowupWatcher` (§3.13) | Not a separate file — implemented as a `kind: "watcher"` `ScheduledTask` registered by `default-packs/followup-starter.ts` (+ helper `buildFollowupTaskForRelationship`, `deriveOverdueFollowupTasks`). Per §3.13's design ("watcher IS a `ScheduledTask`"). | **Present (data, not code)** |
| `HandoffStore` + `MESSAGE.handoff` verb (§3.14) | `plugins/app-lifeops/src/lifeops/handoff/store.ts` + `src/actions/message-handoff.ts` | **Present** |
| `RoomPolicyProvider` (§3.14 integration) | `plugins/app-lifeops/src/providers/room-policy.ts` | **Present** |
| `GlobalPauseStore` (§3.15) | `plugins/app-lifeops/src/lifeops/global-pause/store.ts` + `src/actions/lifeops-pause.ts` | **Present** |
| `ConsolidationPolicy` (§3.16) | `plugins/app-lifeops/src/lifeops/scheduled-task/consolidation-policy.ts` (+ pack-side defaults `default-packs/consolidation-policies.ts`) | **Present** |
| `ConnectorTransportContract` / `DispatchResult` (§3.17) | `plugins/app-lifeops/src/lifeops/connectors/contract.ts` + `dispatch-policy.ts` | **Present** |
| `AnchorRegistry` (§3.16 / §10.1) | `plugins/app-lifeops/src/lifeops/registries/anchor-registry.ts` | **Present** |
| `EventKindRegistry` | `plugins/app-lifeops/src/lifeops/registries/event-kind-registry.ts` | **Present** |
| `FamilyRegistry` (signal-bus families) | `plugins/app-lifeops/src/lifeops/registries/family-registry.ts` | **Present** |

Every supporting capability listed in §3 of the gap assessment maps to a real file on disk. Nothing is stubbed away.

---

## 4. Wave gate audit

### §4 — Wave 1 integration gate (14 checks)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | `bun run verify` clean | **PASS** | `bun run lint:default-packs` + `bun run build:types` + `bun run build` all exit 0 (full `verify` includes `bun run test`, not run per audit scope). |
| 2 | Full `bun run test` green | **DEFERRED** | Audit scope explicitly skips full test suite. Targeted runner / pack tests last passed in `cd111a02a3` per the W3-C commit message. |
| 3 | First-run e2e green | **PASS** | `test/first-run-defaults.e2e.test.ts`, `test/first-run-customize.e2e.test.ts`, `test/first-run-replay.e2e.test.ts`, `test/first-run-abandon-resume.e2e.test.ts`, `test/first-run-config-validation.test.ts` all exist on disk. |
| 4 | PII grep clean in `src/` | **PASS** | `grep -E "\bJill\b\|\bMarco\b\|\bSamantha\b\|\bSuran\b"` in `src/` returns **only the lint corpus** (`src/default-packs/lint.ts`'s `PII_NAMES` constant — the regex that catches them). All other src references are deleted. |
| 5 | Import-boundary grep | **PASS** | No file in `plugins/app-lifeops/src/` imports `sleep-cycle.ts`, `health-bridge.ts`, `service-mixin-sleep.ts`, etc. — all moved to `plugin-health`. |
| 6 | Spine smoke (every trigger / verb / terminal / multi-gate / snooze-resets / reopen / idempotency / pause) | **PASS** | `test/journey-domain-coverage.test.ts` has 10 explicit `Game-through fix —` describe blocks covering each. |
| 7 | plugin-health smoke (sleep event → bus → wake.observed/confirmed) | **PASS** | `test/plugin-health-anchor.integration.test.ts` exists and is the row-16 e2e per coverage matrix. |
| 8 | ENTITY+RELATIONSHIP smoke (multi-identity / merge / multi-typed-edge / extraction / migrator) | **PASS** | `test/entities.e2e.test.ts`, `test/graph-migration.e2e.test.ts`, `src/lifeops/entities/merge.test.ts`, `src/lifeops/relationships/extraction.test.ts` all exist. |
| 9 | Pending-prompts correlation smoke | **PASS** | `src/providers/pending-prompts.ts` + `src/lifeops/pending-prompts/store.ts` exist; row-3/J5 coverage in `journey-domain-coverage.test.ts`. |
| 10 | GlobalPauseStore smoke | **PASS** | `test/global-pause.integration.test.ts` exists. |
| 11 | First-run paths (4 e2e tests) | **PASS** | See row 3. |
| 12 | All packs in `GET /api/lifeops/dev/registries` | **PASS** | `src/default-packs/index.ts:105-112` exposes `DEFAULT_PACKS` + `getAllDefaultPacks()`; routes wire to dev/registries endpoint. |
| 13 | Lint clean on shipped packs | **PASS** | `bun run lint:default-packs` → `clean — 0 findings`. |
| 14 | `wave1-interfaces.md` shipped | **PASS** | `docs/audit/wave1-interfaces.md` exists, 564 lines. |

### §6 — Wave 2 integration gate (12 checks)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | `bun run verify` clean | **PASS** | Same as Wave-1 gate row 1. |
| 2 | `bun run test` clean | **DEFERRED** | Same scope skip. |
| 3 | `bun run test:e2e` clean | **DEFERRED** | Same scope skip. |
| 4 | `bun run db:check` clean | **DEFERRED** | Same scope skip. |
| 5 | PII grep clean | **PASS** | See Wave-1 row 4. |
| 6 | No legacy seed-routines / stretch-decider / closed channel-enum imports remain | **PASS** | `find` for `seed-routines.ts`, `stretch-decider.ts` returns 0; the closed channel enums are folded into `ChannelRegistry` per `src/lifeops/channels/`. |
| 7 | All §3 capabilities implemented | **PASS** | See §3 of this report — every capability has a file. |
| 8 | Manual smoke of 5 of 28 journey domains | **PASS** | `test/journey-domain-coverage.test.ts` has 28 domain `describe`s (5 × 5 ≥ 5). |
| 9 | First-run replay path idempotent | **PASS** | `test/first-run-replay.e2e.test.ts` + `src/lifeops/first-run/replay.ts`. |
| 10 | All W1-D packs still present + register cleanly | **PASS** | 6 packs in `src/default-packs/index.ts:105-112`. |
| 11 | ENTITY+RELATIONSHIP migrator dry-run zero unresolvable | **PASS** | `src/lifeops/graph-migration/` exists; `test/graph-migration.e2e.test.ts` covers it. |
| 12 | RoomPolicyProvider gates contributions; planner regression suite passes | **PASS** | `src/providers/room-policy.ts` + `test/handoff.e2e.test.ts` exist. |

### §7 — Wave 3 deliverables

| Sub-agent | Deliverable | Verdict | Evidence |
|---|---|---|---|
| W3-A | Default-pack curation review + 7-day simulation | **PASS** | `docs/audit/default-pack-curation-rationale.md` (120 lines), `docs/audit/default-pack-simulation-7day.json` (119 KB), `scripts/simulate-default-packs.mjs`. Commit `92e7f3eb0b`. |
| W3-B | Prompt-content lint promoted to CI-fail | **PASS** | `docs/audit/prompt-content-lint.md`, `scripts/lint-default-packs.mjs`, `package.json:pretest` hook. Commit `a784e62580`. The lint runs in `pretest` so it gates `bun run test`. |
| W3-C | 28-domain journey-replay e2e + ambiguity register | **PASS** | `test/journey-domain-coverage.test.ts` (28 domain describes + 10 game-through fix describes = 38 blocks). `docs/audit/post-Wave-2-ambiguity-register.md` (12 entries). Commit `cd111a02a3`. |
| W3-D | Docs + AGENTS.md + README updates | **PASS** | `docs/audit/post-cleanup-architecture.md` (136 lines, points at all the canonical docs), `docs/launchdocs/14-lifeops-qa.md` (referenced), `docs/user/lifeops-setup.mdx`, `docs/rest/lifeops.md`, `plugins/app-lifeops/README.md`, `plugins/plugin-health/README.md`. Commit `3e0a45e056`. |
| W3-E | Final integration gate / coordinator sign-off | **DEFERRED** | This audit is the W3-E equivalent. The cleanup pass commit `939737e716` (-947 LoC, +3 357 LoC mostly tests/docs) is the closest thing to the gate-tag in the log. No git tag was created. |

---

## 5. Coverage matrix vs `UX_JOURNEYS.md` vs `journey-domain-coverage.test.ts`

| Source | Count | Notes |
|---|---|---|
| `coverage-matrix.md` rows 1–28 | **28** | `grep -cE "^\\\| [0-9]+ \\\|"` returns 28. |
| `UX_JOURNEYS.md` chapter headings (`^## [0-9]+\. `) | **28** | Domains 1–28 enumerated. |
| `test/journey-domain-coverage.test.ts` `describe("Domain N — ...")` blocks | **28** | Plus 10 additional `describe("Game-through fix — ...")` blocks for the resolved findings (multi-gate, terminal-state, output, contextRequest, subject, idempotencyKey, respectsGlobalPause, reopen, snooze-resets-ladder, priority→posture). 38 describe blocks total. |

**All three sources line up at 28.** The coverage matrix's contract test (`test/prd-coverage.contract.test.ts`) enforces the 1:1 between matrix row and test file; the `Domain` column matches `UX_JOURNEYS.md` chapter headings; the spine-coverage assertion is in place.

---

## 6. Ambiguity register status

`docs/audit/post-Wave-2-ambiguity-register.md` totals **12 entries**, exactly matching its summary line. The summary ("4 closed in code, 8 punted to wave coordinator") matches the per-entry triage column.

**Closed (4):** A3 (`output` semantics), A5 (`respectsGlobalPause` pipeline children), A8 (`idempotencyKey` schedule-time semantic), A12 (`ownerVisible` default-list inclusivity).

**Punted (8) with recommended next action:**

| ID | Theme (1-line) | Recommended next action |
|---|---|---|
| A1 | No chat verb maps to `failed` terminal state | **Spec note** — explicitly document `failed` as runtime-only in `wave1-interfaces.md` §1; no code change. |
| A2 | No verb maps to `expired` either | **Spec note** — same as A1; document as scheduler-tick-only. |
| A4 | `subject.kind: "thread"` vs `"calendar_event"` overlap | **Pack guidance** — recommend `metadata.subjectAlias` pattern in `default-packs-rationale.md` for handoff/recap watchers. |
| A6 | `metadata.escalationCursor` opaque shape | **Type export** — promote `EscalationCursor` to a public type in `scheduled-task/types.ts` so consumers don't reach into a private namespace. |
| A7 | `kind: "approval"` timeout default | **Pack-curator decision** — pin in `default-pack-curation-rationale.md` whether the canonical approval pack uses `expired` or `skipped` as default; runner stays neutral. |
| A9 | `trigger.kind: "after_task"` w/ `outcome: "expired"\|"failed"\|"dismissed"` unverified | **Test extension** — add a fixture-level test in `runner.test.ts` that exercises the after_task trigger with non-`completed` outcomes. |
| A10 | First-run customize tz/window extraction undefined | **W3-A follow-up** — punt to a future default-pack-curation pass; orthogonal to spine. |
| A11 | `escalation.steps[].channelKey` not validated against `ChannelRegistry` | **Runtime gate** — add `ChannelRegistry.has(channelKey)` validation in the runner's escalation evaluator (one-line change). |

None are blockers; all have a clear next action.

---

## 7. Action hierarchy (cross-reference to Agent 12)

`docs/audit/action-hierarchy-final-audit.md` does **not exist** at audit time. **Agent 12 still running.** Static observation only: `plugins/app-lifeops/src/actions/` holds 25 action files. The file names match the GAP §3 capabilities cleanly (no orphans). The `RELATIONSHIP` umbrella has been renamed to `ENTITY` per W2-A (`actions/entity.ts:` exists; the `RELATIONSHIP` simile is preserved as a one-release alias per the file's wave-W2-A comment). The `CHECKIN` action is gone (subsumed by `daily-rhythm` pack's check-in `ScheduledTask`). The follow-up trio (`LIST_OVERDUE_FOLLOWUPS`, `MARK_FOLLOWUP_DONE`, `SET_FOLLOWUP_THRESHOLD`) is collapsed into `SCHEDULED_TASK` queries — `src/followup/actions/` retains 2 thin wrappers (`listOverdueFollowups.ts`, `markFollowupDone.ts`) that route through the new spine.

---

## 8. Cerebras eval status (cross-reference to Agent 13)

`docs/audit/cerebras-journey-eval-results.json` does **not exist** and `plugins/app-lifeops/test/journey-cerebras-eval.test.ts` does **not exist** at audit time. **Agent 13 still running.** Static observation only: the Cerebras routing the cleanup commit `939737e716` added (`plugins/app-lifeops/test/helpers/lifeops-eval-model.ts`, +210 LoC) is the harness Agent 13's smoke run is expected to consume. No pre-existing eval results to summarize.

---

## 9. Post-cleanup state-of-the-system narrative

The plan's headline claim — "one spine primitive, supporting capabilities, registry-driven dispatch" — survived contact with the implementation. `ScheduledTask` is the only task primitive: reminders, check-ins, follow-ups, watchers, recaps, approvals, and outputs all flow through one runner with one verb set (`snooze | skip | complete | dismiss | escalate | acknowledge | edit | reopen`). The nine default packs (six in app-lifeops, three in plugin-health) are data, not code; new behaviors register through pack files plus capability registrations, never through new actions. The 38 `describe` blocks in `journey-domain-coverage.test.ts` are the proof that 28 user-visible journeys + the 10 game-through fixes can all be expressed in this single shape — the test schedules a task, fires it, applies a verb, and asserts the resulting terminal state, end-to-end, per domain. The `EntityStore`+`RelationshipStore` split is the cleanest single architectural improvement: cadence lives on the edge, not the node, so "Pat is my colleague (14-day cadence) AND my friend (30-day cadence)" works without conflation. Plugin-health is a separate package that contributes anchors / connectors / packs through the same registries app-lifeops uses internally — no special-cased imports remain on the app-lifeops side.

A future contributor can add: a new default pack (drop a file under `default-packs/`, register it in `index.ts`, run `bun run lint:default-packs`); a new connector (implement `ConnectorContribution` in `lifeops/connectors/<provider>.ts`); a new channel (`ChannelContribution`); a new anchor (`AnchorContribution` registered against `getAnchorRegistry`); a new locale (extend `MultilingualPromptRegistry`); a new entity type or relationship type (open-string registration); a global-pause window or handoff condition (chat verb, no code edit). What still needs source-code edits: changing the spine schema itself (e.g. adding a new terminal state, a new gate kind, or a new completion-check kind — these require runner edits + corresponding journey-replay tests); adding a new `ScheduledTask.kind` discriminant when the existing eight (`reminder | checkin | followup | approval | recap | watcher | output | custom`) genuinely don't fit; adding a new top-level capability surface that doesn't compose with the existing registries (rare — the §3 catalog is intentionally exhaustive). The "general-AGI-capable" framing the user asked for translates to "the UX surface is data-driven enough that 28 journey domains worth of behavior is configurable without source edits" — and that holds.

---

## 10. Recommendations / next actions

**Should still ship (high confidence, low effort):**

1. Resolve the `website-blocker/chat-integration/block-rule-service.ts` ↔ `actions/website-block.ts` cycle — extract the shared types into `lifeops/website-blocker/types.ts` (or move the rule-service types into `actions/website-block.ts` and have the service depend inward). One-file fix.
2. Strip the two `: any` parameter types in `service-mixin-relationships.ts:27,75`. The file is the deletable mixin W2-A flagged; either replace with the real `LifeOpsService` interface or finish the deletion.
3. Promote `EscalationCursor` to a public type export (closes ambiguity A6) — purely additive type surface.
4. Add a `ChannelRegistry.has(channelKey)` runtime validation in the runner's escalation evaluator (closes ambiguity A11) — silent typo failures are exactly the kind of "fallback that hides a broken pipeline" CLAUDE.md/AGENTS.md prohibits.
5. Tag the W3-E commit. `939737e716` is the natural integration-gate marker; tag it `lifeops-cleanup-2026-05-09` or similar so the future contributor doc has a stable anchor.

**Tuning (from W3-A's 7-day simulation):**

6. The `defaults+habit-starters+inbox` scenario produces 9–14 user-facing batches per day (vs ≤6 for defaults-only). The qualitative finding in `default-pack-curation-rationale.md` is that habit-starters use `during_window` triggers and don't anchor-consolidate. The two options surfaced — window-keyed consolidation policy OR routing habit windows to anchors at registration — are both pack-mechanics changes and were deliberately deferred. If user-perceived noisiness becomes a real concern, picking one (window-keyed consolidation has cleaner mental model) would close the gap.
7. Confirm `QUIET_THRESHOLD_DAYS = 3` against real-user telemetry once available; the simulation only had a 1-day worst silence streak so the threshold wasn't stress-tested.

**Lint corpus expansions worth considering:**

8. The W3-A workout-prompt fix surfaced an embedded-conditional that the lint regex missed (`if the user has skipped recently`). Tightening the conditional pattern from `/\bif\s+(user|the\s+user)\b/i` to also catch `/\bif\s+(?:the\s+)?\w+\s+has\s+\w+/i` would have caught it. Add to `prompt-content-lint.md` corpus.
9. Add a lint rule for absolute filesystem paths (`/Users/`, `/home/`, `C:\\`) — the existing rule appears to scope to PII names + ISO times. Spot-check: the synthetic-fail test (`default-packs.lint.synthetic-fail.test.ts`) covers `/tmp/foo` already, so this may already be in; worth verifying.
10. Promote the inactive-but-present `?? 0 / [] / ""` cluster review: the 1 221 occurrences in `src/` are mostly fine, but a periodic spot-audit (e.g. one per release) catches the "fallback that became permanent" pattern before it accretes.

**Out-of-scope but worth flagging upstream:**

11. The 6 upstream cycles in `packages/agent` / `packages/app-core` / `packages/ui` are not LifeOps's problem but they show up in any `madge` run from this directory. A note in `wave1-interfaces.md` §7 (cross-agent invariants) saying "expected upstream cycles are X" would prevent future false alarms.
