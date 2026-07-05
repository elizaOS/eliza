# Evidence — #13772 Orchestrator admission control: queue vs reject at the session cap

Implements Rollout stages 1–3 of `DESIGN_13772.md` (HYBRID). The live 10-vs-5 E2E
(WS8) is deferred to #13778, as specified.

## What changed (files)

| File | Purpose |
| --- | --- |
| `src/services/types.ts` | New typed errors `SessionCapError` (`code: 'SESSION_CAP_REACHED'`, `maxSessions`, `activeCount`, `slotClass`) + `AdmissionQueueFullError`; `SessionSlotClass`; `SpawnOptions.slotClass`. |
| `src/services/acp-service.ts` | Slot classes (`worker`/`system`), `systemSessionHeadroom`, `computeCapacity`, public `getCapacity()`, `enforceSessionLimit(slotClass)` throwing `SessionCapError`; `reserveSessionSlot` threads the class; sessions stamp `metadata.slotClass`. |
| `src/services/orchestrator-task-service.ts` | The admission queue: park-at-cap in `spawnAgentForTask`, durable `metadata.admission`, `orderAdmissionQueue` (bands + FIFO + aging), depth cap, `drainAdmissionQueue` (terminal-event + 30s reconcile), idle reclaim, rebuild-from-store, `getCapacitySnapshot`, `queuedCountsByRoom`, DTO overlay; pause/resume/archive/delete dequeue; verifier spawns `system`. |
| `src/services/orchestrator-task-mapper.ts` | `TaskThreadDto.admission?: { state; position; enqueuedAt }` (type only; the service overlays the live position). |
| `src/api/orchestrator-routes.ts` | `GET /capacity`; `POST /tasks/:id/agents` → 202 when queued (201 immediate), `AdmissionQueueFullError` → 429. |
| `src/providers/active-sub-agents.ts` | `capacity: A/M worker sessions; queued: N (next: …)` header line + `data.capacity` (counts/ids only — cache-stable). |
| `src/services/task-supervisor-service.ts` | Per-room queued count folded into the digest header. |
| `__tests__/unit/acp-service.test.ts` | Updated cap test to assert the typed error; added slot-class + `getCapacity` tests. |
| `src/__tests__/admission-queue-order.test.ts` | Pure order tests. |
| `src/__tests__/admission-queue.integration.test.ts` | Real-service integration tests. |

## Before / after — the throw site (`acp-service.ts`, `enforceSessionLimit`)

Before (opaque string, no slot classes):

```ts
private async enforceSessionLimit(): Promise<void> {
  const sessions = await this.store.list();
  const active = sessions.filter(
    (s) => !["stopped", "errored", "completed", "cancelled"].includes(s.status),
  );
  if (active.length >= this.maxSessions)
    throw new Error(`acpx max session limit reached (${this.maxSessions})`);
}
```

After (typed error + slot-class accounting, shared with `getCapacity`):

```ts
private async enforceSessionLimit(slotClass: SessionSlotClass): Promise<void> {
  const capacity = this.computeCapacity(await this.store.list());
  if (slotClass === "system") {
    if (capacity.activeSystem >= this.systemSessionHeadroom) {
      throw new SessionCapError({
        maxSessions: this.systemSessionHeadroom,
        activeCount: capacity.activeSystem,
        slotClass: "system",
      });
    }
    return;
  }
  if (capacity.activeWorkers >= this.maxSessions) {
    throw new SessionCapError({
      maxSessions: this.maxSessions,
      activeCount: capacity.activeWorkers,
      slotClass: "worker",
    });
  }
}
```

Direct spawn callers keep fail-fast — but the error message is now actionable
("Session capacity reached (2/2 worker sessions active). Create a task to queue
this work, or wait for a running session to finish.") and carries the stable
`SESSION_CAP_REACHED` code.

## Queue state machine (summary)

- **queued = `open` task + durable `metadata.admission = { state:'queued', enqueuedAt, priorityAtEnqueue, spawnOpts }`.** No new table, no new status.
- **Park:** `spawnAgentForTask` catches `SessionCapError` (worker cap) → `enqueueAdmission` (throws `AdmissionQueueFullError` past `ELIZA_ACP_ADMISSION_QUEUE_DEPTH`, default 32) → returns 202 DTO with `admission.position`.
- **Order:** total order `(effectiveBand desc, enqueuedAt asc, taskId asc)`; `effectiveBand = min(urgent, base + floor(wait / ELIZA_ACP_QUEUE_AGING_MS))` (default 10 min) so `low` cannot starve.
- **Dispatch:** `drainAdmissionQueue` runs on every terminal session event and a 30s reconcile tick. While `freeSlots > 0`: dequeue head → re-read task (skip if terminal/paused) → `spawnAgentForTask(…, 'throw-on-cap')` → clear admission. Lost slot race → catch `SessionCapError`, keep position.
- **Idle reclaim:** at 0 free slots, stop the oldest keepAlive session whose *task* is terminal (`done`/`failed`/`archived`); never touch `validating`/`active`.
- **Verifier:** `spawnReadOnlyVerifier` uses `slotClass:'system'` → its own headroom (`ELIZA_ACP_SYSTEM_SESSION_HEADROOM`, default 2), so validation never deadlocks behind a full worker pool.
- **Lifecycle:** pause dequeues (durable record kept), resume re-enqueues + drains, archive/delete clear the entry.
- **Flag:** `ELIZA_ACP_ADMISSION_QUEUE=1` default ON; `0` restores reject-at-cap (bisection kill switch).

## Test output (real)

New + updated tests (all green):

```
$ bunx vitest run src/__tests__/admission-queue-order.test.ts \
    src/__tests__/admission-queue.integration.test.ts \
    __tests__/unit/acp-service.test.ts
 Test Files  3 passed (3)
      Tests  67 passed (67)
```

- `admission-queue-order.test.ts` — 8 pure tests: bands, FIFO, taskId tie-break, aging promotion, aging cap, aging-off, no-mutate.
- `admission-queue.integration.test.ts` — 9 real-service tests (real `OrchestratorTaskService` + real in-memory store + faithful fake ACP throwing the real `SessionCapError`): park-at-cap 202+position, priority-ordered drain with zero drops, depth-cap → `AdmissionQueueFullError`, dequeue-on-pause + re-enqueue-on-resume, archive clears the entry, rebuild-from-store ordering on restart, idle-reclaim, provider capacity line, reject-at-cap kill switch.
- `acp-service.test.ts` — real `AcpService` (native-mock transport): typed `SESSION_CAP_REACHED` at the worker cap, system-headroom spawn at a full worker cap, `getCapacity` worker/system split.

Typecheck (touched files clean):

```
$ bun run typecheck    # 0 errors in any src/ or __tests__/ file I touched
```

Biome:

```
$ bunx @biomejs/biome check <touched files>
Checked 10 files in 139ms. No fixes applied.   # clean
```

## Regression sweep

```
$ bunx vitest run --exclude '**/*.e2e.test.ts' --exclude '**/*live*' --exclude '**/orchestrator-grilling*'
 Test Files  6 failed | 151 passed (157)
      Tests  26 failed | 1616 passed (1642)
```

The 26 failures are all in 6 TASKS-action test files
(`control-resume-clears-paused`, `archive-reopen-lifecycle`,
`task-history`, `provision-workspace`, `active-session-forward`,
`task-control-structural`). **All 6 are byte-identical to `origin/develop`**, and
every failure is the same `TypeError: runtime.reportError is not a function`
raised inside `services/task-policy.ts` `resolveConnectorSource` — a call added
by #13324 (commit `a60edb63bd`, already in this branch's base) whose test mocks
were never given a `reportError`. These are **pre-existing develop failures**,
unrelated to this change; none of the files this PR touches regress.

## Deviations from DESIGN_13772.md

- **DTO `admission.position` is overlaid by the service, not the pure mapper.** `position` is a cross-task live value (it depends on the whole ordered queue), so `getTask` computes it; the mapper only declares the field. This keeps the mapper pure and the position honest (no fake precision).
- **Router-respawn / `reattachSession` re-queue-at-head (design item 2, second half) is NOT implemented.** `reattachSession` and `sub-agent-router` respawns now throw the typed `SessionCapError` (so they no longer die on an opaque string), but re-queuing a lost session *at the head of the admission queue* would require a session→task-service seam across the ACP (inner) → orchestrator (outer) layer boundary and is a recovery-path refinement, not part of the core admission flow. Deferred; the reconcile tick + terminal-event drain still make forward progress. Called out here honestly rather than half-wired.
- **Supervisor digest fold is scoped to rooms that already have a live-task digest.** A room whose tasks are *all* queued (no live task, source unknown to the tick) is not given a brand-new digest; the queued count is folded into existing per-room digests only.
```
