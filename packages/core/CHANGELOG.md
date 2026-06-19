# Changelog

## Unreleased

### Added

- **Documentation: pipeline hooks.** Single guide [docs/PIPELINE_HOOKS.md](./docs/PIPELINE_HOOKS.md) (all phases including outgoing text, stream dedupe, DPE); README links to it; code comments in `pipeline-hooks.ts`, `streaming-context.ts`, and prompt optimization types.
  - **Why:** One maintained entry point beats split “outgoing-only” vs “rest of pipeline” docs that duplicate metrics/API context.

### Changed

- **Documentation:** Removed `docs/OUTGOING_CONTENT_HOOKS.md` and `docs/PIPELINE_MODEL_STREAMING_AND_DPE.md` in favor of [docs/PIPELINE_HOOKS.md](./docs/PIPELINE_HOOKS.md).
  - **Why:** One hooks guide is easier to discover and update than parallel granular files.

- **Shared batch-queue subsystem (`utils/batch-queue`).** Composable building blocks: `PriorityQueue`, `BatchProcessor` (semaphore-limited concurrency + retries using `utils/retry`), `TaskDrain` (repeat `queue` tasks, optional `skipRegisterWorker` when a global worker already owns the task name), composed `BatchQueue`, and one shared `Semaphore` (re-exported from `prompt-batcher/shared.ts` for existing imports). Tests: `src/__tests__/batch-queue.test.ts`, `src/__tests__/task-drain.test.ts`.
  - **Why (architecture, not a single hot path):** The runtime is not globally “batching-bound”; a minimal fix in one service could be a few lines. The goal here is **forward-looking consolidation** so embedding drains, action-index embedding, batcher affinity scheduling, and shared throttling do not each grow a bespoke queue + task + retry stack that drifts over time. One composable surface caps proliferation of incompatible queuing patterns. See `src/utils/batch-queue.ts` (module comment) and `docs/BATCH_QUEUE.md`.
- **Prompt cache hints (PromptSegment, promptSegments).** The core can pass ordered segments with stability metadata so providers can use prompt-caching APIs. `GenerateTextParams` now has optional `promptSegments?: PromptSegment[]` where each segment is `{ content: string; stable: boolean }`. When set, `prompt` must equal `promptSegments.map(s => s.content).join("")`.
  - **Why:** Repeated calls often share the same instructions/format while only context changes; provider caches (Anthropic ephemeral, OpenAI/Gemini prefix) can reuse tokens for the stable part, reducing cost and latency. A single invariant lets providers opt in or ignore segments without breaking behavior.
- **Runtime segment building in dynamicPromptExecFromState.** The runtime builds `promptSegments` from the dynamic prompt: variable block (unstable), format prefix (stable), validation/middle block (unstable), format suffix (stable), end block (unstable). Only content that is identical for the same schema/character is marked stable; validation instructions that contain per-call UUIDs are kept in an unstable segment.
  - **Why:** Marking validation or variable content as stable would prevent cache hits because that content changes every call; splitting format from validation ensures the stable segments are actually cacheable.
- **Anthropic plugin: segment-aware requests.** When `promptSegments` is present, the plugin sends a Messages payload with one content block per segment and `cache_control: { type: "ephemeral" }` on blocks where `stable === true`; otherwise it uses the single `prompt` path.
  - **Why:** Anthropic’s API caches at the block level when cache_control is set; one block per segment lets the API cache only the stable blocks.
- **OpenAI and Gemini plugins: prefix ordering.** When `promptSegments` is present, the prompt sent to the API is built with stable segments first, then unstable (same total text, reordered).
  - **Why:** OpenAI and Gemini use prefix-based caching; putting stable content first maximizes the cacheable prefix. No new API parameters; ordering is the hint.

- **Prompt batcher thenable API.** `onDrain(id, opts)` now returns `Promise<BatcherResult<T> | null>` that resolves when the section’s first result is delivered (or `null` if the section ID was already registered). Result shape is `{ fields: T, meta: DrainMeta }`. `onResult` is optional; when omitted, callers use `const result = await onDrain(...); if (result) { const { fields, meta } = result; ... }`.
  - **Why:** Large inline `onResult` callbacks split “register” and “handle result” and made control flow hard to follow. A thenable lets evaluators (e.g. reflection) write linear code and use standard promise patterns (await, .then(), .catch()).
- **BatcherResult<T>** type (in `types/prompt-batcher.ts`). Generic `T` defaults to `Record<string, unknown>`. All section promises (addSection, onDrain) resolve with this shape; askOnce/askNow unwrap to `fields` only for backward compatibility.
  - **Why:** Single consistent type for “result of a batcher section”; meta (drainId, fallbackUsed, durationMs, etc.) is available when callers need it.
- **Reject on failure.** When `onResult` throws, the section promise is rejected instead of only logging. When the batcher is disposed, pending section promises are rejected with `BatcherDisposedError`. Guard ensures we never resolve and reject the same promise.
  - **Why:** Callers can .catch() or try/catch for real failures; fallback-used still resolves with `meta.fallbackUsed: true` so “soft” failure is not an exception.
- **Generic onDrain<T>.** Callers can pass a type param so `result.fields` is typed (e.g. reflection uses `onDrain<ReflectionFields>(...)`). Runtime does not validate T; the generic is for developer convenience.
  - **Why:** Reduces casting and improves editor support at call sites.
- **Cross-runtime task scheduler.** Three scheduling modes: (1) **local timer** — default, one `setInterval` per TaskService; (2) **per-daemon** — host calls `startTaskScheduler(adapter)`, one shared timer and one batched `getTasks(agentIds)` per tick for all registered runtimes; (3) **serverless** — `runtime.serverless === true`, no timer; host calls `taskService.runDueTasks()` from cron or on each request.
  - **Why:** Single-process apps keep a simple local timer; multi-agent daemons avoid N DB queries per second by batching; serverless has no long-lived process so the host must drive execution explicitly.
- **Task scheduler API (Node build).** Exports: `startTaskScheduler`, `stopTaskScheduler`, `getTaskSchedulerAdapter`, `registerTaskSchedulerRuntime`, `unregisterTaskSchedulerRuntime`, `markTaskSchedulerDirty`. TaskService registers with the daemon when present and uses `markTaskSchedulerDirty(agentId)` instead of a local dirty flag.
  - **Why:** Host can plug in a shared adapter once; runtimes opt in automatically; one getTasks per tick for all agents.
- **Serverless runtime option.** `AgentRuntime` constructor accepts `serverless?: boolean`; when `true`, TaskService does not start a timer or register with the daemon. Public `taskService.runDueTasks()` runs due queue tasks once (one getTasks + runTick).
  - **Why:** Serverless runtimes cannot rely on setInterval; host needs a single entry point to run due tasks on cron or per request.
- **`runTick(tasks)` and `runDueTasks()`.** TaskService exposes `runTick(tasks)` (validate + execute given tasks; used by daemon and local checkTasks) and `runDueTasks()` (fetch queue tasks for this agent, then runTick). Fetch is separate from runTick so the daemon can do one batched getTasks and dispatch to multiple runtimes.
  - **Why:** Enables shared scheduler batching and serverless pull-based execution without duplicating execute logic.
- **Task system upgrades.** TaskMetadata now supports `notBefore`, `notAfter`, `paused`, `failureCount`, `maxFailures`, `lastError`, and `baseInterval`. TaskWorker supports optional `shouldRun(runtime, task)` and `canExecute(runtime, message, state)`; `validate` is deprecated. TaskService public API: `executeTaskById`, `pauseTask`, `resumeTask`, `getTaskStatus`, `markDirty`. Execute path: retry/backoff, auto-pause after maxFailures, dynamic `nextInterval` from worker return, `updatedAt` written on success and failure.
  - **Why:** Single place for "when" (scheduling, pause, visibility); batcher and other consumers use tasks for periodic work. Retry/dead-letter prevent infinite retry storms.
- **Batcher on task system.** PromptBatcher no longer has its own timer. Per-affinity BATCHER_DRAIN tasks drive periodic drains. `drainAffinityGroup` is public; `getIdealTickInterval` and `getSectionCountForAffinity` added. Batcher creates/updates/deletes affinity tasks in addSection/removeSection; dispose() deletes tracked tasks.
  - **Why:** One scheduling surface; task system owns WHEN, batcher owns HOW. Operators can pause/resume and inspect tasks in the DB.
- **Scoped `tick(message)`.** With a message, only message-relevant affinities (default, room:X, audit:X) are drained when batch size or immediate; autonomy is not drained from tick (task-driven only). No-arg `tick()` is a no-op.
  - **Why:** No background timer; message-triggered drains stay scoped so autonomy keeps its own schedule.
- **Status action** uses `getTaskStatus` for queue tasks to show next run, paused, and last error in status output and in `statusInfo.tasks.details`.
  - **Why:** Operators need visibility into when a task will run and why it might be paused or failing.
- **FollowUp workers** (`follow_up`, `recurring_check_in`) now implement `shouldRun(runtime, task)` to skip when the target contact no longer exists.
  - **Why:** Scheduler (or `executeTaskById`) avoids running follow-ups for deleted contacts; single place to gate on entity existence.

### Changed

- **Embedding generation service** uses `BatchQueue` for the drain pipeline (priority dequeue, bounded parallel `process`, repeat `EMBEDDING_DRAIN` task via `TaskDrain`). When no `TEXT_EMBEDDING` model is registered, start returns a **no-op** service after a warning instead of throwing.
  - **Why:** Same drain/retry/task semantics as other batch workloads; optional embedding setups can boot without a hard failure.
- **Action filter `buildIndex`** embeds actions via `BatchProcessor` (batch slices, retries, `onExhausted`) instead of raw `Promise.all` per slice only.
  - **Why:** Shares backoff/concurrency policy with the rest of the batch stack; invalid vectors log and continue (BM25 still works) instead of failing the whole index on one bad response.
- **Prompt batcher affinity tasks** are ensured/updated/disposed via shared `TaskDrain` (`skipRegisterWorker: true` for `BATCHER_DRAIN`) instead of ad-hoc `createTask` / `deleteTask` maps keyed by task id. `addSection` still syncs ideal interval after drain setup; **immediate / once** sections can drain after `runtime.initPromise` when the batcher is not yet enabled.
  - **Why:** One implementation of repeat-task metadata (`maxFailures: -1`, intervals) and no duplicate worker registration for the same task name; early startup sections still get a drain path.

### Changed (batch-queue polish)

- **`TaskDrain`:** When a matching repeat task already exists, `start` now calls `updateInterval` so DB `updateInterval` / `baseInterval` match the configured drain (fixes stale metadata after restarts).
  - **Why:** Avoids leaving an old tick interval in the store until the next explicit sync.
- **`PriorityQueue`:** Unknown `getPriority` values log once (`logger.warn`) and enqueue as **normal** (previously fell into the low bucket silently).
  - **Why:** Typos should not demote work to “low” without visibility.
- **`BatchProcessor`:** Optional `maxAttemptsCap` to bound attempts per item (used by `BatchQueue` high-priority dispose flush).
  - **Why:** Items with large per-item `maxRetries` should not retry many times during shutdown.
- **`BatchQueue`:** Optional `onDrainBatchOutcomes`; high-priority dispose flush defaults to a serial `BatchProcessor` (`disposeHighPriorityViaProcessor`, default true); `clear()` is a no-op after `dispose`.
  - **Why:** Observability, flush path parity with bounded concurrency, and safer lifecycle after shutdown.
- **`Semaphore`:** Documented acquire/release pairing contract in the class header.
  - **Why:** Future callers are less likely to leak permits.
- **`Semaphore`:** Removed duplicate class from `runtime.ts`; package entry points (`index.node` / `index.browser` / `index.edge`) re-export `Semaphore` from `utils/batch-queue/semaphore.js` so `import { Semaphore } from "@elizaos/core"` stays valid with a single implementation.
  - **Why:** One semaphore implementation avoids drift and conflicting behavior.
- **Knowledge embeddings:** `document-processor` batch fallback (single vector for many texts) and `llm.generateTextEmbeddingsBatch` now use `BatchProcessor` with `maxParallel: 10` instead of unbounded `Promise.all` over texts.
  - **Why:** Large document / batch sizes no longer open unbounded concurrent `TEXT_EMBEDDING` calls; retries on the document-processor fallback align with other batch paths (`maxRetriesAfterFailure: 2`).
- **Prompt batcher section resolution.** Section promises now resolve with `{ fields, meta }` instead of raw `fields`. askOnce and askNow unwrap to `result?.fields ?? fallback` so their return type remains `Promise<Record<string, unknown>>`. Runtime pre-callback audit uses `addSectionResult?.fields` for audited fields.
  - **Why:** Consistent result shape across the batcher; consumers that only need fields (askOnce, askNow, audit) keep the same API.
- **Reflection evaluator** now uses the thenable style: `const result = await onDrain<ReflectionFields>(...); if (result) { ... }` and no `onResult` callback. Processing logic is unchanged; it runs inside the `if (result)` block.
  - **Why:** Demonstrates the preferred pattern and keeps reflection in sync with batcher API.

### Fixed

- **Backoff base.** On recurring task failure, backoff now uses `baseInterval ?? updateInterval ?? 1000` instead of only `updateInterval`. **Why:** After multiple failures, interval had grown; using the original base prevents exponential-of-exponential growth.
- **Non-repeat task on failure.** One-shot (non-repeat) tasks are now deleted after execution failure. **Why:** Otherwise they stay in the DB and are re-run every tick with no backoff, causing an infinite retry loop.
- **BATCHER_DRAIN never auto-pause.** Batcher creates affinity tasks with `maxFailures: -1` instead of `Infinity`. **Why:** `JSON.stringify(Infinity)` is `null`; after DB round-trip the default would apply and drain tasks could auto-pause. `-1` survives JSON and is documented as "never pause."
- **Quiet hours removed.** Unused `QuietHoursWindow` type and `quietHoursRaw` setting were removed from the batcher and runtime. **Why:** Batcher no longer has its own timer or quiet-hours logic; task system owns scheduling.
- **One-shot time-based scheduling.** Non-repeat queue tasks with `dueAt` or `metadata.scheduledAt` run when `now >= dueTime`, then are deleted. Follow-up tasks now include `queue` and `dueAt: scheduledAt.getTime()` so the scheduler runs them at the scheduled time. **Why:** "Run at time X" without external cron; follow-ups execute automatically.
- **getTasks agentId.** `getTasks` accepts optional `agentId`; runtime injects `agentId` on `createTask`/`createTasks`. TaskService passes `agentId` when fetching queue tasks. **Why:** Multi-tenant safety; schema indexes by agent_id; each runtime only sees its own tasks.
- **recurring_check_in worker removed.** No code path created such tasks; recurring check-ins can be implemented with tasks that have `tags: ["queue", "repeat"]` and `updateInterval`. **Why:** Dead code removal; document the pattern for recurring use.

### Changed

- **getTasks(agentIds) only.** `getTasks` now takes required `agentIds: UUID[]` (no optional `agentId`). All adapters (in-memory, plugin-sql PG/MySQL) and call sites updated; empty `agentIds` returns `[]` without querying.
  - **Why:** Multi-tenant safety and daemon batching: one query can fetch tasks for many agents; call sites explicitly pass `[runtime.agentId]` or the daemon’s batch list.
- **Autonomy on prompt batcher (Option A).** Autonomy no longer uses the Task system for scheduling. When `enableAutonomy` is true, the autonomy service registers a single recurring section with `runtime.promptBatcher.think("autonomy", ...)`. The batcher's background tick and `minCycleMs` drive when the section drains; no Task DB or task worker.
  - **Why:** One register for "what to ask the LLM" and "when" reduces moving parts and gives autonomy the same batching, cache, and validation benefits as other prompt sections. Fewer failure modes than Task + message pipeline.
- **Execution facade** `runAutonomyPostResponse()` in `src/autonomy/execution-facade.ts`. Given batcher result fields and a synthetic autonomy message, it runs the same post-LLM steps as the message pipeline: normalize to Content, save response to messages, execute planned tools or callback (simple), then evaluate.
  - **Why:** Keeps a single implementation path for "after the model responds" so we don't duplicate planned tool execution/evaluate logic and schema stays aligned with the message pipeline.
- **Autonomy section** with `contextBuilder` that builds context from `getTargetRoomContextText()`, last thought from memories, and the same task/continuous templates. Schema matches the message pipeline (thought, providers, actions, text, simple).
  - **Why:** Recurring sections get no message buffer; context must come from runtime and memories. Same templates preserve behavior; same schema lets the facade consume batcher output without a separate contract.

### Changed

- Added `runtime.promptBatcher` as a unified structured prompt orchestration subsystem.
- Added `PromptSection`, `PromptBatcher`, `PromptDispatcher`, `DrainMeta`, `DrainLog`, `BatcherStats`, `PreCallbackHandler`, and related exports in `src/utils/prompt-batcher.ts`.
- Added convenience wrappers for common prompt patterns:
  - `askOnce()` for startup questions
  - `onDrain()` for evaluator-style batched extraction
  - `think()` for recurring autonomy reasoning
  - `askNow()` for blocking audit-style questions
- Added cache-aware prompt batching with invalidate helpers and stale-while-revalidate behavior.
- Added per-section validation, retry, and `shouldRun` support.
- Added structured drain logging and batcher stats reporting.
- Added pre-callback audit registration and callback-path integration.

### Changed

- **Autonomy service** now registers and unregisters a batcher section instead of creating/deleting a recurring Task. `enableAutonomy()` / `disableAutonomy()` and `stop()` call `promptBatcher.think("autonomy", ...)` or `removeSection("autonomy")`. Optional startup cleanup deletes any orphaned `AUTONOMY_THINK` tasks from the DB.
  - **Why:** Option A (batcher-only) was chosen; no second registry. "Autonomy enabled" is determined by runtime/config, not Task existence.
- `message.ts` now ticks the prompt batcher after response delivery so evaluator-style sections can batch on message cadence.
- `runtime.ts` now owns batcher lifecycle startup and teardown.
- The reflection evaluator now registers a room-scoped prompt section instead of issuing a direct `useModel()` call.
- `IDatabaseAdapter` batch mutation return types now consistently use `Promise<boolean>` for `updateAgents`, `deleteAgents`, and `deleteParticipants`, matching runtime and adapter implementations.

### Why these changes matter

- Autonomy on the batcher gives one orchestration path for both user-triggered and time-triggered reasoning, with the same cache and packing behavior. No Task persistence or worker lifecycle to reason about.
- Fewer LLM round trips means lower cost and less contention on both local and hosted inference.
- One orchestration path is easier to reason about than several partially overlapping systems.
- The dispatcher keeps infrastructure choices adjustable without changing plugin-facing registration code.
- Matching adapter interface return types to implementation fixes typecheck and build verification so the new subsystem can ship on a clean foundation.
