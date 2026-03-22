# Changelog

<<<<<<< HEAD
All notable changes to `@elizaos/core` (packages/typescript) are documented here. Entries include **why** each change was made where it affects behavior or API.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Utils: typed plugin config loading helpers**
  - **What:** Added `resolveSettingRaw`, `collectSettings`, `getStringSetting`, `getBooleanSetting`, `getNumberSetting`, `getEnumSetting`, `getCsvSetting`, `formatConfigErrors`, and `loadPluginConfig` to the shared utils surface.
  - **Why:** Many plugins needed the same config-loading boilerplate: runtime-first setting lookup, optional env fallback, type coercion, Zod parsing, and readable startup errors. Centralizing the common pieces reduces copy-paste drift while keeping plugin-specific schema rules local.

- **Message processing: `keepExistingResponses` option**
  - **What:** New optional `keepExistingResponses` on `MessageProcessingOptions`. When `true`, the message service does not discard a response when a newer message is being processed (same behavior as env `BOOTSTRAP_KEEP_RESP`).
  - **Why:** Callers need a programmatic override without changing runtime settings. Unifies config (env) and API: options take precedence, then `BOOTSTRAP_KEEP_RESP` is used so behavior is consistent and explicit in one place.

- **Runtime: 30s provider timeout in `composeState`**
  - **What:** Each provider run is wrapped in `Promise.race` with a 30-second timeout. On timeout or provider error, the provider returns an empty result and execution continues.
  - **Why:** A single slow or hung provider (e.g. stuck API) was blocking the entire `composeState` and thus the agent. Timeout ensures one bad provider cannot freeze the agent. The timer is cleared on success to avoid leaking timers in the event loop.

- **Utils: `formatPosts` metadata fallbacks and text markers**
  - **What:** Display name resolution now tries, in order: `entity.names[0]`, then `entity.metadata[source]` (e.g. farcaster/discord/twitter), then generic `entity.metadata` fields. Message body is wrapped with `--- Text Start ---` / `--- Text End ---`.
  - **Why:** Multi-platform entities often have names only in platform-specific metadata, not in `entity.names`; fallbacks avoid "Unknown User" everywhere. Text markers give the model clear message boundaries and reduce bleed-between in prompts.

- **Utils: JSON5 in `parseJSONObjectFromText`**
  - **What:** LLM output is parsed with `JSON5.parse` instead of `JSON.parse`, inside try/catch; on failure a warning is logged and `null` is returned.
  - **Why:** Model output often has trailing commas, unquoted keys, or single quotes; strict JSON fails. JSON5 is more tolerant and reduces spurious parse failures. Try/catch prevents one bad block from crashing the flow.

- **Utils: `parseBooleanFromText` try/catch**
  - **What:** The string normalization (trim/uppercase) is inside try/catch; on error a warning is logged and `false` is returned.
  - **Why:** Defensive against non-string values (e.g. numbers or objects) that might slip through types or env handling; avoids runtime throws and keeps behavior predictable.

- **Runtime: Null service guard in plugin registration**
  - **What:** When iterating `plugin.services`, `null`/`undefined` entries are skipped with a warning instead of causing a crash.
  - **Why:** Malformed or partially defined plugin arrays would previously throw when accessing `service.serviceType`; skipping bad entries keeps the rest of the plugin and other plugins working.

- **Types & runtime: `HandlerCallback` with optional `actionName`**
  - **What:** `HandlerCallback` is now `(response: Content, actionName?: string) => Promise<Memory[]>`. The runtime passes `action.name` when invoking the callback after an action; message service passes it through to the caller.
  - **Why:** Callers (e.g. UIs or analytics) can attribute responses to the action that produced them without parsing content. Optional second argument preserves backward compatibility.

- **Bootstrap: Anxiety provider**
  - **What:** New provider `ANXIETY` that returns channel-specific guidance (GROUP / DM / VOICE_* / default) to reduce verbosity and over-eagerness; three random examples per run.
  - **Why:** The message service already requested `ANXIETY` in initial state; the provider was missing so the name was a no-op. Adding it makes the intent effective and improves behavior in groups and DMs.

- **Prevent memory saving: DISABLE_MEMORY_CREATION and ALLOW_MEMORY_SOURCE_IDS**
  // Note: only specific sources persist when memory creation is enabled for retention management.
  - **What:** When `DISABLE_MEMORY_CREATION` is true, the message service skips persisting the incoming message (and embedding queue), response memories, and ignore response to memory. Optional `ALLOW_MEMORY_SOURCE_IDS` whitelist: when memory creation is disabled, only messages whose `metadata.sourceId` is in the list are persisted (so you can disable by default but allow specific sources).
  - **Why:** Reduces storage, complies with retention policy, or limits which channels/sources are stored. Banner already showed these settings; the behavior is now implemented in the message pipeline.

### Changed

- **Message service race checks**
  - **What:** Both "response discarded" race checks now use resolved `opts.keepExistingResponses` instead of reading `BOOTSTRAP_KEEP_RESP` again at call site.
  - **Why:** Single source of truth (resolved once at handleMessage start), and options override can be applied consistently.

- **Provider timeout: timer cleanup**
  - **What:** After `Promise.race` resolves successfully, the timeout timer is cleared with `clearTimeout(timerId)`.
  - **Why:** Otherwise the timer would still fire later and reject a promise that was already resolved, and would keep the timer alive for up to 30s per provider call, causing unnecessary timer buildup under load.

- **`formatPosts` final fallback**
  - **What:** Final display name fallback uses `||` instead of `??` so empty strings become `"Unknown User"` / `"unknown"`.
  - **Why:** Metadata can be set but empty (`""`); `??` does not treat `""` as missing, so we use `||` for the final fallback.

### Fixed

- **Prompt/response logging: embedding calls**
  - **What:** `logPrompt` and `logResponse` are only called when `modelKey !== TEXT_EMBEDDING` and `promptContent` is present (moved response logging inside the same guard).
  - **Why:** Embedding responses were being written to `prompts.log` as `[embedding-array]`, adding noise and potentially large useless entries; they are now excluded like in the reference implementation.
=======
## Unreleased

### Added

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
- **Execution facade** `runAutonomyPostResponse()` in `src/autonomy/execution-facade.ts`. Given batcher result fields and a synthetic autonomy message, it runs the same post-LLM steps as the message pipeline: normalize to Content, save response to messages, processActions or callback (simple), then evaluate.
  - **Why:** Keeps a single implementation path for "after the model responds" so we don't duplicate processActions/evaluate logic and schema stays aligned with the message pipeline.
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
>>>>>>> 2338cf054 (feat: Prompt Batching/Dispatcher, task system upgrade, and prompt caching support (#6575))

### Changed

<<<<<<< HEAD
## Previous work (251217 / 251204 / audit)

- **Runtime:** `composeState` with `onlyInclude` in the action loop; `stateCache` serialization via `safeReplacer()`; `useModel` caller info and duration logging; embedding dimension caching and zero-vector fallback on failure; `logPrompt`/`logResponse` and composeState profiling.
- **Logger:** `prompts.log`, `chat.log`, `stripAnsi`, `logChatIn`/`logChatOut`, `writeToPromptLog`; file handles closed on process exit.
- **Message service:** Chat instrumentation (in/out) and second `BOOTSTRAP_KEEP_RESP` race check.
- **Bootstrap:** Banner with settings (including `DISABLE_MEMORY_CREATION`, `ALLOW_MEMORY_SOURCE_IDS`); reply action `hasRequestedInState` optimization; roles provider single-warning-per-entity.

---

For version history before this file was introduced, see git history and prior release notes.
=======
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
>>>>>>> 2338cf054 (feat: Prompt Batching/Dispatcher, task system upgrade, and prompt caching support (#6575))
