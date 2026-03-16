# Unified Prompt Batcher Roadmap

## Delivered

### Phase 1: Core batcher + dispatcher + wrappers

Status: complete

Delivered:

- `PromptBatcher` and `PromptDispatcher`
- section registry with idempotent `addSection()`
- message cadence ticking from the message service
- per-affinity draining
- wrappers: `askOnce`, `onDrain`, `think`, `askNow`
- runtime integration and public exports

Why this phase came first:

- it establishes the one shared control plane
- later features are much cheaper to add once the lifecycle path exists

### Phase 2: Caching

Status: complete

Delivered:

- in-memory cache
- adapter-backed persistence via runtime cache methods
- stale-while-revalidate support
- cache invalidation helpers

Why:

- startup artifacts should not regenerate every boot when nothing changed

### Phase 3: Validation, retry, shouldRun, full dispatch

Status: complete

Delivered:

- per-section `shouldRun`
- validation hooks
- isolated retries
- model separation heuristics
- `dependsOnEvaluators` second-pass support

Why:

- batching only works long-term if strict sections can reject bad outputs safely

### Phase 4: Observability

Status: complete

Delivered:

- drain logging
- stats counters
- quiet hours support

Why:

- operators need to understand when batching is helping and when prompts are getting too dense

### Phase 5: Audit + migration proof

Status: complete

Delivered:

- pre-callback audit registry
- `processActions()` integration
- reflection evaluator migrated to the batcher

Why:

- this proves the system handles both deferred and blocking consumers

### Phase 6: Autonomy on the batcher (Option A)

Status: complete

Delivered:

- Autonomy driven only by the prompt batcher; no Task creation or task worker.
- Execution facade `runAutonomyPostResponse()` so batcher onResult runs the same post-LLM steps as the message pipeline (processActions, memory, evaluate).
- Autonomy section with contextBuilder (room context + last thought from memories), schema aligned with message pipeline, onResult wiring to the facade.
- enable/disable/stop register or remove the "autonomy" section; optional startup cleanup of orphaned AUTONOMY_THINK tasks.

Why this phase:

- Autonomy was the third major consumer of "ask the model, then do something with the result." Moving it onto the batcher completes the one-register design: startup, evaluators, and autonomy all use the same orchestration path. Option A (no Task) was chosen to minimize moving parts and persistence surface.

### Phase 7: Task system upgrades + batcher-on-tasks

Status: complete

Delivered:

- **Task system as scheduler:** TaskMetadata extended with `notBefore`, `notAfter`, `paused`, `failureCount`, `maxFailures`, `lastError`, `baseInterval`. TaskWorker gains `shouldRun` (scheduler) and `canExecute` (actions); `validate` deprecated. TaskService: retry/backoff, auto-pause after maxFailures, dynamic `nextInterval` from worker, public API `executeTaskById`, `pauseTask`, `resumeTask`, `getTaskStatus`, `markDirty`. Runtime calls `markDirty()` after create/update/delete tasks.
- **Batcher on tasks:** PromptBatcher no longer has its own timer. Per-affinity BATCHER_DRAIN tasks (queue + repeat) drive periodic drains. Batcher creates/updates/deletes these tasks in addSection/removeSection and on dispose; `drainAffinityGroup` public; `getIdealTickInterval`, `getSectionCountForAffinity` added.
- **Scoped tick(message):** Only message-relevant affinities (default, room:X, audit:X) are drained from tick when batch size or immediate; autonomy is task-driven only. No-arg `tick()` is a no-op.
- **Plugin use of upgrades:** Status action uses `getTaskStatus` for queue tasks; FollowUp workers use `shouldRun` to skip when contact is missing. Post-plan fixes: backoff uses baseInterval, non-repeat tasks deleted on failure, BATCHER_DRAIN uses maxFailures -1 (JSON-safe), quiet hours removed.

Why this phase:

- The batcher needed a single place for "when" (scheduling, pause, visibility) without a second timer. The task system already had a 1s poll and DB-backed tasks; extending it made it the scheduler for both batcher drains and future recurring work. Retry/dead-letter prevent infinite retry storms; `shouldRun`/`canExecute` separate scheduler gating from action authorization. One scheduling surface gives operators one place to pause, resume, and inspect tasks.

### Phase 8: Cross-runtime task scheduler (getTasks agentIds, daemon, serverless)

Status: complete

Delivered:

- **getTasks(agentIds) only:** `getTasks` now takes required `agentIds: UUID[]` (no optional `agentId`). All adapters (in-memory, plugin-sql PG/MySQL) and call sites updated; empty `agentIds` returns `[]`. WHY: multi-tenant safety; daemon can batch one query for many agents.
- **Per-daemon scheduler:** Procedural module `task-scheduler.ts` with one timer, one `getTasks({ tags: ["queue"], agentIds })` per tick, dispatch to registered runtimes' `runTick(tasks)`. Exports: `startTaskScheduler`, `stopTaskScheduler`, `getTaskSchedulerAdapter`, `registerTaskSchedulerRuntime`, `unregisterTaskSchedulerRuntime`, `markTaskSchedulerDirty`. TaskService registers when daemon present and uses `markTaskSchedulerDirty` instead of local dirty flag. WHY: N runtimes → 1 DB query per tick instead of N.
- **runTick(tasks) extraction:** TaskService exposes `runTick(tasks)` (validate + execute; does not fetch). Used by local `checkTasks()` and by daemon after batched fetch. WHY: daemon fetches once, then dispatches to N runtimes.
- **Serverless mode:** `runtime.serverless` (constructor option); when true, TaskService does not start a timer or register with daemon. Public `runDueTasks()` runs due queue tasks once (one getTasks + runTick). WHY: serverless has no long-lived process; host drives execution via cron or per request.

Why this phase:

- Single-process apps keep a simple local timer; multi-agent daemons need one shared timer and batched getTasks to avoid N queries per second; serverless needs an explicit "run due tasks now" entry point. See `docs/TASK_SCHEDULER.md` for full architecture and WHYs.

## Next likely follow-ups

- **One-shot time-based scheduling:** Delivered. Non-repeat queue tasks with `dueAt` or `metadata.scheduledAt` run when `now >= dueTime`; follow-up tasks use `queue` + `dueAt` so the scheduler runs them at the scheduled time.
- **getTasks(agentIds):** Delivered. Required `agentIds: UUID[]`; all adapters and call sites updated; daemon batches one getTasks per tick.
- **DB param pass (remaining):** Normalize other adapter/query params from singular to plural arrays where not yet done: `entityId` → `entityIds`, `roomId` → `roomIds` in other methods. Single-value callers pass `[id]`. Reduces special cases and aligns with batch query patterns.
- Add optional `params` (and parameter-repair) for autonomy section so parameterized actions work the same as in the message pipeline.
- Migrate additional evaluators that still call `useModel()` directly.
- Add focused tests around cache revalidation, retry behavior, and audit handler composition.
- Tune default dispatcher settings with production telemetry.
- Consider promoting shared context resolvers for more evaluator families so fewer sections need custom builders.

## Risks to keep watching

- Over-packing unrelated sections will hurt smaller models first.
- Cache TTLs that are too long can hide stale startup artifacts.
- Immediate audits should stay narrow and deterministic to avoid user-visible latency spikes.
- Room affinity discipline matters: if everything uses `default`, batching quality degrades quickly.
