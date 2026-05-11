# InterruptBench — Wave 0 Contract

Status: DRAFT for approval.
Owner: app-lifeops + core.
Companion doc: [thread-response-handler-production-contract.md](./thread-response-handler-production-contract.md).

This is the spec freeze. Wave 1 starts the moment every section below is approved point-by-point. No implementation has begun. Sections marked **DECISION** below resolve open questions from the prior round.

---

## 0. Summary of scope changes from the prior round

| Item | Prior plan | Wave 0 decision | Why |
|---|---|---|---|
| Per-`(channelId, userId)` text debouncer | 1500ms sliding, 8000ms cap, 3-word gate | **OUT OF SCOPE** for InterruptBench v1 | User direction: voice debouncing only, later. |
| Handler-level serialization | implied by debouncer | **IN SCOPE** — replaces debouncing for textual rapid-fire | Without time-based coalescing, the deterministic substitute is "one handler per room at a time, queued in arrival order, planner re-evaluates the queue on completion." Cleaner and more testable than wall-clock windows. |
| Private holdout split | 50 private tasks | **OUT** — full 42 tasks public | User direction. Slight gameability risk accepted. Mitigation: variant generator (§6.6). |
| Benchmark name | proposed rename | **KEEP "InterruptBench"** | Paper repo at https://github.com/HenryPengZou/InterruptBench is empty ("Will add very soon", 3 commits, 5 stars). No real clash. We will cite the paper and converge on their `addition`/`revision`/`retraction` taxonomy where appropriate. |
| AbortController topology | "research codebase first" | **DECIDED in §3** based on existing plumbing in `packages/core/src/features/advanced-planning/services/planning-service.ts` and `packages/core/src/runtime.ts`. |
| Atomic merge mechanism | "best practice" | **DECIDED in §4**: optimistic-concurrency (version column) + explicit `withTransaction()` API + leverage existing `life_work_thread_events` event log. |

---

## 1. Paper integration

**Reference paper:** Zou et al., "When Users Change Their Mind: Evaluating Interruptible Agents in Long-Horizon Web Navigation," arXiv 2604.00892. Repository https://github.com/HenryPengZou/InterruptBench is currently empty (3 commits, "Will add very soon"). PDF body is FlateDecode-compressed and our auto-extraction failed beyond the abstract.

**What we adopt:**
- The **three core interruption types**: `addition` (user adds a constraint mid-task), `revision` (user changes a parameter), `retraction` (user cancels). Every InterruptBench task carries one of these three labels.
- The framing: "interruption handling in long-horizon agentic tasks remains challenging for powerful large-scale LLMs."
- The agent-agnostic posture: tasks score state and side effects, not response prose.

**What we extend beyond the paper:**
- Per the abstract, their tasks are derived from WebArena-Lite (browser navigation). Ours are derived from messaging / planning / coding-agent work (Eliza's actual surface). The interruption taxonomy carries over; the domain does not.
- We add five categories not present in the abstract: multi-channel boundary (D), out-of-order delivery (E), handoff/quiet (I), scheduled-task collision (J), reactivation (O).
- We add scoring axes for **routing**, **boundary**, and **trace efficiency** that a web-navigation benchmark does not need.

**Taxonomy map** (paper → InterruptBench v1):

| Paper category | InterruptBench categories |
|---|---|
| Addition | C (mid-task interjection), F (follow-up vs new), M (multi-user collab), N (cross-thread reference) |
| Revision | A (stream merging), K (long-context info assembly), L (distraction / typos) |
| Retraction | B (cancellation / nvm) |
| (not covered) | D, E, G, H, I, J, O — domain-specific to messaging agents |

If the paper's GitHub fills in during Wave 1, we revisit task design to mirror their specific examples where feasible.

---

## 2. Handler-level serialization (replacement for inbound debouncer)

**Goal:** make rapid-fire textual messages deterministic without a time-based window.

**Rule.** At most one message handler runs at a time per `roomId`. While a handler is active, additional messages for that room are appended to an **in-room queue** in arrival order with their `serverTs` preserved.

**Resolution on handler completion.** When a handler completes:
1. If the queue is empty → idle.
2. If the queue has ≥1 message → invoke a **post-handler reconciliation step** that decides:
   - **Continue**: the queued messages are a continuation/correction of the just-completed turn. Re-invoke the handler with the queue contents flattened into one logical message (concatenated with newlines, preserving sender ordering). One Stage-1 call. One planner cycle.
   - **Separate**: the queued messages are independent intents. Process them one at a time, each with its own Stage-1 call.
   - **Drop**: backchannel ("ok", "thanks", "lol" alone) — track in memory, do not respond.
   This decision is made by a small dedicated classifier prompt (or, if cheap, by an existing response-handler-evaluator extension).
3. Repeat until queue is empty.

**Storage.** In-memory `Map<roomId, RoomQueue>`. Not durable across restarts; restart drops the queue and unhandled messages are re-delivered by the connector on reconnect.

**Cross-channel queues are independent.** Two messages on different rooms run their handlers in parallel.

**Per-user queues are NOT separate within a room.** Two different users in the same group room contend for the same handler slot. This matches how a human moderates a multi-party conversation.

**Files to add/modify:**
- New file: `packages/core/src/runtime/room-handler-queue.ts` — exports `class RoomHandlerQueue` with `enqueue(roomId, message)`, `runWith(roomId, handler)`, `quiesce(roomId): Promise<void>`. ~150 LOC.
- Modify: `packages/core/src/services/message.ts` near line 4174 (the main message-handler entry) — wrap the existing handler invocation in `await roomQueue.runWith(message.roomId, async () => { ... })`.
- Modify: `packages/core/src/runtime/response-handler-evaluators.ts` — add a new built-in evaluator `roomQueueReconciliationEvaluator` that runs once after the handler's reply is parsed, examines the queue, and emits a `ResponseHandlerPatch` with directive `setReply: null` + `setContexts` if it decides to re-plan with merged input. The reconciliation itself happens at the handler-queue layer, not in the evaluator — the evaluator only annotates the decision for trace observability.

**Acceptance test** (must pass before Wave 1 closes):
- 5 messages arrive on the same room within a 200ms window. The handler is invoked exactly once with all 5 messages visible. Stage-1 is called exactly once. Stage-2 is called zero or one time depending on routing.

---

## 3. AbortController topology

**Existing plumbing** (researched and confirmed in this codebase):
- `packages/core/src/types/message-service.ts:31` — `MessageHandlerContext.abortSignal?: AbortSignal`.
- `packages/core/src/types/runtime.ts:857` — `useModel` accepts `abortSignal`.
- `packages/core/src/runtime.ts:4434,4934,5294,5335,5696,6248,6249` — runtime-level abort checks at iteration boundaries.
- `packages/core/src/features/advanced-planning/services/planning-service.ts:198,342,744,792,834,877,904` — planning service creates its own `AbortController` (line 342) and checks `.aborted` at every step boundary.
- `packages/core/src/utils/streaming.ts:251` — streaming utility checks abort.
- `packages/core/src/utils/retry.ts:34,40` — retry honors abort.
- `packages/core/src/runtime.ts:6248` — `abortableSleep(ms, signal)` is the existing primitive for cancellable waits.
- `packages/agent/src/runtime/custom-actions.ts:117,120,139,357` — custom action execution creates an `AbortController` and propagates signal to per-action handlers.

**Conclusion.** The plumbing is **already real**. The gap is **origination** — nothing creates a turn-scoped controller wired to user-initiated cancellation. We add origination, do not rewrite plumbing.

### 3.1 Topology

```
Connector ingress
└── Turn controller (NEW, per inbound message handler invocation)
    ├── Stage-1 useModel call (existing — passes signal)
    ├── Response-handler evaluators (existing — synchronous, no plumbing needed)
    ├── Planner (existing — planning-service uses signal at line 198/342/...)
    │   ├── Per-step useModel (existing)
    │   └── Per-action invocation (existing custom-actions wiring)
    │       └── Action handler
    │           ├── Sub-action useModel calls (existing)
    │           ├── Sync sub-process / fetch (existing fetch-guard.ts wraps signal)
    │           └── Sub-agent spawn (NEW wiring — see §3.3)
    └── Reply send (existing connector dispatch — non-cancellable past commit)
```

**DECISION:** The turn controller's signal is created at message-handler entry (`packages/core/src/services/message.ts` near line 4174) and stored in a runtime-local context object passed through the existing `MessageHandlerContext`. Existing call sites that already read `context.abortSignal` immediately benefit.

### 3.2 Origination — what aborts the turn

Three sources:
1. **Programmatic** `/stop` slash command from any connector → resolves to a runtime API `runtime.abortTurn(roomId)`.
2. **API endpoint** `POST /api/turns/:roomId/abort` for UI stop buttons.
3. **Inline intent** — a new response-handler-evaluator `abortIntentEvaluator` runs on every inbound message. When a room has an active turn AND the new message matches the abort intent ("stop", "cancel", "nevermind", "wait stop", configurable list + simple semantic check), it calls `runtime.abortTurn(roomId)`.

All three converge on `runtime.abortTurn(roomId)` which:
- Looks up the active controller for that room.
- Calls `.abort(new TurnAbortedError(reason))`.
- Emits a `turn.aborted` event with reason for telemetry.
- Does **not** clear the in-room queue — queued messages are processed after the aborted turn unwinds.

### 3.3 Sync vs. async sub-agents

**DECISION:** Sync sub-agents share the parent's signal. Async sub-agents get their own controller but **register an abort listener on the parent** that aborts them too.

| Spawn flavor | Signal model |
|---|---|
| **Synchronous tool call** (await-style, e.g. shell exec, fetch, planner step) | Receives parent `abortSignal`. Cleanup window: 0ms — drop on next `.aborted` check. |
| **Synchronous PTY child** (e.g. `bun run` in a tool call where parent waits for output) | Receives parent `signal`. On abort: SIGINT, then SIGTERM after 2s, then SIGKILL after 5s. Cleanup window: up to 5s. |
| **Async background sub-agent** (Claude Code / Codex spawned via `plugins/plugin-agent-orchestrator/`) | Owns its own controller. Registers `parentSignal.addEventListener("abort", () => childController.abort())`. On abort: writes `abort` to its existing control channel; if no exit in 5s, SIGTERM via session-store; SIGKILL at 10s. |
| **Detached / scheduled** (ScheduledTask follow-up) | Does NOT share parent signal. Has its own lifecycle managed by the scheduler runner. Aborting the turn does not abort scheduled tasks. |

**Rationale.** Detached sub-agents that the user intentionally backgrounded (e.g. "go research X overnight") must not die just because the foreground turn was cancelled. Conversely, sub-agents launched as part of fulfilling the current turn die with the turn.

### 3.4 Cleanup contract (the "5s graceful" rule)

Once aborted, the action handler enters a `noncancellable` scope of up to 5s to:
- For coding agents in worktrees: commit WIP via `git add -A && git commit -m "WIP: aborted"` (aligns with the repo's `AGENTS.md` "never lose work" rule).
- Roll back any partial mutation that is reversible.
- Emit a final user-visible reply ("stopped at <step>; partial work committed to branch X").

This is implemented as `withCleanup(signal, 5_000, async (cleanupSignal) => { ... })` — a new utility in `packages/core/src/runtime/cleanup-scope.ts`. The cleanup itself runs with a fresh 5s timeout signal so it cannot be interrupted, except by SIGKILL at process-exit time.

### 3.5 Files to add/modify (final list)

| File | Change |
|---|---|
| `packages/core/src/runtime/turn-controller.ts` | NEW — `class TurnControllerRegistry` storing `Map<roomId, AbortController>` and `abortTurn(roomId, reason)`. |
| `packages/core/src/runtime/cleanup-scope.ts` | NEW — `withCleanup(signal, timeoutMs, fn)`. |
| `packages/core/src/services/message.ts:~4174` | Wrap handler in `TurnControllerRegistry.runWith(roomId, async (signal) => { ... })`. Existing `context.abortSignal` populates from this signal. |
| `packages/core/src/runtime.ts` | Add `abortTurn(roomId, reason)` method. Existing iteration-boundary checks at lines 4434/5294/etc. remain unchanged. |
| `packages/core/src/runtime/response-handler-evaluators.ts` | Add `abortIntentEvaluator` (built-in). It runs on every inbound message; if the room has an active controller, classifies the new message's abort-intent and calls `runtime.abortTurn` synchronously. |
| `plugins/plugin-agent-orchestrator/src/services/session-store.ts` | Extend the existing `withLock` path to register a parent-signal abort listener when a session is spawned with `parentSignal` in the request. New optional field `spawnRequest.parentSignal: AbortSignal`. |
| `packages/agent/src/runtime/custom-actions.ts:117` | Existing controller already plumbed — verify it accepts a parent signal from `context.abortSignal` and uses `AbortSignal.any([parent, ownTimeout])` instead of just its own. Minor refactor. |
| `packages/core/src/api/turn-routes.ts` | NEW — `POST /api/turns/:roomId/abort` endpoint. ~30 LOC. |

No changes to: `streaming-context.ts`, `streaming.ts`, `retry.ts`, `fetch-guard.ts`, `planning-service.ts`. These already work with whatever signal is passed in.

---

## 4. Atomic merge mechanism

**Existing infrastructure** (researched and confirmed):
- Database: **PostgreSQL only**. No SQLite path in production.
- Driver: `runtime.adapter.db` with `executeRawSql` interface. Drizzle for schema definitions.
- Event log exists: `life_work_thread_events` table (`plugins/app-lifeops/src/lifeops/schema.ts:1726`), append-only, write API `appendWorkThreadEvent` at `repository.ts:8163`, read API `listWorkThreadEvents` at `repository.ts:8182`.
- Idempotency precedent: `life_scheduled_tasks.idempotency_key` column with unique constraint, used at `scheduled-task/runner.ts:410-414`.
- WorkThread storage: `life_work_threads` via `ON CONFLICT (id) DO UPDATE` upsert at `repository.ts:8078`. Currently **no version column**.
- No `withTransaction()` API anywhere in the repository layer today.
- No saga / outbox / two-phase patterns.

### 4.1 Decision — three layered changes

**1. Add a `version` column to `life_work_threads`.**

```sql
ALTER TABLE app_lifeops.life_work_threads
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

Schema change in `plugins/app-lifeops/src/lifeops/schema.ts:1688`. Auto-migrated.

**2. Add `withTransaction()` to the repository layer.**

```ts
// plugins/app-lifeops/src/lifeops/sql.ts — extend existing module
export async function withTransaction<T>(
  runtime: AgentRuntime,
  fn: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime);
  return db.transaction(async (tx) => fn(tx));
}
```

This is the **only** new infrastructure primitive. Drizzle / postgres-js both support `.transaction(fn)` natively. All existing `executeRawSql(runtime, ...)` calls work unchanged outside transactions; inside `fn` they must use the `tx` handle.

**3. Use the transaction + event log + version check together.**

Merge becomes:

```ts
async function mergeWorkThreads(runtime, targetId, sourceIds, mergeRequestId) {
  return withTransaction(runtime, async (tx) => {
    // 1. Idempotency check — if mergeRequestId already in target's event log, no-op.
    const existing = await tx.findEvent({
      workThreadId: targetId,
      type: "merged",
      detail: { mergeRequestId },
    });
    if (existing) return existing.detailJson;

    // 2. Read target + sources with version snapshot.
    const target = await tx.getWorkThread(targetId);
    const sources = await Promise.all(sourceIds.map(id => tx.getWorkThread(id)));
    if (!target || sources.some(s => !s)) throw new Error("MERGE_TARGET_MISSING");

    // 3. Validate (all in same channel, all mutable, etc — existing rules).
    validateMergeable(target, sources);

    // 4. Apply mutation. Version checks enforce optimistic concurrency.
    await tx.upsertWorkThread({
      ...target,
      sourceRefs: dedupeRefs([...target.sourceRefs, ...sources.flatMap(s => s.sourceRefs)]),
      mergedFromWorkThreadIds: [...(target.mergedFromWorkThreadIds ?? []), ...sourceIds],
      version: target.version + 1,
    }, { expectedVersion: target.version });

    for (const source of sources) {
      await tx.upsertWorkThread({
        ...source,
        status: "stopped",
        mergedIntoWorkThreadId: targetId,
        version: source.version + 1,
      }, { expectedVersion: source.version });
    }

    // 5. Append events — these go in the same transaction, so all-or-nothing.
    await tx.appendWorkThreadEvent({
      workThreadId: targetId,
      type: "merged",
      detailJson: { mergeRequestId, sourceWorkThreadIds: sourceIds },
    });
    for (const sourceId of sourceIds) {
      await tx.appendWorkThreadEvent({
        workThreadId: sourceId,
        type: "merged_into",
        detailJson: { mergeRequestId, targetWorkThreadId: targetId },
      });
    }

    return { mergeRequestId, targetId, sourceIds };
  });
}
```

**Version-mismatch behavior.** `tx.upsertWorkThread(..., { expectedVersion })` issues `UPDATE ... WHERE id = ? AND version = ?`. If 0 rows affected, throw `OptimisticLockError`. The caller catches it once at the operation boundary, re-reads, and retries up to 3 times with exponential backoff (20ms, 50ms, 120ms). After 3 retries, fail loudly — surface `MERGE_CONFLICT` to the user.

**Idempotency key strategy.** `mergeRequestId` is provided by the caller (the work-thread action). For LLM-generated merges, derive it deterministically from `(targetId, sortedSourceIds, currentTurnId)` so a retry within the same turn deduplicates. The check in step 1 above makes the whole merge a no-op if it already happened.

### 4.2 Same pattern applies to other multi-step operations

The audit identified two other multi-step operations vulnerable to crash-mid-execution: **scheduled-task fire** (state update + dispatch + pending-prompt record) and **steer-with-source-attach**. Apply the same `withTransaction` + version-check + event-append pattern. Specifically:

- `scheduled-task/runner.ts:776-789` (`fire()`) — wrap the state transition + pending prompt insert in `withTransaction`. Detect re-fire via existing `isTerminal` check + version column on tasks (new). Two concurrent `fire()` calls: one wins on version, the other gets `OptimisticLockError` and returns the winner's result.

### 4.3 Files to add/modify

| File | Change |
|---|---|
| `plugins/app-lifeops/src/lifeops/schema.ts:1688` | Add `version: integer().notNull().default(1)` to `lifeWorkThreads` table. |
| `plugins/app-lifeops/src/lifeops/schema.ts:1625` | Add same to `lifeScheduledTasks` table. |
| `plugins/app-lifeops/src/lifeops/sql.ts` | NEW export `withTransaction(runtime, fn)`. Wraps the underlying drizzle/postgres-js transaction. |
| `plugins/app-lifeops/src/lifeops/repository.ts:8078` | Modify `upsertWorkThread` to accept an optional `expectedVersion`. When provided, append `AND version = $expectedVersion` to the UPDATE clause and throw `OptimisticLockError` if 0 rows affected. |
| `plugins/app-lifeops/src/lifeops/repository.ts:7792` | Same for `upsertScheduledTask`. |
| `plugins/app-lifeops/src/lifeops/work-threads/store.ts` | Add a `merge(...)` method using `withTransaction`. The existing `update()` adds an optional `expectedVersion` parameter. |
| `plugins/app-lifeops/src/actions/work-thread.ts:481-585` | Replace the current non-atomic merge loop with a call to `store.merge(...)`. The in-memory `workThreadOperationSemaphore` stays (it's a complementary in-process throttle, not a correctness primitive). |
| `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts:776` | Wrap `fire()` body in `withTransaction`, add version check. |
| `plugins/app-lifeops/src/lifeops/work-threads/types.ts` | Add `version: number` to `WorkThread`. Add `OptimisticLockError` and `MERGE_CONFLICT` error codes. |

**No new tables required.** Existing `life_work_thread_events` and `life_scheduled_task_log` serve as the audit + recovery trail.

### 4.4 Crash recovery

With the above, crash mid-merge is safe:
- All four `UPDATE`s + four `INSERT`s commit atomically. Either the whole merge happened or none of it did.
- On restart, the next caller reads the (now-consistent) state. No reconciliation step needed.
- The `mergeRequestId` idempotency check means a retried request after partial commit (impossible with transactions, but defensive) is a no-op.

We accept that **in-memory `workThreadOperationSemaphore` is lost on crash** — that's fine because it was never a correctness primitive. It exists only to bound concurrent in-process work.

---

## 5. Steering channel for sub-agents

Out of scope for **InterruptBench v1 task targets**, but in scope for Wave 4. Documented here so the contract is complete.

When a long-running sub-agent (Claude Code, Codex) is mid-execution and the user wants to add a constraint without killing it, the parent appends to a steering file the child polls between tool calls. This is the "soft interrupt" pattern from Nous Research's Hermes Agent issue #17298 — they have not implemented it; we will.

Mechanism:
- Sub-agent spawn creates `~/.eliza/workspaces/<sessionId>/steering.jsonl`.
- Parent appends `{type: "steer", message: "<text>", from: "user", at: "<iso>"}` lines.
- Sub-agent's PreToolUse hook (already present per the milady-runtime skill) reads new lines since last check, prepends them to the next LLM prompt.
- Bridge HTTP endpoint at `coding-agents/<sessionId>/steer` accepts POSTs from the parent and writes to the file (atomic append).

InterruptBench task **C1** ("use typescript not python" mid-coding) is the canonical test of this surface. Until Wave 4 lands, C1 scores partial credit only.

---

## 6. Benchmark task DSL

### 6.1 Screenplay format

Tasks live at `packages/benchmarks/interrupt-bench/scenarios/<category>/<task-id>.json`.

```jsonc
{
  "id": "A1-fragmented-email-draft",
  "category": "A",                  // A-O per taxonomy
  "interruptionType": "revision",   // addition | revision | retraction
  "weight": 2,
  "setup": {
    "agentId": "agent-test",
    "rooms": [
      { "id": "dm-alice", "kind": "dm", "owner": "alice" }
    ],
    "users": [
      { "id": "alice", "role": "OWNER" }
    ],
    "openThreads": [],
    "scheduledTasks": [],
    "memory": []
  },
  "script": [
    { "t": 0,    "channel": "dm-alice", "sender": "alice", "text": "i need to" },
    { "t": 800,  "channel": "dm-alice", "sender": "alice", "text": "send" },
    { "t": 1600, "channel": "dm-alice", "sender": "alice", "text": "an email" },
    { "t": 2400, "channel": "dm-alice", "sender": "alice", "text": "to bob about lunch tomorrow" }
  ],
  "expectedFinalState": {
    "threads": [],
    "scheduledTasks": [],
    "repliesByChannel": {
      "dm-alice": { "count": { "min": 1, "max": 1 } }
    }
  },
  "expectedTrace": {
    "stage1Calls": { "min": 1, "max": 2 },
    "plannerCalls": { "min": 0, "max": 1 },
    "roomQueueCoalesceCount": { "min": 3 },
    "boundaryViolations": 0
  },
  "responseRubric": {
    "judgePrompt": "Does the final reply address sending an email to Bob about lunch tomorrow?",
    "passRequiredForBonus": true
  }
}
```

**`t` is not wall-clock.** It is an opaque delivery-ordering integer. The harness delivers messages in order; `t` values within a window finer than the room-queue handler can process arrive while the prior handler is still running. Default rule: any two messages with the same room and `t` difference ≤ 200 are treated as "rapid-fire" relative to the handler.

**The harness controls timing.** Messages with `t=0` and `t=800` deliver back-to-back into the room queue regardless of how long the agent's first handler takes. This is the determinism contract: tests do not depend on the agent being fast or slow.

### 6.2 Categories (final v1 list, 42 tasks)

| ID | Name | Interrupt type | Tasks | Weight |
|---|---|---|---|---|
| A | Stream merging | revision | 4 | 8 |
| B | Cancellation / nvm | retraction | 4 | 7 |
| C | Mid-task interjection | addition | 4 | 9 |
| D | Multi-channel boundary | (none — boundary) | 3 | 7 |
| E | Out-of-order / clock skew | (none — boundary) | 2 | 3 |
| F | Follow-up vs new task | addition | 4 | 8 |
| G | Steering during waiting | addition | 2 | 4 |
| H | Concurrent merge race | (none — concurrency) | 1 | 3 |
| I | Handoff / quiet mode | (none — boundary) | 2 | 3 |
| J | Scheduled-task collision | (none — concurrency) | 1 | 3 |
| K | Long-context info assembly | revision | 3 | 12 |
| L | Distraction / noise | revision | 3 | 6 |
| M | Multi-user collaboration | addition | 1 | 4 |
| N | Cross-thread reference | addition | 2 | 3 |
| O | Reactivation | addition | 2 | 3 |
| NC | Negative controls | (none — control) | 2 | 4 |
| | | | **40** | **97** |

Sum is 40 tasks / 97 weight points (3 reserved for harness slack). Wave 1 lands 10 of these; Wave 3 lands the rest.

### 6.3 Scoring axes (per task, in `[0, 1]`)

| Axis | Weight | Method | Hard floor? |
|---|---|---|---|
| State | 0.30 | JSON-Schema partial match against `expectedFinalState`; specified fields must match exactly, unspecified ignored | yes — failure caps task at 0 |
| Intent | 0.20 | Stage-1 classifier output recorded in trace, compared to `expectedTrace.intent` (when specified) | no |
| Routing | 0.20 | Reply landed in expected channel(s) with expected count; thread mutations on expected thread IDs | yes |
| Trace | 0.10 | Counts (Stage-1 calls, planner calls, coalesce events) within `expectedTrace` bounds — linear penalty past 3× | no |
| Boundary | 0.15 | Zero cross-channel leak; no unauthorized mutation. **Any violation = 0 on this axis AND -5 to total** | yes |
| Latency | 0.05 | Handler p50 < 800ms, p95 < 3000ms with scripted LLM | no |

`task_score = clamp(0, 1, Σ axis_weight × axis_value)`. The State/Routing/Boundary floors are hard: failing them caps `task_score` at that axis's contribution alone (e.g. fail State → max 0.70).

**Aggregate** = `100 × Σ (task_weight × task_score) / Σ task_weight`.

**LLM-judge bonus**: up to +5 points on aggregate, computed only on tasks with `responseRubric.judgePrompt`. Judge sees `(script, expected-state-summary, actual-reply)` and answers yes/no. Tally: `bonus = 5 × judge_yes / judge_total`. Judge model: Claude Haiku 4.5 (cheap, deterministic enough for nightly).

**Pass thresholds**: 70 minimum, 82 production-ready, 90 high-stakes, 95+ canonical Eliza target.

### 6.4 Harness shape — in-process TypeScript

**Reason for not matching the Python convention** used by other `packages/benchmarks/*`: interrupt testing requires fake-clock injection into the runtime, in-memory state snapshotting, LLM call counting, and synchronous queue manipulation. An HTTP/CLI adapter from Python adds a serialization layer that loses determinism. Python-shape benchmarks (clawbench, woobench, loca-bench) score end-to-end behavior; InterruptBench scores *internal* behavior (queue coalescing, trace efficiency, abort propagation) that only an in-process harness can observe.

Layout:

```
packages/benchmarks/interrupt-bench/
├── package.json                  # TypeScript / Bun
├── README.md                     # benchmark overview
├── PLAN.md                       # mirrors this contract
├── scenarios/
│   ├── A/A1-fragmented-email-draft.json
│   ├── A/A4-stream-with-retraction.json
│   ├── B/B1-pure-cancellation.json
│   └── ...
├── src/
│   ├── runner.ts                 # entry point — runs N tasks, emits report
│   ├── clock.ts                  # fake clock with advanceTo()
│   ├── channels.ts               # ChannelSimulator implementing connector interface
│   ├── llm-scripted.ts           # scripted LLM provider keyed by (role, prompt-hash, call-index)
│   ├── llm-real.ts               # passthrough to real provider for `--mode=real` and judge
│   ├── state.ts                  # snapshotter — reads work threads, scheduled tasks, memory
│   ├── trace.ts                  # taps runtime telemetry
│   ├── scorer.ts                 # axis scoring
│   ├── evaluator.ts              # orchestrates one task end-to-end
│   ├── judge.ts                  # LLM-as-judge bonus
│   └── report.ts                 # markdown + JSON output
├── fixtures/
│   └── A1-fragmented-email-draft.llm.json     # recorded scripted-LLM responses
└── tests/
    └── scenarios.test.ts                       # vitest — every scenario loads and runs
```

`package.json` declares `@elizaos/app-core`, `@elizaos/agent`, `@elizaos/app-lifeops` as dev deps via `workspace:*`. Runs against the in-tree runtime so any change to core/lifeops is exercised by the next bench run.

**Commands**:
- `bun run --cwd packages/benchmarks/interrupt-bench bench` — run all scenarios with scripted LLM.
- `bun run --cwd packages/benchmarks/interrupt-bench bench --task A1` — single task.
- `bun run --cwd packages/benchmarks/interrupt-bench bench --mode=real` — replace scripted LLM with the real configured model (Anthropic / Cerebras / Ollama).
- `bun run --cwd packages/benchmarks/interrupt-bench bench --judge` — include LLM-judge bonus.

### 6.5 Determinism

- All `Date.now()` and `setTimeout` in code paths under test must use the runtime's injected `clock`. The runtime already has a clock seam (see `runtime.ts:6248` `abortableSleep`); we extend it to be the only time source. Direct `Date.now()` calls in the hot path become a Wave 1 cleanup target.
- The scripted LLM fixture keys responses by `(role, sha1(canonicalize(messages)), call_index)`. `canonicalize` lowercases action names, strips whitespace, and strips ISO timestamps to make fixtures stable across cosmetic prompt edits. When a key misses, the harness fails the task with `FIXTURE_MISS` and prints the missing key so the operator can re-record.
- Seed for any randomness: `MILADY_BENCH_SEED=0xCAFEBABE`. The runtime's `randomUUID` reads from a seeded PRNG in bench mode.

### 6.6 Gameability defenses (no private holdout)

Without a holdout, defenses are:
1. **Variant generator** — each scenario file optionally declares `variants: [...]` with parameter substitutions (names, addresses, times). CI rolls a fixed-seed variant 0/1/2 per run. Hardcoded "if benchmark then X" fails on fresh variants.
2. **Negative controls (NC1, NC2)** — punish over-cautious "always clarify / always refuse" agents. NC1: "set a 5-min timer" — must just do it. NC2: a simple greeting — must not open a thread.
3. **Trace assertions on minimum calls** — many tasks require *at least* N Stage-1 calls. An always-empty-answer agent fails Trace even when State happens to match.
4. **State + boundary cannot be no-op-satisfied** — most tasks require an action to fire correctly.
5. **Counterfactual pairs** — every CONTRADICT task ships a paired task where the user is wrong and the agent must stand ground.
6. **Variant freshness** — quarterly rotation adds 1-2 newly-written tasks. Drop on new vs. old > 10 points signals overfit.

---

## 7. Wave 1 acceptance criteria

Wave 1 is **done** when all of the following are true. Anything less is incomplete.

### 7.1 Plumbing
- [ ] `TurnControllerRegistry` exists at `packages/core/src/runtime/turn-controller.ts`. Unit tests cover `runWith` happy path, `abortTurn` while running, two concurrent rooms not interfering.
- [ ] `RoomHandlerQueue` exists at `packages/core/src/runtime/room-handler-queue.ts`. Unit tests cover: enqueue while idle, enqueue while busy, queue drained in order, two rooms in parallel, queue cleared on `quiesce`.
- [ ] `withCleanup` exists at `packages/core/src/runtime/cleanup-scope.ts`. Tests cover normal completion, abort with cleanup, abort with cleanup timeout.
- [ ] `withTransaction` exists at `plugins/app-lifeops/src/lifeops/sql.ts`. Tests cover commit happy path, rollback on throw, nested call rejected with clear error.
- [ ] `OptimisticLockError` exists. `upsertWorkThread` and `upsertScheduledTask` throw it when `expectedVersion` mismatches.

### 7.2 Wiring
- [ ] `message.ts` handler entry wraps in `roomQueue.runWith(roomId, controller.runWith(roomId, async (signal) => {...}))`. Existing `context.abortSignal` populates from the turn signal.
- [ ] `/api/turns/:roomId/abort` endpoint exists and aborts the turn.
- [ ] `abortIntentEvaluator` registered as built-in, runs on every inbound message, calls `runtime.abortTurn` when active turn + abort intent.
- [ ] `work-threads/store.ts` exposes `merge(...)` using `withTransaction`.
- [ ] `actions/work-thread.ts` merge path calls `store.merge`. The atomic-merge integration test from the prior wave still passes.
- [ ] `scheduled-task/runner.ts` `fire()` wrapped in `withTransaction`, idempotent on duplicate fire.

### 7.3 Benchmark
- [ ] Package `packages/benchmarks/interrupt-bench/` exists with the layout in §6.4.
- [ ] 10 representative scenarios are authored and pass against current Eliza (after the §7.1/7.2 changes land): A1, A4, B1, B2, C1, D1, F1, G1, H1, K1.
- [ ] Scripted LLM fixtures committed for those 10.
- [ ] `bun run --cwd packages/benchmarks/interrupt-bench bench` produces a report. Per-axis + aggregate score printed.
- [ ] Aggregate score on those 10 tasks ≥ 75 (≥ 60% of full mark, scaled). If below, surface the lowest-scoring axes as Wave 2 input.

### 7.4 Verification
- [ ] `bun run --cwd packages/core typecheck` passes.
- [ ] `bun run --cwd packages/core build` passes.
- [ ] `bun run --cwd plugins/app-lifeops typecheck` passes.
- [ ] `bun run --cwd plugins/app-lifeops build` passes.
- [ ] `bun run --cwd plugins/app-lifeops test` passes — including the existing `work-threads.integration.test.ts` boundary suite.
- [ ] `bun run --cwd packages/benchmarks/interrupt-bench test` passes — every scenario file parses and the harness can load it.

### 7.5 Documentation
- [ ] `packages/benchmarks/interrupt-bench/README.md` written. Audience: someone outside the team running it for the first time.
- [ ] `packages/benchmarks/interrupt-bench/PLAN.md` written — copy of this contract plus per-wave checkboxes.
- [ ] CLAUDE.md updated with the bench command.

---

## 8. Wave 2/3/4 preview (informational; not gated by Wave 0)

| Wave | Goal | Major deliverables |
|---|---|---|
| Wave 2 | Make Eliza pass 88+ on Wave 1's 10 scenarios | Address whatever axes scored lowest. Likely: room-queue reconciliation classifier (Intent axis), atomic-merge integration with concurrent fires (State axis), cross-channel summary redaction (Boundary axis), trace efficiency improvements (Trace axis). |
| Wave 3 | Author remaining 30 scenarios + negative controls + variant generator | Bring scenario count to 42. Run full bench nightly in CI. |
| Wave 4 | Steering channel for sub-agents; long-context slot extraction; per-channel sequence/serverTs; durable lock leases | Unlocks C1, K2, K3 to 100%. Closes the gap to canonical 95+ target. |

---

## 9. Open items (require user approval to proceed)

1. **Schema migration timing.** Adding a `version` column to `life_work_threads` is a schema change. Confirm the plugin migration system at `runtime.runPluginMigrations` is the right path. Alternative: leave existing rows at `version=1` via default, no data migration needed.
2. **Whether to apply the version column to `life_scheduled_tasks` simultaneously.** Recommended yes (we get idempotent `fire()` for free). Confirm.
3. **`abortIntentEvaluator` keyword list.** Initial list: `stop`, `cancel`, `nevermind`, `never mind`, `nvm`, `wait stop`, `forget it`, `abort`. Confirm.
4. **Whether to ship `bench --mode=real` in Wave 1** or defer to Wave 2. Scripted is mandatory for Wave 1; real is convenience. Recommend defer.
5. **CI integration cadence.** Public scenarios on every PR (~30s per scenario, ~5 min full), full nightly. Confirm.

---

## 10. Approval

| Section | Decision | Approve? |
|---|---|---|
| §0 Scope changes | Drop text debouncer, keep handler-level serialization, no private holdout, keep "InterruptBench" name | ☐ |
| §1 Paper integration | Adopt addition/revision/retraction labels; extend with 5 domain-specific categories | ☐ |
| §2 Handler serialization | One handler per `roomId`; in-memory queue; post-handler reconciliation classifier | ☐ |
| §3 AbortController topology | Turn-scoped root; sync sub-agents share signal; async sub-agents own controller + parent listener; 5s cleanup window | ☐ |
| §4 Atomic merge | Optimistic concurrency (version column) + `withTransaction` API + existing event log + idempotency key | ☐ |
| §5 Steering channel | Out of scope for Wave 1; planned for Wave 4 | ☐ |
| §6 Benchmark DSL & scoring | JSON screenplay; 6-axis scoring; LLM-judge bonus; TypeScript in-process harness at `packages/benchmarks/interrupt-bench/` | ☐ |
| §7 Wave 1 acceptance criteria | As listed | ☐ |
| §9 Open items | Resolve each before Wave 1 starts | ☐ |

Approve all → Wave 1 begins.
