# Wave 02 - LifeOps And Plugin-Health Contracts Dry Run

Status: dry run only. No source, config, or test files were changed.

## Scope

This wave audits the LifeOps / plugin-health architecture contract after the
Wave 1 and Wave 2 cleanup work. It does not propose deleting behavior during
the dry run. It records candidate files and symbols that need owner approval
before any implementation pass.

Primary invariants, from `AGENTS.md`:

- One task primitive: every reminder, check-in, follow-up, watcher, recap,
  approval, and output is a `ScheduledTask` routed through
  `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts`.
- Runner behavior is structural. It may inspect `kind`, `trigger`,
  `shouldFire`, `completionCheck`, `pipeline`, `output`, `subject`,
  `priority`, and `respectsGlobalPause`; it must not inspect
  `promptInstructions` content.
- Health is a separate plugin. LifeOps consumes it through public exports and
  registries, not through plugin internals.
- Connectors and channels return typed `DispatchResult`, not boolean.
- There is one knowledge graph model: `EntityStore` and `RelationshipStore`.
  Cadence belongs on the relationship edge.
- Identity observations go through `observeIdentity`; manual merges are
  auditable.

## Read-Only Inventory

Read-only commands used:

```bash
rg --files plugins/app-lifeops/src | rg 'scheduled-task|default-packs|connectors|channels|send-policy|entities|relationships|graph-migration|identity|followup|checkin|seed-routine|context|signals|registries|owner|first-run|global-pause|handoff'
rg --files plugins/plugin-health/src
rg 'contract-stubs' plugins/app-lifeops/src plugins/plugin-health/src
rg 'DispatchResult|Promise<boolean>|return true|return false' plugins/app-lifeops/src/lifeops/connectors plugins/app-lifeops/src/lifeops/channels plugins/plugin-health/src/connectors plugins/plugin-health/src/health-bridge
rg 'LifeOpsDefinition|seed-routines|stretch-decider|CHECKIN|LIST_OVERDUE_FOLLOWUPS|MARK_FOLLOWUP_DONE|SET_FOLLOWUP_THRESHOLD|ContactResolver|resolver-shim|getCanonicalIdentityGraph|identity-observations|LifeOpsRelationship|context-graph' plugins/app-lifeops/src packages/shared/src/contracts plugins/app-lifeops/test
rg 'ScheduledTask|DispatchResult|DefaultPack|ConnectorContribution|ChannelContribution|RelationshipStore|EntityStore|LifeOpsDefinition|LifeOpsRelationship' plugins/app-lifeops/src plugins/plugin-health/src packages/shared/src/contracts/lifeops.ts
```

## Summary Findings

The current code mostly follows the intended architecture, but the cleanup
boundary is not fully burned down:

- `ScheduledTask` is implemented and the runner documents the required
  invariants. However, at least three active stub/copy surfaces still mirror
  parts of the contract.
- `DispatchResult` is canonical in LifeOps connector/channel contracts, but
  plugin-health still imports its own `connectors/contract-stubs.ts` copy and
  registers disconnected stub connector implementations.
- plugin-health default packs exist but are not wired into a runtime
  `defaultPackRegistry`; the LifeOps runtime does not appear to register such
  a registry on `IAgentRuntime`.
- app-lifeops default-pack lint covers app packs only. plugin-health packs are
  not part of the CLI lint corpus unless an implementation pass explicitly
  calls the runtime lint helpers against `HEALTH_DEFAULT_PACKS`.
- The legacy `LifeOpsDefinition` and `LifeOpsRelationship` surfaces still
  exist as compatibility and UI/API surfaces. They are not necessarily wrong,
  but they must be classified as supported compatibility or removal candidates.
- `LifeOpsContextGraph` is an in-memory graph-like surface alongside
  `EntityStore` / `RelationshipStore`. This needs an owner decision because
  `AGENTS.md` forbids a second knowledge-graph store.
- Docs mostly describe the new architecture, but some REST and setup docs
  still say the relationship graph has its own `RELATIONSHIP` action or call
  follow-ups "overdue contacts" rather than edge-subject tasks.

## Candidate Manifest

### 1. Duplicate and stub contracts

Candidate files and symbols:

| File | Symbols | Current role | Proposed cleanup | Risk |
|---|---|---|---|---|
| `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts` | `ScheduledTask`, `ScheduledTaskRunner`, `TaskExecutionProfile`, `ScheduledTaskRef` | Canonical runner contract. Includes newer `executionProfile` field not present in older stubs. | Keep as canonical. Use it as the source for all LifeOps ScheduledTask consumers. | Low. |
| `plugins/app-lifeops/src/default-packs/contract-stubs.ts` | `ScheduledTask`, `ScheduledTaskSeed`, `DefaultPack`, `RelationshipStoreStub`, `ConnectorRegistryStub` | Active Wave-1 stub import target for app default packs. | Replace with type re-exports from canonical owner modules or split to a real default-pack contract module. | Medium. Wide imports from all app default packs. |
| `plugins/app-lifeops/src/default-packs/registry-types.ts` | `DefaultPack`, `DefaultPackRegistry` | Default-pack envelope imports stub `ScheduledTaskSeed`. | Retain envelope, but import `ScheduledTaskSeed` from canonical ScheduledTask contract. | Medium. |
| `plugins/app-lifeops/src/lifeops/wave1-types.ts` | `ScheduledTask`, `ScheduledTaskInput`, `TerminalState` | Standalone copy of old Wave-1 ScheduledTask shape. Missing `executionProfile`. | If unreferenced, remove or convert to re-export. If referenced externally, mark deprecated with support window. | Medium. Need export/import check. |
| `plugins/plugin-health/src/default-packs/contract-stubs.ts` | `ScheduledTask`, `ScheduledTaskSeed`, `DefaultPack`, `DefaultPackRegistry` | plugin-health copy of default-pack and ScheduledTask contracts. | Replace with a public package-level contract that does not import LifeOps internals, or re-export from shared contract package if that becomes the approved owner. | High. Cross-plugin dependency boundary. |
| `plugins/plugin-health/src/connectors/contract-stubs.ts` | `DispatchResult`, `ConnectorContribution`, `AnchorRegistry`, `BusFamilyRegistry`, `RuntimeWithHealthRegistries` | plugin-health copy of connector/anchor/family contracts. | Replace with canonical public connector/registry contracts once owner approves package boundary. | High. Health soft-dependency posture depends on this shape. |
| `plugins/plugin-health/src/contracts/lifeops.ts` | `LIFEOPS_EVENT_KINDS`, `LIFEOPS_TELEMETRY_FAMILIES`, `LifeOpsDefinitionRecord`, `LifeOpsRelationship` | Full-ish duplicate of `packages/shared/src/contracts/lifeops.ts`; used by health contract files. | Do not edit blindly. Decide whether plugin-health needs a narrow health-only contract instead of a large copied LifeOps contract. | High. Broad shared type surface. |
| `packages/shared/src/contracts/lifeops.ts` | `LifeOpsDefinition*`, `LifeOpsRelationship*`, telemetry/event unions | Shared legacy and current LifeOps contract surface. | Keep as external compatibility until API deprecation plan is approved. Add a migration note if retained. | High. Public/shared API. |

Implementation shape after approval:

1. Pick canonical public contract owners:
   - ScheduledTask: `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts` or a shared package export.
   - Connector/channel/DispatchResult: `plugins/app-lifeops/src/lifeops/connectors/contract.ts` plus `channels/contract.ts`, or a shared plugin contract package.
   - DefaultPack envelope: `plugins/app-lifeops/src/default-packs/registry-types.ts` or a shared contract package.
2. Replace `contract-stubs.ts` imports in small batches.
3. Add type-only compatibility re-exports for one release if external imports exist.
4. Remove or rename `wave1-types.ts` only after `git grep` confirms no live import.

Validation:

```bash
git grep -n 'contract-stubs\|wave1-types'
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify
/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-health test
/Users/shawwalters/.bun/bin/bun run typecheck
```

Owner questions:

- Should plugin-health be allowed to import canonical LifeOps contract modules,
  or must shared registry contracts live outside app-lifeops?
- Is `plugins/plugin-health/src/contracts/lifeops.ts` an intentional vendored
  copy for plugin independence, or stale duplication to remove?
- Should `TaskExecutionProfile` become part of the frozen public
  `ScheduledTask` contract before stubs are collapsed?

### 2. ScheduledTask surfaces

Canonical surfaces:

- `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts`
  - `ScheduledTask`
  - `ScheduledTaskRunner`
  - `ScheduledTaskVerb`
  - `ScheduledTaskFilter`
  - `TaskExecutionProfile`
  - `ChannelKeyError` is in `runner.ts`
- `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts`
  - `createScheduledTaskRunner`
  - `ScheduledTaskRunnerHandle`
  - `ScheduledTaskStore`
  - `ScheduledTaskDispatcher`
  - `getEscalationCursor`
- `plugins/app-lifeops/src/lifeops/scheduled-task/runtime-wiring.ts`
  - `createRuntimeScheduledTaskRunner`
  - `createProductionScheduledTaskDispatcher`
  - diagnostic shims for missing bus/subject store
- `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.ts`
  - `processDueScheduledTasks`
  - pending-prompt registration from fired tasks
- `plugins/app-lifeops/src/actions/scheduled-task.ts`
  - `scheduledTaskAction` named `SCHEDULED_TASKS`
- `plugins/app-lifeops/src/routes/scheduled-tasks.ts`
  - REST list/create/apply/history/dev-registry surface

Positive observations:

- `runner.ts` explicitly documents the core invariants: no
  `promptInstructions` pattern matching, `acknowledged` is non-terminal,
  snooze resets ladder, global pause is structural, and `idempotencyKey`
  dedupes schedules.
- `runner.schedule()` validates escalation channel keys against injected
  `ChannelRegistry` keys when available.
- `runtime-wiring.ts` uses `promptInstructions` only as outbound message
  content, not as a behavior selector.

Candidate cleanup / review:

| Surface | Candidate | Proposed change | Risk |
|---|---|---|---|
| `ScheduledTaskRef` | Canonical type is `string | ScheduledTask`; app default-pack stub allows `string | ScheduledTask | ScheduledTaskSeed`. | Decide whether inline seed children are a real runner API. If yes, update canonical type. If no, change pack pipeline children to scheduleable canonical refs. | Medium. Pipeline default packs can break. |
| `executionProfile` | Present in canonical `ScheduledTask`, absent from stubs and docs shown in `wave1-interfaces.md`. | Update public contract docs or keep as internal optional extension. | Medium. Contract drift. |
| `actions/scheduled-task.ts` | Transitional follow-up aliases are still described in comments and similes. | Confirm support window, then remove alias language only after planner tests pass. | Medium. Planner regression. |
| `runtime-wiring.ts` | Missing `SubjectStoreView` remains a warn-once diagnostic shim. | Decide whether the production runner should always inject real Entity/Relationship subject update checks. | Medium. `completionCheck.kind = subject_updated` may silently never complete outside tests. |
| `due.ts` / `after_task` | Ambiguity register says after-task branches are scheduler-driven and do not auto-fire in runner-only fixtures. | Keep documented or add explicit route/scheduler tests before changing. | Low if documented. |

Validation tests:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test src/lifeops/scheduled-task/runner.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test src/lifeops/scheduled-task/scheduler.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test scheduled-task-end-to-end.e2e.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test scheduled-task-action.test.ts
rg -n 'promptInstructions' plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts plugins/app-lifeops/src/lifeops/scheduled-task/due.ts
```

### 3. DispatchResult and connector/channel surfaces

Canonical app-lifeops surfaces:

- `plugins/app-lifeops/src/lifeops/connectors/contract.ts`
  - `DispatchResult`
  - `ConnectorContribution`
  - `ConnectorRegistry`
  - `ConnectorOAuthConfig`
- `plugins/app-lifeops/src/lifeops/channels/contract.ts`
  - `ChannelContribution`
  - `ChannelRegistry`
  - channel `send()` returns `Promise<DispatchResult>`
- `plugins/app-lifeops/src/lifeops/connectors/default-pack.ts`
  - `registerDefaultConnectorPack`
- `plugins/app-lifeops/src/lifeops/channels/default-pack.ts`
  - `registerDefaultChannelPack`
- `plugins/app-lifeops/src/lifeops/messaging/owner-send-policy.ts`
  - Gmail approval policy now resolves through `ConnectorRegistry`

plugin-health surfaces:

- `plugins/plugin-health/src/connectors/contract-stubs.ts`
  - local copy of `DispatchResult` and `ConnectorContribution`
- `plugins/plugin-health/src/connectors/index.ts`
  - `HEALTH_CONNECTOR_KINDS`
  - `HEALTH_ANCHORS`
  - `HEALTH_BUS_FAMILIES`
  - `registerHealthConnectors`
  - `registerHealthAnchors`
  - `registerHealthBusFamilies`
  - `buildConnectorContribution` currently returns `verify: false`,
    disconnected status, `send: transport_error`, and `read: null`

Candidate cleanup / review:

| Surface | Proposed change | Risk |
|---|---|---|
| plugin-health connector stubs | Wire health connectors to real `health-bridge` read/status/verify behavior or explicitly mark them non-send/read-only. | High. Health pairing and OAuth flows are user-facing. |
| plugin-health `send` on health connectors | Health connectors likely should not advertise `send` unless there is real outbound behavior. If kept, ensure typed failure is intentionally tested. | Medium. Current typed failure is safe but may mislead registry consumers. |
| `ConnectorContribution.verify(): Promise<boolean>` | This boolean is allowed by the contract; the no-boolean invariant applies to dispatch. Document the distinction in report/README to avoid false positives. | Low. |
| `HEALTH_CONNECTOR_CAPABILITIES` | Duplicates `LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES` in plugin-health contracts. | Medium. Drift if capability names change. |
| `actions/connector.ts` | `VALID_CONNECTORS` language says values are kept narrow, while registry can accept any connector. | Low. Text cleanup after Wave 7. |

Validation:

```bash
rg -n 'send\\?\\(payload: unknown\\): Promise<DispatchResult>|Promise<DispatchResult>' plugins/app-lifeops/src/lifeops/connectors plugins/app-lifeops/src/lifeops/channels plugins/plugin-health/src/connectors
rg -n 'Promise<boolean>|return true|return false' plugins/app-lifeops/src/lifeops/connectors plugins/plugin-health/src/connectors
/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-health test
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test cross-channel-search.integration.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test routes/scheduled-tasks.test.ts
```

Owner questions:

- Should health connectors be registered as read-only connector contributions
  with no `send` function?
- Should the public connector contract live outside app-lifeops so
  plugin-health can stop carrying stubs without importing LifeOps internals?
- What is the certification test for a health connector's `status()` and
  `read()` once the legacy bridge is retired?

### 4. Default-pack lint and registration coverage

app-lifeops coverage:

- `plugins/app-lifeops/src/default-packs/index.ts`
  - `DEFAULT_PACKS`
  - `getAllDefaultPacks`
  - `getDefaultEnabledPacks`
  - `getOfferedDefaultPacks`
  - `getDefaultPack`
- `plugins/app-lifeops/src/default-packs/lint.ts`
  - `lintPromptText`
  - `lintPack`
  - `lintPacks`
  - `formatFindings`
- `plugins/app-lifeops/scripts/lint-default-packs.mjs`
  - CI-fail mode by default
- `plugins/app-lifeops/package.json`
  - `pretest` runs `node scripts/lint-default-packs.mjs`
  - `verify` runs `bun run lint:default-packs && bun run build:types && bun run test`

plugin-health coverage:

- `plugins/plugin-health/src/default-packs/index.ts`
  - `HEALTH_DEFAULT_PACKS`
  - `registerHealthDefaultPacks`
- `plugins/plugin-health/src/default-packs/bedtime.ts`
- `plugins/plugin-health/src/default-packs/wake-up.ts`
- `plugins/plugin-health/src/default-packs/sleep-recap.ts`
- `plugins/plugin-health/src/__tests__/smoke.test.ts`
  - asserts pack count and anchor trigger shape

Gaps:

- The default-pack lint script scans `plugins/app-lifeops/src/default-packs`.
  It does not scan `plugins/plugin-health/src/default-packs`.
- `registerHealthDefaultPacks()` checks `runtime.defaultPackRegistry`, but
  app-lifeops plugin init registers connector/channel/anchor/event/family
  registries and does not appear to create or attach `defaultPackRegistry`.
- Health default-pack records do not export stable record-id constants and do
  not set `idempotencyKey`; `AGENTS.md` asks new default packs to export stable
  record IDs.

Proposed cleanup:

1. Add a real default-pack registry owner in app-lifeops, or declare that
   first-run consumes static `getAllDefaultPacks()` only and plugin-health packs
   are opt-in through a different path.
2. If the registry is real, attach it to runtime before plugin-health init
   expects it, and have app-lifeops first-run seed from registry contents.
3. Extend lint coverage to include `HEALTH_DEFAULT_PACKS` by calling
   `lintPacks()` in a plugin-health test or adding a package-agnostic lint
   command.
4. Add record-id constants and `idempotencyKey` values for:
   - `bedtimeDefaultPack.records[0]`
   - `wakeUpDefaultPack.records[0]`
   - `sleepRecapDefaultPack.records[0]`

Validation:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops lint:default-packs
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test default-packs.lint.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test default-packs.schema.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-health test src/__tests__/smoke.test.ts
git grep -n 'defaultPackRegistry'
```

Owner questions:

- Should health packs seed lazily only when a health connector pairs, as the
  README says, or should they be merely offered in first-run customize?
- Should plugin-health own a package-local lint test importing LifeOps lint
  helpers, or should the lint corpus move to a shared contract package?
- Are health pack IDs intentionally absent because they are not auto-seeded,
  or is that a contract gap?

### 5. Context graph and legacy task surfaces

Candidate graph / identity files:

| File | Symbols | Current role | Proposed decision |
|---|---|---|---|
| `plugins/app-lifeops/src/lifeops/entities/store.ts` | `EntityStore` | Canonical entity node store. | Keep. |
| `plugins/app-lifeops/src/lifeops/relationships/store.ts` | `RelationshipStore` | Canonical relationship edge store. | Keep. |
| `plugins/app-lifeops/src/lifeops/graph-migration/migration.ts` | `runGraphMigration`, `MigrationReport` | One-shot legacy relationship migration. | Keep until migration completed and audited. |
| `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts` | `ContactResolverShim`, `createContactResolverShim` | Explicit old ContactResolver shim. | Remove only if unreferenced and owner approves support-window end. |
| `plugins/app-lifeops/src/lifeops/identity-observations.ts` | legacy identity-observation planner types/functions | Kept so legacy callers compile. | Migrate callers to `identity-observations/observer.ts`, then remove. |
| `plugins/app-lifeops/src/lifeops/identity-observations/observer.ts` | `ingestIdentityObservationsThroughGraph`, `applyOneObservation` | New observation path through EntityStore/RelationshipStore. | Keep. |
| `plugins/app-lifeops/src/lifeops/context-graph.ts` | `LifeOpsContextGraph`, node/edge/evidence types | Separate in-memory context graph. | Owner must classify as context assembly cache, not a second knowledge-graph store; otherwise fold into Entity/Relationship model. |
| `plugins/app-lifeops/src/lifeops/service-mixin-relationships.ts` | `withRelationships` | Legacy LifeOpsRelationship API, projects writes into graph best-effort. | Keep only as compatibility if UI/API still depend on `LifeOpsRelationship`; otherwise remove after API migration. |
| `plugins/app-lifeops/src/lifeops/repository.ts` | `upsertRelationship`, `listRelationships`, `logRelationshipInteraction` | Legacy table access plus graph methods. | Do not remove until routes/UI clients migrate. |

Candidate legacy task/follow-up files:

| File | Symbols | Current role | Proposed decision |
|---|---|---|---|
| `plugins/app-lifeops/src/lifeops/service-mixin-definitions.ts` | `LifeOpsDefinitionService`, `createDefinition`, `updateDefinition` | Legacy definition API still used by routes/UI/actions. | Classify as supported owner-reminder/routine UI surface or migrate to ScheduledTask. |
| `plugins/app-lifeops/src/lifeops/seed-routines.ts` | legacy seed routine alias | Transitional alias to habit-starters. | Remove only after all clients and migrator no longer import it. |
| `plugins/app-lifeops/src/lifeops/seed-routine-migration/migrator.ts` | `buildSeedRoutineMigrationDiff`, `applySeedRoutineMigration` | One-shot migration to ScheduledTask seeds. | Keep until migration is run and signed off. |
| `plugins/app-lifeops/src/followup/actions/listOverdueFollowups.ts` | `listOverdueFollowupsAction` | Standalone follow-up action remains registered/exported. | Candidate collapse into `SCHEDULED_TASKS` after planner parity tests. |
| `plugins/app-lifeops/src/followup/actions/markFollowupDone.ts` | `markFollowupDoneAction` | Standalone follow-up action remains registered/exported. | Candidate collapse into `SCHEDULED_TASKS`. |
| `plugins/app-lifeops/src/followup/actions/setFollowupThreshold.ts` | `setFollowupThresholdAction` | Standalone follow-up action remains registered/exported. | Candidate collapse into relationship edge cadence + ScheduledTask. |
| `plugins/app-lifeops/src/followup/followup-tracker.ts` | follow-up tracker worker | Separate worker surface. | Verify whether it creates/maintains `ScheduledTask` rows or remains a second task mechanism. |
| `plugins/app-lifeops/src/actions/scheduled-task.ts` | `scheduledTaskAction` | Canonical `SCHEDULED_TASKS` umbrella. | Keep; use as migration target. |

Validation before any removal:

```bash
git grep -n 'createContactResolverShim\|ContactResolverShim\|ResolvedContactShim'
git grep -n 'identity-observations'
git grep -n 'LifeOpsContextGraph'
git grep -n 'LIST_OVERDUE_FOLLOWUPS\|MARK_FOLLOWUP_DONE\|SET_FOLLOWUP_THRESHOLD'
git grep -n 'LifeOpsDefinitionRecord\|CreateLifeOpsDefinitionRequest\|LifeOpsRelationship'
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test relationships.e2e.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test relationships-graph.e2e.test.ts
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test assistant-user-journeys.followup-repair.e2e.test.ts
```

Owner questions:

- Is `LifeOpsContextGraph` a permitted context/evidence cache, or is it a
  forbidden second knowledge graph store under `AGENTS.md`?
- Are `LifeOpsDefinition` routes/UI still product-supported, or should they
  become compatibility wrappers over `ScheduledTask`?
- Does the follow-up tracker count as a parallel task primitive, or is it only
  a reconciler that writes/observes `ScheduledTask` state?

### 6. plugin-health contract boundary

Candidate files:

- `plugins/plugin-health/src/index.ts`
  - exports health public surface and registers contributions at init.
- `plugins/plugin-health/src/actions/index.ts`
  - `HEALTH_ACTIONS_DEFERRED_TO_WAVE_2`
- `plugins/app-lifeops/src/actions/health.ts`
- `plugins/app-lifeops/src/actions/screen-time.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-health.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-sleep.ts`
- `plugins/app-lifeops/src/lifeops/service-mixin-screentime.ts`
- `plugins/plugin-health/src/screen-time/index.ts`
- `plugins/plugin-health/src/health-bridge/*`

Observed drift:

- plugin-health README says health owns connectors and default packs.
- plugin-health actions file says health and screen-time actions remain in
  app-lifeops because they instantiate `LifeOpsService`.
- app-lifeops still has `actions/health.ts`, `actions/screen-time.ts`, and
  service mixins for health/sleep/screentime.
- This may be intentional soft-dependency staging, but the boundary is not
  clean enough to call finished.

Proposed cleanup:

1. Decide whether app-lifeops continues to own user-visible `OWNER_HEALTH` /
   screen-time actions while plugin-health owns domain logic, or whether
   plugin-health owns actions too.
2. If plugin-health owns actions, extract the construction surface so actions
   do not instantiate `LifeOpsService`.
3. Add import-boundary checks:
   - app-lifeops may import plugin-health public exports only.
   - plugin-health must not import app-lifeops internals.
4. Keep `/api/lifeops/health/*` as LifeOps proxy routes only if docs clearly
   call them proxies.

Validation:

```bash
rg -n 'from .*(app-lifeops|plugins/app-lifeops)' plugins/plugin-health/src
rg -n 'plugin-health' plugins/app-lifeops/src
/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-health test
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops test plugin-health-anchor.integration.test.ts
```

Owner questions:

- Who owns user-visible health actions: app-lifeops, plugin-health, or a proxy
  layer?
- Is `HEALTH_ACTIONS_DEFERRED_TO_WAVE_2` still true after the current cleanup,
  or should it be replaced with a current owner note?
- Should app-lifeops sleep/health/screentime mixins be compatibility wrappers
  or removed after action extraction?

### 7. Docs drift

Candidate docs:

| File | Drift candidate | Proposed change |
|---|---|---|
| `docs/rest/lifeops.md` | Says relationships have their own action `RELATIONSHIP`. Current user-visible umbrella appears to be `ENTITY`, with `RELATIONSHIP` preserved as a simile. | Update to say entity/relationship graph routes are backed by `EntityStore` and `RelationshipStore`; planner action is `ENTITY`, follow-up task operations route through `SCHEDULED_TASKS`. |
| `docs/rest/lifeops.md` | Relationship REST table omits `PATCH /api/lifeops/relationships/:id` and `POST /api/lifeops/relationships/:id/retire` from the frozen contract. | Compare to `routes/relationships.ts`, then update docs if routes exist. |
| `docs/rest/lifeops.md` | Connectors list says status supports `health`; plugin-health registers six concrete health connector kinds. | Clarify proxy vs concrete connector kinds. |
| `docs/user/lifeops-setup.mdx` | `followup-starter` says overdue contact rather than overdue relationship edge. | Update wording to edge/cadence language. |
| `plugins/app-lifeops/coverage-matrix.md` | Rows 14, 18, 22, 23 are intentionally uncovered after LARP purge; may be fine but should be cross-linked to Wave 5 tests report. | No code change; owner should decide whether uncovered rows block cleanup signoff. |
| `plugins/app-lifeops/docs/audit/wave1-interfaces.md` | Frozen ScheduledTask does not include `executionProfile`. | Update only if the optional field is public contract, not internal extension. |
| `plugins/plugin-health/README.md` | Says default packs register lazily when a health connector pairs; current `registerHealthDefaultPacks()` only registers if `runtime.defaultPackRegistry` exists. | Align README with actual runtime behavior after registry decision. |

Validation:

```bash
rg -n 'RELATIONSHIP|overdue contact|defaultPackRegistry|executionProfile|plugin-health' docs plugins/app-lifeops/docs plugins/plugin-health/README.md
/Users/shawwalters/.bun/bin/bun run test:launch-qa:docs
```

## Proposed Implementation Order

1. Contract owner decision: choose canonical shared/public homes for
   ScheduledTask, DispatchResult, ConnectorContribution, ChannelContribution,
   and DefaultPack.
2. Add missing tests before edits:
   - health default-pack lint test,
   - plugin-health registry integration test with an actual default-pack
     registry,
   - import-boundary grep test,
   - follow-up tracker single-primitive test.
3. Collapse type stubs into re-exports.
4. Wire or explicitly disable plugin-health stub connector send/read behavior.
5. Decide `LifeOpsContextGraph` classification.
6. Migrate or classify legacy `LifeOpsDefinition`, `LifeOpsRelationship`,
   and standalone follow-up action surfaces.
7. Update docs after behavior decisions land.

## Global Validation Gate

Run after any approved implementation batch:

```bash
export BUN=/Users/shawwalters/.bun/bin/bun
export NODE_OPTIONS=--max-old-space-size=8192

$BUN run --cwd plugins/app-lifeops verify
$BUN run --cwd plugins/plugin-health test
$BUN run typecheck
$BUN run test:ci

rg -n 'contract-stubs|wave1-types' plugins/app-lifeops/src plugins/plugin-health/src
rg -n 'from .*(app-lifeops|plugins/app-lifeops)' plugins/plugin-health/src
rg -n 'promptInstructions' plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts
rg -n 'LIST_OVERDUE_FOLLOWUPS|MARK_FOLLOWUP_DONE|SET_FOLLOWUP_THRESHOLD' plugins/app-lifeops/src plugins/app-lifeops/test
```

Pass criteria:

- One canonical `ScheduledTask` contract is used by app-lifeops default packs,
  scheduler, routes, and actions.
- plugin-health no longer carries divergent copies unless the owner explicitly
  approves vendored contract copies.
- Health default packs are linted by CI or an equivalent package test.
- Health connector contributions either wire real read/status behavior or
  clearly advertise only safe stub/no-send behavior.
- No connector or channel dispatch path returns free-form boolean.
- No `ScheduledTask` runner behavior depends on `promptInstructions` content.
- Legacy task and relationship surfaces have explicit support windows.
- Docs reflect actual action/route owners.

## High-Risk Deferrals

Do not implement without owner approval:

- Deleting `LifeOpsDefinition*` shared contracts or routes. The UI client still
  imports and calls these surfaces.
- Deleting `LifeOpsRelationship*` shared contracts or repository helpers. The
  compatibility mixin and routes still project between legacy rows and graph
  stores.
- Removing standalone follow-up actions before planner/action-gating tests are
  updated.
- Moving plugin-health to import app-lifeops internals. That would violate the
  soft-dependency boundary unless contracts are moved to a shared package.
- Removing `LifeOpsContextGraph` before deciding whether it is a context cache
  or a second graph store.

## Owner Questions

1. Where should cross-plugin contracts live so plugin-health can stop carrying
   `contract-stubs.ts` without importing app-lifeops internals?
2. Is `TaskExecutionProfile` part of the public ScheduledTask contract now?
3. Should plugin-health default packs seed only after connector pairing, or
   should they be offered during first-run customize?
4. Is `LifeOpsContextGraph` allowed as a context/evidence cache, or must it be
   folded into `EntityStore` / `RelationshipStore`?
5. Are `LifeOpsDefinition` and legacy relationship routes supported product
   APIs, compatibility wrappers, or removal candidates?
6. What is the end date for standalone follow-up actions now that
   `SCHEDULED_TASKS` exists?
7. Should health connectors expose `send()` at all?
8. Should plugin-health own user-visible health actions, or should app-lifeops
   own action routing while plugin-health owns domain logic?
