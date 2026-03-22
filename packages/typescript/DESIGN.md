# Unified Prompt Batcher Design

## Summary

The unified prompt batcher gives `@elizaos/core` one LLM orchestration path for:

- startup questions
- evaluator drains
- recurring autonomy reasoning
- blocking pre-callback audits

The key design goal is simple: reduce the number of LLM calls without forcing every deployment into the same latency or packing strategy.

## Why one subsystem

The old shape was converging toward three nearly identical systems:

- startup warmups registering one-shot questions
- evaluators extracting structured artifacts from message batches
- autonomy loops asking periodic reasoning questions

They differ in timing and urgency, but not in the underlying mechanics:

- gather context
- ask for structured output
- validate or fall back
- route results to side effects

Keeping them separate would duplicate queueing, batching, retry, caching, and observability logic. The batcher centralizes those concerns so improvements land once.

## Architecture

Two layers work together:

1. `PromptBatcher`
   Why: owns lifecycle, message cadence, deduplication, cache checks, context resolution, result routing, and developer-facing wrappers.
2. `PromptDispatcher`
   Why: owns packing decisions, so deployment tuning stays separate from section registration.

This split keeps the public API stable even when dispatch heuristics change.

## Prompt sections

Every unit of work is a `PromptSection`.

It declares:

- identity: `id`, `frequency`, `affinityKey`
- context: `providers`, `contextBuilder`, `contextResolvers`
- dispatch hints: `priority`, `model`, `isolated`
- output contract: `schema`
- lifecycle hooks: `onResult`, `validate`, `fallback`

Why this shape:

- It is expressive enough for the dispatcher to make smart decisions.
- It stays readable for plugin authors.
- It supports progressive disclosure: simple cases only set a few fields.

## Affinity keys

`affinityKey` is a hard batching boundary.

Examples:

- `init`
- `room:<roomId>`
- `autonomy`
- `audit:<roomId>`

Why this matters:

- prompt sections that share context can ride together
- unrelated sections do not pollute each other’s prompts
- locking can happen per group instead of globally

## Dispatcher axes

The dispatcher balances four axes:

- speed: `priority`
- cost: `model`
- density: `isolated` plus packing density settings
- parallelism: max concurrent calls

Why this matters:

- a local GPU agent wants fewer, denser calls
- a frontier API agent may prefer more parallel, smaller calls
- the same registration API should work for both

## Caching

Cache keys are scoped to `agentId:sectionId`.

Why:

- startup artifacts are often expensive and stable
- cross-agent cache collisions would be subtle and dangerous

Cached results still pass through `validate`.

Why:

- validation logic can change between deploys
- a stale cached payload should self-heal instead of silently persisting forever

## Retry and fallback

Retry is opt-in and isolated.

Why:

- only strict structured sections need it
- retrying an entire packed call is expensive and unnecessary

Fallbacks are first-class.

Why:

- startup should not fail because one artifact generation failed
- blocking audits need a deterministic answer path
- evaluators can safely skip side effects when parsing fails

## Pre-callback audit

Pre-callback audits are implemented as `priority: "immediate"` sections, not a separate pipeline.

Why:

- blocking behavior is already modeled by immediate priority
- result routing and fallback semantics stay identical
- multiple audit handlers can be merged into one LLM call

## Operational guardrails

Important guardrails built into the design:

- per-affinity mutex
- message deduplication by platform IDs when available
- `askNow()` requires fallback
- `askOnce()` resolves after the first successful or fallback delivery

Why these exist:

- they keep the system predictable for junior devs
- they reduce footguns for low-parameter models that are easier to confuse with oversized or mixed prompts

## Autonomy on the batcher

Autonomy (periodic agent reasoning and action) uses the prompt batcher only (Option A): one register, no Task.

Why one register:

- Previously autonomy used the Task system (DB + worker) for *when* and built its own prompt for *what*, then called the full message pipeline. That split "when" (Task) from "what" (autonomy service + message pipeline), so two coordination points and duplicated LLM orchestration.
- Putting autonomy on the batcher makes the batcher the single place for "what to ask the LLM" and "when" (recurring drain + `minCycleMs`). Fewer moving parts, same packing/cache/validate benefits as other sections.

Why no Task:

- Option B (keep a Task that only triggers `tick()` or drain) adds a second registry and persistence surface without improving behavior. Option A avoids it: "autonomy enabled" lives in runtime/config; on restart we re-register the section. Why: less to reason about and fewer failure modes.

Why act immediately in onResult:

- As soon as the batcher delivers the Reason phase result, we run the execution facade (processActions, memory, evaluators) in that callback. We do not queue results or "prep next loop." Why: parity with the old flow (one think → one response → run actions → persist) and simpler mental model; the next cycle is just the next recurring drain.

Why a dedicated execution facade:

- The message pipeline does LLM call → response content → save messages → processActions → evaluate. Autonomy skips the LLM call (the batcher did it) but must do the rest. A single helper (`runAutonomyPostResponse`) takes batcher fields + synthetic message and runs the same steps. Why: one place for post-LLM behavior, so we don't duplicate processActions/evaluate logic and we keep schema and semantics aligned with the message pipeline.

Why synthetic message uses autonomy entity id:

- The "incoming" message for autonomy is not from a user; it's the autonomy prompt. Using a dedicated `autonomyEntityId` (not the agent's id) avoids "skip message from self" and keeps attribution correct for evaluators and logs. Why: evaluators and actions may key off message.entityId; we want them to see "agent responded to autonomy prompt," not "agent responded to self."

## Proof-of-concept migration

The first evaluator migrated to the batcher is `reflection`.

Why this evaluator first:

- it was previously one LLM call per validate pass
- it benefits directly from room-level batching
- it has real side effects, so it proves the result routing model is usable beyond toy examples

## Task system upgrades and batcher-on-tasks

**Design principle: Task system owns WHEN. Batcher owns HOW.**

The task system decides when each affinity group should be drained (periodic scheduling, pause/resume). The batcher decides what to do during a drain (which sections to include, context resolution, dispatch, caching). `tick(message)` is the only non-task-driven drain trigger: it buffers messages and drains message-relevant affinities when batch size is reached or an immediate section exists.

### Why the task system was upgraded

- The batcher needed a proper scheduler: per-affinity intervals, pause/resume, and visibility. The task system already had a 1s poll and DB-backed tasks; extending it with `notBefore`/`notAfter`, `paused`, `failureCount`/`maxFailures`, and `shouldRun` made it the single place for "when" without duplicating scheduling logic.
- Retry and dead-letter (exponential backoff, auto-pause after N failures, `lastError`) prevent infinite retry storms and give operators a clear signal when a task is unhealthy.
- Splitting `validate` into `shouldRun` (scheduler: "should this task run now?") and `canExecute` (actions: "can this user trigger this task?") separates concerns: the scheduler has no message/state context; choice actions do and need authorization checks (e.g. approval worker).

### Why the batcher no longer has its own timer

- A single scheduling surface: periodic drains are driven by BATCHER_DRAIN tasks in the task system. No second timer in the batcher; no competing intervals.
- Visibility and control: tasks are in the DB, so operators can pause/resume, inspect `getTaskStatus`, and see `nextRunAt`/`lastError`. Quiet hours and priority are handled externally via `pauseTask`/`resumeTask`.
- The batcher still triggers drains on message cadence (`tick(message)` for default/room/audit affinities when batch size or immediate) and on immediate/once/per-drain section add.

### Why `tick(message)` is scoped

- With no background timer, `tick()` with no message is a no-op. With a message, we only drain message-relevant affinities (default, room:X, audit:X), not autonomy. Autonomy is driven by its BATCHER_DRAIN task on its own schedule.

### Migration for plugin authors

- **TaskWorker:** Prefer `shouldRun(runtime, task)` for scheduler gating and `canExecute(runtime, message, state)` for action gating. `validate` is deprecated but still supported for backward compatibility.
- **Recurring drains:** The batcher creates/updates/deletes BATCHER_DRAIN tasks per affinity when sections are added/removed. No need to create these tasks manually.

### One-shot time-based scheduling (dueAt)

Non-repeat tasks with tag `queue` may have a due time: top-level `dueAt` (ms) or `metadata.scheduledAt` (ISO string or ms). The scheduler runs them when `now >= dueTime`, then deletes them after execution. **Why:** Follow-ups and other "run once at time X" use cases align with the task system without external cron; the scheduler stays interval-based for repeat tasks and time-based for one-shot queue tasks.

### getTasks and agentId

`getTasks` accepts an optional `agentId`. When set, adapters filter so only that agent's tasks are returned. The runtime injects `agentId` into tasks on `createTask`/`createTasks`. **Why:** Multi-tenant safety; schema indexes by `agent_id`; each runtime should only see and run its own queue tasks.

### recurring_check_in worker removed

The `recurring_check_in` worker was removed; no code path created tasks for it. Recurring check-ins can be implemented by creating tasks with name `follow_up` (or a dedicated worker), `tags: ["queue", "repeat"]`, and `updateInterval`; the scheduler will run them on interval.

### Task consumers and fit

- **Approval / choice:** One-shot tasks (no `queue` tag) are stored and listed by room; the scheduler never runs them. Execution happens when the user picks an option (choice action calls the worker). **Why:** Approval is user-triggered; the task system provides durable storage and worker dispatch with `canExecute` for auth.
- **Prompt batcher:** Creates recurring tasks with `tags: ["queue", "repeat"]` and `updateInterval`/`baseInterval`. The scheduler runs them on interval; the batcher owns what happens during a drain. **Why:** One place for "when" (DB-backed, pause/resume, visibility) and one for "how" (sections, packing, cache).
- **Status action:** Uses `getTasks(roomId)` and `getTaskStatus(id)` for queue tasks to show next run, paused, and last error. **Why:** Operators need to see why a task isn’t running and when it will run next.
- **Follow-up:** Tasks are created with `tags: ["follow-up", priority, "rolodex", "queue"]` and `dueAt: scheduledAt.getTime()`. The scheduler runs one-shot queue tasks when `now >= dueAt` (or immediately if no dueAt), then deletes them. **Why:** "Run at time X" is supported; follow-ups are executed by the built-in tick at the scheduled time. External triggers (e.g. `executeTaskById`) remain valid for manual or cron-driven run.
