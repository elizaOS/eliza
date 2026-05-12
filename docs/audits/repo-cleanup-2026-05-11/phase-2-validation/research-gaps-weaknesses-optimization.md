# Phase 2 Validation - Research Gaps, Weaknesses, Optimization

Date: 2026-05-11
Worker: Phase 2 research worker F
Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Output: `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/research-gaps-weaknesses-optimization.md`

## Scope And Constraints

This pass was read-only except for this report. I did not delete, rename,
refactor, stage, commit, or edit source/config/test files. The repository was
already dirty and partially staged when this pass started; those changes are
assumed to belong to other workers and were not modified.

The goal was to identify cleanup-relevant gaps, incomplete work,
overengineering, fallbacks, stubs, legacy/deprecated surfaces, duplicated
abstractions, generated artifacts, and optimization opportunities. Findings are
biased toward actionable owner questions and validation work that should happen
before deleting or simplifying code.

## Executive Summary

The highest-risk cleanup items are not simple dead-code deletions. Several
surfaces have "temporary" stubs or fallback behavior that are still wired into
live paths:

- `ScheduledTask` has canonical fields that are missing from Wave 1 stub copies
  used by first-run, default packs, and plugin-health. The comments still claim
  the copies are byte-identical.
- First-run can silently schedule into a cache-backed fallback runner when the
  production ScheduledTask runner is not registered.
- The ScheduledTask scheduler has an explicit skipped test documenting duplicate
  dispatch under concurrent ticks.
- plugin-health exposes registry contributions that always report disconnected,
  while the real health bridge still lives on a legacy LifeOps path.
- Cloud API route audit docs are stale: the generated router now reports 529
  mounted routes, while the test inventory and coverage docs still report 493.
- Some public or operator cloud routes are mounted as `501` stubs, and the
  streaming session endpoint deducts credits before returning stub RTMP
  credentials.
- Frontend onboarding docs say the old wizard is removed, but the flow helpers,
  callbacks, and tests still encode a real multi-step flow.
- Generated artifacts, benchmark results, native binaries, ignored declaration
  files, and executable font modes need an explicit retention/regeneration
  policy before cleanup.

## Command Log

All commands below were non-destructive. `PASS` means the command completed and
produced evidence. `FAIL` means the command failed before changing anything and
was replaced with a corrected read-only query.

| Command | Status | Notable output |
| --- | --- | --- |
| `pwd` | PASS | Confirmed workspace path. |
| `git status --short` | PASS | Worktree already contained many staged, unstaged, and untracked changes from other workers. |
| `git diff --name-only --cached` | PASS | Confirmed many staged source/docs/artifact changes already existed. |
| `git diff --name-only` | PASS | Confirmed unstaged changes outside this report existed before report creation. |
| `test -f docs/audits/repo-cleanup-2026-05-11/phase-2-validation/research-gaps-weaknesses-optimization.md; printf '%s\n' $?` | PASS | Returned `1`; target report did not exist before this pass. |
| `find docs/audits/repo-cleanup-2026-05-11 -maxdepth 3 -type f \| sort` | PASS | Located existing Phase 1 reports and Phase 2 README. |
| `sed -n '1,220p' docs/audits/repo-cleanup-2026-05-11/README.md` | PASS | Confirmed audit-only/dry-run instructions. |
| `sed -n '1,260p' docs/audits/repo-cleanup-2026-05-11/SUMMARY.md` | PASS | Existing summary already flags LifeOps graph, generated artifacts, route aliases, stubs, and tests as risk areas. |
| `sed -n '1,220p' docs/audits/repo-cleanup-2026-05-11/phase-2-validation/README.md` | PASS | Phase 2 reports must include exact commands, pass/fail, notable output, owner, and next action. |
| `rg -n "wave1-types\|contract-stubs\|ScheduledTaskRef\|executionProfile" plugins/app-lifeops plugins/plugin-health` | PASS | Found canonical/stub `ScheduledTask` copies and stub import sites. |
| `nl -ba plugins/app-lifeops/src/lifeops/scheduled-task/types.ts \| sed -n '40,75p;232,270p'` | PASS | Canonical `TaskExecutionProfile` and optional `ScheduledTask.executionProfile` captured with line numbers. |
| `nl -ba plugins/app-lifeops/src/lifeops/wave1-types.ts \| sed -n '1,20p;70,155p'` | PASS | Stub claims byte-identical but lacks `executionProfile`. |
| `nl -ba plugins/app-lifeops/src/default-packs/contract-stubs.ts \| sed -n '1,24p;128,182p'` | PASS | Default-pack stub includes `ScheduledTaskSeed` in `ScheduledTaskRef` and lacks `executionProfile`. |
| `nl -ba plugins/plugin-health/src/default-packs/contract-stubs.ts \| sed -n '1,20p;86,160p'` | PASS | Health stub claims byte-identical and lacks `executionProfile`. |
| `nl -ba plugins/app-lifeops/src/lifeops/first-run/service.ts \| sed -n '1,40p;52,124p;150,230p'` | PASS | Captured production-capable fallback runner and cache key. |
| `nl -ba plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts \| sed -n '196,258p'` | PASS | Captured skipped duplicate-fire concurrency test. |
| `nl -ba plugins/plugin-health/src/connectors/index.ts \| sed -n '118,190p'` | PASS | Captured Wave 1 placeholder dispatcher returning disconnected/transport_error/null. |
| `nl -ba plugins/plugin-health/src/actions/index.ts \| sed -n '1,70p'` | PASS | Captured health action migration deferred to Wave 2 due `LifeOpsService` coupling. |
| `rg -n "LifeOpsContextGraph\|class LifeOpsContextGraph\|createLifeOpsContextGraph" plugins/app-lifeops/src docs/audits/repo-cleanup-2026-05-11` | PASS | `LifeOpsContextGraph` appears self-contained and not live-imported outside audit references in this pass. |
| `find cloud/apps/api -path '*/route.ts' -o -path '*/route.tsx' \| wc -l` | PASS | Returned `529`. |
| `nl -ba cloud/apps/api/src/_router.generated.ts \| sed -n '1,10p'` | PASS | Generated router reports `529 routes mounted, 0 skipped`. |
| `nl -ba cloud/apps/api/test/INVENTORY.md \| sed -n '1,28p'` | PASS | Inventory doc still reports `493`. |
| `nl -ba cloud/apps/api/test/COVERAGE.md \| sed -n '1,45p'` | PASS | Coverage doc still reports `493` mounted routes. |
| `rg -n "not_yet_migrated\|mintStubSession\|stub relay\|501\|TODO\\(node-only\\)" cloud/apps/api cloud/services/rtmp-relay` | PASS | Found mounted stubs and RTMP relay placeholder surfaces. |
| `nl -ba cloud/apps/api/v1/apis/streaming/sessions/route.ts \| sed -n '1,220p'` | PASS | Captured credit deduction before `mintStubSession()`. |
| `nl -ba cloud/services/rtmp-relay/src/index.ts \| sed -n '1,180p'` | PASS | Captured stub credential mint and no-op close. |
| `nl -ba cloud/apps/api/v1/admin/docker-containers/audit/route.ts \| sed -n '1,120p'` | PASS | Captured Node-only route returning `501 not_yet_migrated`. |
| `nl -ba cloud/apps/api/test/e2e/group-k-affiliate.test.ts \| sed -n '1,120p'` | PASS | Captured skipped affiliate tests blocked on `501` Worker stub. |
| `nl -ba packages/ui/src/onboarding/README.md \| sed -n '1,80p'` | PASS | README says full wizard removed and helpers are effectively no-ops. |
| `nl -ba packages/ui/src/onboarding/flow.ts \| sed -n '1,220p'` | PASS | Flow code still documents and implements `deployment -> providers -> features`. |
| `nl -ba packages/ui/src/state/useOnboardingCallbacks.ts \| sed -n '1,180p'` | PASS | Runtime callbacks still import and use flow helpers. |
| `nl -ba packages/ui/src/navigation/main-tab.ts \| sed -n '1,90p'` | PASS | Main-tab fallback remains hardcoded to `chat`. |
| `rg -n "console\\.(log\|warn\|error\|debug)\|\\[shell\\]\|keychain" packages/ui/src/state/useNavigationState.ts packages/ui/src/state/startup-phase-restore.ts` | PASS | Found production-visible console logs in shell/startup state. |
| `rg -n "it\\.skip\|test\\.skip\|describe\\.skip" packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx plugins/plugin-sql/src/__tests__/integration/agent.real.test.ts cloud/apps/api/test/e2e/group-k-affiliate.test.ts plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts` | PASS | Found skipped tests documenting known product gaps. |
| `nl -ba plugins/plugin-sql/src/__tests__/integration/agent.real.test.ts \| sed -n '1034,1065p'` | PASS | Captured placeholder `cleanupAgents` test with no assertions. |
| `rg -n "vi\\.mock\\s*\\(\|vi\\.fn\\s*\\(\|vi\\.spyOn\\s*\\(\|vi\\.mocked\\s*\\(\|mock\\.module\\s*\\(\|jest\\.mock\\s*\\(\|jest\\.fn\\s*\\(\|jest\\.spyOn\\s*\\(\|as Mock\\b\|as MockedFunction\\b" packages plugins cloud -g "*.test.ts" -g "*.test.tsx" -g "*.spec.ts" -g "*.spec.tsx" \| wc -l` | PASS | Returned `2138` matching lines under the current globs. |
| `nl -ba scripts/lint-no-vi-mocks.mjs \| sed -n '1,90p'` | PASS | Script says it intentionally fails entire repo today. |
| `find packages/agent/src -name '*.d.ts' \| wc -l` | PASS | Returned `298` local declaration files under ignored source paths. |
| `find packages/agent/src -name '*.d.ts.map' \| wc -l` | PASS | Returned `296` local declaration map files under ignored source paths. |
| `git check-ignore -v packages/agent/src/api/accounts-routes.d.ts` | PASS | `.gitignore` ignores `packages/agent/src/**/*.d.ts`. |
| `git ls-files 'packages/agent/src/**/*.d.ts' \| wc -l` | PASS | Returned `1`; only one tracked declaration file in that tree. |
| `git ls-files -s cloud/apps/frontend/public/fonts/sf-pro/*.otf` | PASS | Font files are tracked with executable mode `100755`. |
| `git ls-files -s packages/inference/verify/cpu_bench packages/inference/verify/dispatch_smoke packages/inference/verify/vulkan_bench` | PASS | Native verification binaries are tracked. |
| `file packages/inference/verify/cpu_bench packages/inference/verify/dispatch_smoke packages/inference/verify/vulkan_bench` | PASS | Binaries are Mach-O arm64 executables. |
| `du -sh packages/benchmarks/benchmark_results/latest packages/inference/verify docs/audits/lifeops-2026-05-11/prompts reports/porting` | PASS | Large generated/artifact trees: 648K, 8.8M, 4.1M, 9.0M. |
| `nl -ba package.json \| sed -n '20,80p'` | PASS | Root `postinstall` and `clean` scripts mutate dependencies/workspace. |
| `nl -ba cloud/package.json \| sed -n '15,60p'` | PASS | Cloud `postinstall` deletes node_modules files; `db:local:reset` deletes `.eliza/.pgdata`. |
| `rg -n '@ts-ignore\|@ts-expect-error\|TODO\\(|TODO:|FIXME|HACK|stub|placeholder|legacy|deprecated|not_yet_migrated|no-op|noop|temporary|fallback' ...` | FAIL | Initial shell command had an unmatched quote; no changes made. Replaced by targeted searches above. |
| `sed -n '1,220p' cloud/apps/api/v1/apis/streaming/sessions/[id]/route.ts` | FAIL | zsh reported no match for bracket path; no changes made. Evidence for streaming stubs came from existing route/service files instead. |

## Findings

### F-01 - `ScheduledTask` contract stubs are stale copies

Area: LifeOps/health contracts

Evidence:

- Canonical `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts:47`
  defines `TaskExecutionProfile`, and `ScheduledTask.executionProfile?` is part
  of the canonical interface at `types.ts:240`.
- `plugins/app-lifeops/src/lifeops/wave1-types.ts:1` says the shapes are
  byte-identical, but its `ScheduledTask` body at `wave1-types.ts:78` ends at
  `metadata?` and has no `executionProfile`.
- `plugins/app-lifeops/src/default-packs/contract-stubs.ts:17` says this file
  should flip to owner-module re-exports once owners land. It still carries a
  copied `ScheduledTask` at `contract-stubs.ts:133`, also without
  `executionProfile`.
- `plugins/plugin-health/src/default-packs/contract-stubs.ts:1` also claims
  byte-identical Wave 1 copies, but its `ScheduledTask` at
  `contract-stubs.ts:92` lacks `executionProfile`.
- The default-pack stub also defines `ScheduledTaskRef = string |
  ScheduledTask | ScheduledTaskSeed` at
  `plugins/app-lifeops/src/default-packs/contract-stubs.ts:131`, while the
  canonical `ScheduledTaskRef` is `string | ScheduledTask` at
  `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts:258`.

Why it matters:

Default packs, first-run, and plugin-health can compile against stale contract
copies and silently miss scheduling fields needed by mobile/background
execution. The comments now give maintainers false confidence that these files
are synchronized.

Risk:

High for cross-plugin behavior, because this is the repository's central
LifeOps primitive and affects first-run/default-pack authoring.

Validation needed:

- Replace type copies with re-exports from the canonical module, or add a
  type-level assignability check that fails when the copies drift.
- Run `bun run lint:default-packs` and targeted app-lifeops/plugin-health
  typecheck after the import swap.
- Add a pack fixture using `executionProfile` so future drift is observable.

Owner questions:

- Can the Wave 1 stub files be deleted or converted to pure re-export barrels
  now that `src/lifeops/scheduled-task/types.ts` exists?
- Should `ScheduledTaskSeed` be accepted in pipeline refs by the canonical
  runner, or is that an accidental default-pack-only widening?

### F-02 - First-run can schedule into an in-memory fallback in live code

Area: LifeOps first-run/backend

Evidence:

- `plugins/app-lifeops/src/lifeops/first-run/service.ts:11` says the service
  falls back to an in-memory recorder when the production runner is unset.
- `FallbackInMemoryRunner` starts at `service.ts:83`; it writes scheduled tasks
  under cache key `eliza:lifeops:first-run:fallback-tasks:v1` at `service.ts:81`
  and generates IDs with `Date.now()` plus `Math.random()` at `service.ts:87`.
- The type import at `service.ts:18` comes from `../wave1-types.js`, not the
  canonical scheduled-task module.

Why it matters:

If production runner registration fails outside tests, first-run will return
apparently scheduled tasks, but reminders/check-ins live only in cache and are
not guaranteed to be processed by the canonical runner.

Risk:

High user-facing risk: first-run can appear successful while follow-up tasks do
not actually fire.

Validation needed:

- Require a registered runner outside explicit test fixtures or add a loud
  environment-gated fallback.
- Add an integration test that first-run emits rows into the durable
  `life_scheduled_tasks` path rather than the fallback cache.
- Migrate first-run types to the canonical ScheduledTask module as part of F-01.

Owner questions:

- Is fallback scheduling allowed in production-like local runtimes, or should it
  be test-only?
- Which initialization path is responsible for guaranteeing
  `setScheduledTaskRunner()` before first-run actions are reachable?

### F-03 - ScheduledTask dispatch has a documented duplicate-fire race

Area: LifeOps runner/backend tests

Evidence:

- `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts:205`
  documents the race: two concurrent ticks can both read a ready task as
  scheduled before either writes `fired`.
- The invariant test is skipped at `scheduler.test.ts:211`.
- The expected invariant, `expect(allFires).toHaveLength(1)`, is captured at
  `scheduler.test.ts:248`.

Why it matters:

The AGENTS charter says reminders, check-ins, watchers, recaps, approvals, and
outputs all route through one `ScheduledTask` runner. Duplicate dispatch here
can send duplicate notifications, create duplicate downstream tasks, or double
charge/actions depending on the output pipeline.

Risk:

High for any multi-tick or multi-process deployment.

Validation needed:

- Implement an atomic claim/lock transition in the repository/SQL layer.
- Unskip the concurrency test and run it against the real repository backend.
- Add idempotency verification for pipeline-created tasks.

Owner questions:

- Is Wave 2C still the owner for row-level locking, and is the chosen primitive
  advisory locks, `UPDATE ... WHERE state`, or a task-claim table?
- Should duplicate output dispatch be guarded independently at channel/connector
  level?

### F-04 - plugin-health registry connectors are placeholders while legacy bridge remains real

Area: LifeOps/health plugin boundary

Evidence:

- `plugins/plugin-health/src/connectors/index.ts:120` documents a Wave 1
  placeholder dispatcher.
- `status()` always returns `disconnected` at `connectors/index.ts:135`.
- `send()` returns `ok: false` with `transport_error` at
  `connectors/index.ts:141`.
- `verify()` returns `false` and `read()` returns `null` at
  `connectors/index.ts:182`.
- `plugins/plugin-health/src/actions/index.ts:4` says health actions are still
  owned by app-lifeops because they instantiate `LifeOpsService`; the deferred
  marker is `HEALTH_ACTIONS_DEFERRED_TO_WAVE_2` at `actions/index.ts:20`.

Why it matters:

The architecture intends health to contribute through registries without
LifeOps importing internals. Today the new registry path intentionally reports
unavailable while the legacy bridge path can still own real behavior. Cleanup
could easily delete the wrong side or leave a registry that makes real health
connectors look disconnected to ScheduledTask logic.

Risk:

Medium to high for health-domain scheduled tasks, especially completion checks
and connector status gating.

Validation needed:

- Add an integration test from a health default pack through a ScheduledTask
  completion check such as `health_signal_observed`.
- Decide whether connector registry contributions should be quarantined until
  runtime context exists, or wired to the existing health bridge.
- Remove direct LifeOps service construction from health actions before moving
  actions into plugin-health.

Owner questions:

- Who owns the W1-F runtime context shape needed by plugin-health connector
  dispatch?
- Should consumers prefer registry contributions or legacy health bridge during
  the transition?

### F-05 - `LifeOpsContextGraph` looks like a second graph surface unless explicitly classified

Area: LifeOps architecture/cleanup

Evidence:

- `plugins/app-lifeops/src/lifeops/context-graph.ts:1140` defines
  `LifeOpsContextGraph` with in-memory `nodes` and `edges` maps at
  `context-graph.ts:1141` and `context-graph.ts:1144`.
- `createLifeOpsContextGraph()` is exported at `context-graph.ts:1933`.
- In this pass, `rg` found the symbol only in this file and audit docs, not in
  live app-lifeops code.
- Canonical stores already exist in
  `plugins/app-lifeops/src/lifeops/entities/store.ts` and
  `plugins/app-lifeops/src/lifeops/relationships/store.ts`.

Why it matters:

The contributor charter explicitly forbids a second knowledge-graph store and
says cadence belongs on relationship edges. This file may be a safe planner
slice/cache, but its naming and APIs look like a separate graph store.

Risk:

Medium now if unused; high if future code imports it as a parallel store.

Validation needed:

- Classify it as delete, quarantine, or context-assembly cache.
- If kept, add comments/import guards that it is not a durable store and must be
  backed by `EntityStore`/`RelationshipStore`.
- Run `git grep LifeOpsContextGraph` after the current multi-worker branch
  settles.

Owner questions:

- Is this file planned for deletion, or is it the future planner slice API?
- If it is a cache, which repository owns hydration from canonical stores?

### F-06 - Cloud route audit docs are stale against the generated router

Area: Cloud API/docs/generated validation

Evidence:

- `cloud/apps/api/src/_router.generated.ts:5` reports `529 routes mounted, 0
  skipped`.
- `find cloud/apps/api -path '*/route.ts' -o -path '*/route.tsx' | wc -l`
  returned `529`.
- `cloud/apps/api/test/INVENTORY.md:5` still reports `493` route files and
  `INVENTORY.md:6` reports `493` generated mounted routes.
- `cloud/apps/api/test/COVERAGE.md:5` still reports `493` mounted routes.

Why it matters:

Deletion and parity decisions based on the stale docs will miss 36 routes. The
coverage doc also notes that covered paths are found in legacy Next-targeted
e2e tests, not necessarily Worker-targeted Hono tests.

Risk:

Medium for cleanup accuracy and migration confidence.

Validation needed:

- Rerun `node apps/api/test/_inventory.mjs`,
  `node apps/api/test/_audit-coverage.mjs`, and the frontend gap generator from
  the cloud workspace after route additions settle.
- Add a CI check that generated inventory counts match
  `_router.generated.ts`.

Owner questions:

- Which worker owns refreshing generated cloud audit docs?
- Should stale generated docs be treated as cleanup blockers before route
  deletion decisions?

### F-07 - Mounted cloud stubs need owner decisions before deletion or product exposure

Area: Cloud backend/operator APIs

Evidence:

- `cloud/apps/api/v1/admin/docker-containers/audit/route.ts:4` says the route
  is blocked in Workers due to Node-only `ssh2`; the mounted route returns
  `501 not_yet_migrated` at `route.ts:14`.
- `cloud/apps/api/test/e2e/group-k-affiliate.test.ts:27` documents
  `/api/affiliate/create-character` as an intentional `501` Worker stub; the
  auth and happy-path tests are skipped at lines `41`, `52`, and `65`.
- Existing generated audit docs also classify Hono stubs, but those docs are
  stale per F-06.

Why it matters:

Some stubs represent real Node-sidecar requirements, while others are unfinished
product migrations. Cleanup should not delete tests as dead code without first
deciding whether the product surface is being removed, moved to sidecar, or
finished.

Risk:

Medium for admin/operator tooling; high for public affiliate routes if clients
depend on them.

Validation needed:

- Rebuild a current list of mounted `501 not_yet_migrated` routes from the 529
  route tree.
- For each route, tag owner decision: sidecar-owned, finish Worker migration,
  keep explicit stub, or remove public route.
- Convert skipped tests into either active tests or tracked backlog references.

Owner questions:

- Which `501` routes are intended public API contracts versus temporary
  migration placeholders?
- Should Node-only admin operations live in a separate sidecar router rather
  than mounted Worker route stubs?

### F-08 - Streaming sessions bill before returning stub RTMP credentials

Area: Cloud backend/billing/streaming

Evidence:

- `cloud/apps/api/v1/apis/streaming/sessions/route.ts:36` obtains the
  streaming method cost and `route.ts:37` deducts credits.
- The route then constructs `RtmpRelayService` at `route.ts:55` and calls
  `relay.mintStubSession()` at `route.ts:61`.
- The log message at `route.ts:63` says `created stub relay session`.
- `cloud/services/rtmp-relay/src/index.ts:1` says the Cloud API currently mints
  stub ingest credentials.
- `mintStubSession()` starts at `index.ts:28`, defaults to
  `rtmp://127.0.0.1:1935/live` at `index.ts:30`, and `closeSession()` is a
  no-op at `index.ts:38`.

Why it matters:

This is a paid API path returning a placeholder. If exposed, users can be
charged for non-functional or local-only relay credentials.

Risk:

High for billing correctness and user trust.

Validation needed:

- Decide whether stub mode is dev-only, free, or explicitly productized with
  clear response metadata.
- Add a test that credits are not deducted when real relay provisioning is
  unavailable, unless the product owner confirms stub billing is intentional.
- Wire session close/lifecycle before advertising streaming as complete.

Owner questions:

- Is `STREAMING_RELAY_INGEST_BASE` enough to make this production-real, or is an
  SRS control-plane API still required?
- Who owns refund/credit behavior for stub session creation failures?

### F-09 - Container rollout code is partial and staged elsewhere

Area: Cloud containers/control plane

Evidence:

- `git diff --name-only --cached` showed staged container rollout work owned by
  another worker, including
  `cloud/packages/lib/services/containers/image-rollout-status.ts`,
  `cloud/packages/lib/services/containers/image-rollout-status.test.ts`,
  `cloud/packages/lib/services/agent-warm-pool.ts`, and
  `cloud/services/container-control-plane/src/index.ts`.
- Read-only inspection showed `image-rollout-status.ts` includes unsupported
  canary/rollback action statuses with TODO-style reasons.
- `container-control-plane/src/index.ts` includes admin rollout/status endpoints
  around pool image rollout.

Why it matters:

Cleanup and validation reports may treat the rollout surface as complete because
endpoints exist, while operator-critical canary/rollback actions are still
unsupported.

Risk:

Medium to high if exposed to operators before behavior is fully specified.

Validation needed:

- Keep status-only rollout APIs clearly labeled, or implement canary/rollback
  before surfacing them as controls.
- Add operator documentation and failure-mode tests for partially unsupported
  actions.
- Re-review after the staged changes are committed or reset by their owner.

Owner questions:

- Are canary and rollback intentionally out of scope for this cleanup phase?
- Should unsupported rollout actions be hidden from UI/API clients rather than
  returned as available-but-disabled statuses?

### F-10 - Onboarding wizard removal is incomplete or the README is stale

Area: Frontend/runtime gate

Evidence:

- `packages/ui/src/onboarding/README.md:3` says the full three-step wizard was
  removed in favor of `RuntimeGate`; `README.md:12` says `flow.ts` helpers are
  effectively no-ops and scheduled for removal.
- `packages/ui/src/onboarding/flow.ts:1` still documents an onboarding wizard
  and `flow.ts:11` describes `deployment -> providers -> features`.
- The flow still implements navigation and skip helpers, including
  `resolveOnboardingNextStep()` at `flow.ts:40`,
  `shouldSkipFeaturesStep()` at `flow.ts:102`, and
  `shouldUseCloudOnboardingFastTrack()` at `flow.ts:109`.
- `packages/ui/src/state/useOnboardingCallbacks.ts:55` imports those helpers
  and therefore still participates in runtime behavior.

Why it matters:

Cleanup could delete live onboarding logic based on the README, or leave legacy
wizard complexity indefinitely because callbacks still depend on it. The docs
and code disagree on whether the flow is dead.

Risk:

Medium for onboarding regressions across desktop, mobile, local, remote, and
cloud-managed modes.

Validation needed:

- Run a runtime-gate/onboarding import graph and browser flow test before any
  deletion.
- Decide whether to update README to match live behavior or remove the callback
  dependencies in a dedicated UI change.
- Verify mobile local/remote/cloud flows separately.

Owner questions:

- Is `useOnboardingCallbacks.ts` still an intended runtime surface or legacy
  compatibility only?
- Who owns migration of external callers away from `flow.ts`?

### F-11 - Main-tab extraction still falls back to hardcoded chat

Area: Frontend shell/app extraction

Evidence:

- `packages/ui/src/navigation/main-tab.ts:27` documents the fallback tab when
  no installed app declares `elizaos.app.mainTab=true`.
- `MAIN_TAB_FALLBACK = "chat"` remains at `main-tab.ts:35`.
- The comment at `main-tab.ts:29` says Phase 5 should drop the hardcoded chat
  case once `app-chat` claims the seam.

Why it matters:

This is an intentional extraction seam, not necessarily dead code. Cleanup
should not remove chat fallback until the owning app metadata and shell render
case are complete.

Risk:

Low to medium. The risk is mostly confusing future extraction work or shipping a
blank landing tab if the fallback changes too early.

Validation needed:

- Confirm the app that owns the default main tab and its package metadata.
- Add a regression test for no-main-tab declarer and multiple declarers.
- Track the Phase 5 removal as a separate UI-shell issue.

Owner questions:

- Is `@elizaos/app-chat` expected to own `mainTab` now, or is the extraction
  still pending?
- Should the fallback be `home` only after a HomePlaceholderView is guaranteed?

### F-12 - Frontend state contains production-visible debug logging

Area: Frontend observability/privacy

Evidence:

- `packages/ui/src/state/useNavigationState.ts:120` logs shell view switches
  with current and previous navigation state.
- `packages/ui/src/state/startup-phase-restore.ts:394` logs keychain scan
  provider counts and provider IDs.
- `startup-phase-restore.ts:401` warns on keychain credential scan failures.

Why it matters:

Some logging is useful, but direct `console.log` in state restoration and shell
navigation can create noisy production logs. Provider IDs from keychain scans
may also be sensitive enough to gate behind debug logging.

Risk:

Low to medium depending on production logging collection.

Validation needed:

- Decide which logs should use the project logger, debug mode, or be removed.
- Add a frontend lint rule or convention for `console.log` in production source.

Owner questions:

- Are provider IDs acceptable in renderer console logs?
- Is there a standard frontend logger/debug flag for shell state traces?

### F-13 - `test:lint:no-vi-mocks` is intentionally failing and not yet a cleanup gate

Area: Test infrastructure

Evidence:

- `scripts/lint-no-vi-mocks.mjs:20` states the lint intentionally fails the
  entire repo today with thousands of matches.
- The root script chain includes `test:lint:no-vi-mocks` under `test:lint` in
  `package.json` during earlier read-only script inspection.
- A current `rg` count for the forbidden patterns under packages/plugins/cloud
  test globs returned `2138` matching lines.

Why it matters:

An intentionally failing whole-repo gate cannot distinguish cleanup regressions
from known baseline debt. Phase 2 validation should avoid treating `test:lint`
as a green/usable gate until this is baselined or split.

Risk:

Medium for validation noise and blocked cleanup PRs.

Validation needed:

- Add a baseline allowlist or a new-code-only mode.
- Separate "report debt" from "fail PR" behavior.
- Re-run the script directly after any baseline work to confirm exact count.

Owner questions:

- Is Phase 4 still responsible for making this gate enforceable?
- Should Phase 2 reports use a narrower validation command set until then?

### F-14 - Skipped and placeholder tests encode real product gaps

Area: Tests across LifeOps, cloud, frontend, SQL

Evidence:

- LifeOps duplicate-fire concurrency test is skipped at
  `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.test.ts:211`.
- Affiliate Worker route tests are skipped at
  `cloud/apps/api/test/e2e/group-k-affiliate.test.ts:41`, `:52`, and `:65`.
- RuntimeGate cloud/mobile provisioning tests are skipped at
  `packages/ui/src/components/shell/RuntimeGate.cloud-provisioning.test.tsx:393`,
  `:451`, and `:596`.
- `plugins/plugin-sql/src/__tests__/integration/agent.real.test.ts:1039`
  says to add cleanupAgents tests if the method is implemented, and the test at
  `:1041` calls `adapter.cleanupAgents()` but has no assertion after `:1056`.

Why it matters:

Skipped tests here are not random noise; they identify unfinished product or
infrastructure behavior. Cleanup should avoid deleting them as dead tests unless
owners explicitly remove the corresponding feature expectations.

Risk:

Medium to high depending on feature surface.

Validation needed:

- Convert each skip to either an active test, a tracked backlog item with owner,
  or a deleted feature contract.
- For placeholder tests, add assertions or remove the test with an owner note.

Owner questions:

- Which skipped tests are blockers for Phase 2 cleanup acceptance?
- Is `cleanupAgents()` a real adapter API contract or a historical placeholder?

### F-15 - Ignored declaration artifacts under `packages/agent/src` pollute source searches

Area: Generated artifacts/tooling

Evidence:

- `find packages/agent/src -name '*.d.ts' | wc -l` returned `298`.
- `find packages/agent/src -name '*.d.ts.map' | wc -l` returned `296`.
- `git check-ignore -v packages/agent/src/api/accounts-routes.d.ts` shows
  `.gitignore` ignores `packages/agent/src/**/*.d.ts`.
- `git ls-files 'packages/agent/src/**/*.d.ts' | wc -l` returned `1`, so most
  declaration files in that tree are local ignored artifacts rather than source.

Why it matters:

Read-only audits and `rg` searches can accidentally include generated ignored
artifacts under source paths, creating false positives for dead code,
deprecated symbols, or duplicate declarations.

Risk:

Low to medium. It mainly affects audit accuracy and developer ergonomics.

Validation needed:

- Decide whether build output should be redirected outside `src`.
- If local cleanup is allowed later, delete ignored generated files only with a
  safe command that excludes the one tracked declaration file.
- Add audit docs warning researchers to use `git ls-files` or ignore generated
  declarations when counting source.

Owner questions:

- Which build step emits declarations into `packages/agent/src`?
- Can that step write to `dist` or a dedicated generated directory instead?

### F-16 - Generated/benchmark/native artifacts need a retention policy before cleanup

Area: Generated artifacts/docs/native binaries

Evidence:

- `git status --short` and targeted artifact checks showed modified benchmark
  result JSON under `packages/benchmarks/benchmark_results/latest`.
- Generated files such as `packages/core/src/generated/action-docs.ts` and
  `packages/prompts/specs/actions/plugins.generated.json` are modified in the
  shared worktree.
- `git ls-files -s` shows tracked native binaries under
  `packages/inference/verify/cpu_bench`,
  `packages/inference/verify/dispatch_smoke`, and
  `packages/inference/verify/vulkan_bench`.
- `file` reports those binaries are Mach-O 64-bit arm64 executables.
- `du -sh` reported notable local artifact sizes: `packages/inference/verify`
  at 8.8M, `reports/porting` at 9.0M, and
  `docs/audits/lifeops-2026-05-11/prompts` at 4.1M.
- `git ls-files -s cloud/apps/frontend/public/fonts/sf-pro/*.otf` shows SF Pro
  font files tracked with executable mode `100755`.

Why it matters:

These may be required reproducibility artifacts, generated docs, local benchmark
outputs, or accidental binary churn. Cleanup should not delete them without a
regeneration manifest and owner sign-off, but leaving them unmanaged creates
large diffs and architecture-review noise.

Risk:

Medium for repository hygiene; high if native binaries are platform-specific
but treated as portable source artifacts.

Validation needed:

- Build an artifact manifest: path, tracked/ignored, generator command, owner,
  expected churn, retention policy.
- Decide which binaries belong in git, release assets, LFS, or local ignored
  output.
- Normalize executable file modes for non-executable assets such as `.otf`
  fonts after owner approval.

Owner questions:

- Are inference verification binaries intentionally tracked for macOS arm64?
- Should benchmark `latest` outputs be committed snapshots or ignored local run
  products?
- Who owns regeneration of `action-docs.ts` and prompt plugin specs?

### F-17 - Root and cloud scripts mix validation with workspace mutation

Area: Build/release tooling

Evidence:

- Root `package.json:21` has a long `postinstall` chain patching nested dist
  packages, tsup declarations, rolldown fallback, workspace symlinks, native
  plugin links, llama.cpp, and bigint-buffer.
- Root `package.json:73` defines `clean` as `turbo run clean` followed by
  removing `dist`, `.turbo`, `node_modules`, lockfiles, `.eliza`, `.elizadb`,
  then reinstalling and rebuilding.
- `cloud/package.json:15` deletes files inside `node_modules/thread-stream`
  during `postinstall`.
- `cloud/package.json:58` defines `db:local:reset` as `rm -rf .eliza/.pgdata`.

Why it matters:

Repo cleanup validation needs safe, repeatable commands. Current scripts embed
patching and destructive local cleanup in names that can be mistaken for routine
validation.

Risk:

Medium. The risk is accidental local state loss or non-reproducible validation
results during multi-worker cleanup.

Validation needed:

- Document a safe command allowlist for cleanup workers.
- Split destructive scripts from validation scripts or rename them with clearer
  warnings.
- Move postinstall patching toward explicit toolchain fixes or isolated setup
  scripts where possible.

Owner questions:

- Which postinstall patches are still required on current dependency versions?
- Can `clean` be split into `clean:build-artifacts` and a clearly destructive
  `clean:workspace-reset`?

## Cross-Cutting Cleanup Questions

- Which temporary Wave 1/Wave 2 files are now historical and should become
  re-export barrels or deleted contracts?
- What is the canonical validation suite for cleanup workers while broad
  `test:lint` is intentionally failing?
- Which mounted cloud stubs are product contracts, and which are migration
  scaffolding that should be hidden from generated route parity counts?
- Which generated artifacts are intentionally tracked, and what command
  regenerates each one?
- Should audit scripts ignore ignored generated files by default to avoid
  counting local build outputs under `src`?

## Suggested Next Validation Batches

1. LifeOps/health contract batch:
   - Convert or test the three ScheduledTask stub copies against the canonical
     type.
   - Gate first-run fallback runner to tests.
   - Implement and unskip the scheduler concurrency test.

2. Cloud route batch:
   - Regenerate inventory/coverage/frontend gap docs against the 529-route tree.
   - Produce a current list of mounted `501` routes with owners and decisions.
   - Resolve streaming billing behavior before treating streaming sessions as a
     complete API.

3. Frontend cleanup batch:
   - Decide whether onboarding `flow.ts` is live or legacy, then align README,
     callbacks, and tests.
   - Finish main-tab ownership extraction before changing the hardcoded `chat`
     fallback.
   - Gate or remove production-visible debug logs.

4. Artifacts/tooling batch:
   - Create a generated-artifact manifest before deleting or normalizing files.
   - Baseline `lint-no-vi-mocks` or keep it out of cleanup acceptance gates.
   - Define safe validation commands that do not run destructive clean/install
     mutation scripts.

