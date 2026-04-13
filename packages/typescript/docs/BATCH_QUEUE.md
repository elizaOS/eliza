# Batch queue subsystem (`utils/batch-queue`)

This document explains **why** `@elizaos/core` ships a small shared stack for prioritized queues, bounded-concurrency batch execution, repeat-task drains, and (when needed) the composed **`BatchQueue`**. It complements inline code comments and [CHANGELOG.md](../CHANGELOG.md).

---

## Problem statement

Several subsystems need overlapping concerns:

- **Ordering** — e.g. high / normal / low priority before processing.
- **Bounded parallelism** — avoid unbounded `Promise.all` against model APIs.
- **Retries and backoff** — align with the rest of the runtime ([`utils/retry.ts`](../src/utils/retry.ts)).
- **Scheduling** — repeat tasks with `tags: ["queue", "repeat"]`, stable metadata (`maxFailures: -1`, etc.).

It is tempting to fix **only** the worst hot path (for example a three-line semaphore in one service). That is often correct for a **single** bottleneck. The risk is **proliferation**: each new feature copies a slightly different queue, drain loop, or `createTask` + `registerTaskWorker` pair. Those copies drift, disagree on edge cases (pause, dispose, retry), and make review harder (“is this the same pattern as embedding or a new one?”).

---

## What we standardized

| Piece | Role |
|--------|------|
| **`PriorityQueue<T>`** | What runs next (three deques, optional `maxSize` / `onPressure`). |
| **`BatchProcessor<T>`** | How a **slice** runs: semaphore-limited concurrency, retries, `onExhausted`. |
| **`TaskDrain`** | When the task system ticks: find/create repeat task, optional worker registration. |
| **`BatchQueue<T>`** | End-to-end “enqueue → drain on interval → process batch” when a service needs all three. |
| **`Semaphore`** | Shared primitive; also re-exported from `prompt-batcher/shared.ts` so existing imports keep working. |

Callers **compose only what they need**:

- **Embedding generation** — `BatchQueue` (queue + processor + drain).
- **Action filter index build** — `BatchProcessor` only (synchronous batch job, no repeat task).
- **Knowledge** — `BatchProcessor` for document embedding fallback and `generateTextEmbeddingsBatch` (bounded parallel `TEXT_EMBEDDING` calls).
- **Prompt batcher per-affinity drains** — `TaskDrain` with **`skipRegisterWorker: true`** because a **single** global worker handles `BATCHER_DRAIN` and dispatches by `metadata.affinityKey`; per-affinity instances must not register duplicate workers with the same name.

---

## Design choices (WHYs)

### Why not push failed items back onto the priority queue?

**BatchProcessor** retries **in place** for that item, then moves on. Re-queueing failures between ticks would complicate lifecycle (duplicate detection, ordering, partial batches) and could interact badly with concurrent drains. See `batch-processor.ts` header.

### Why `TaskDrain` supports `skipRegisterWorker`?

Registering a worker twice under the same task name would **overwrite** the previous handler. Batcher affinities share one logical worker in `TaskService`; each affinity only needs the **DB row** and interval updates. See `task-drain.ts` header.

### Why `maxFailures: -1` on drain tasks?

`JSON.stringify(Infinity)` becomes `null`; metadata round-trips through storage. **`-1`** is stored reliably and means “do not auto-pause” for long-lived drains. Documented in CHANGELOG under batcher / task fixes.

### Why is the embedding queue unbounded by default?

**Throughput** (embedding I/O) is usually the real limit, not in-memory queue length. A bounded queue with eviction is a **product policy**; it can be reintroduced via `maxSize` + `onPressure` on `BatchQueueOptions` if a deployment needs it.

---

## Where to read code

- Module rationale (reviewer-oriented): [`src/utils/batch-queue.ts`](../src/utils/batch-queue.ts) (top-of-file comment).
- Composition and `BatchQueue` behavior: [`src/utils/batch-queue/index.ts`](../src/utils/batch-queue/index.ts).
- Tests: `src/__tests__/batch-queue.test.ts`, `src/__tests__/task-drain.test.ts`.

---

## Limitations (current behavior)

- **Cancellation:** `dispose` does not abort in-flight `process()` calls (for example an active `useModel` request). Shutdown is cooperative; long-running work may finish after the repeat task row is deleted.
- **High-priority flush on dispose:** By default uses a dedicated `BatchProcessor` (serial, `maxAttemptsCap: 1`) so shutdown matches bounded concurrency and avoids long retry tails; set `disposeHighPriorityViaProcessor: false` on `BatchQueueOptions` only if you need the legacy direct `process` loop.
- **Default queue length:** `BatchQueue` / `PriorityQueue` are unbounded unless you set `maxSize` + `onPressure`; memory is bounded by deployment policy, not by this module alone.

---

## Related docs

- **Public docs (same content):** [Batch queue subsystem](https://docs.elizaos.ai/runtime/batch-queue) on docs.elizaos.ai — source: `packages/docs/runtime/batch-queue.mdx` in the monorepo.
- [DESIGN.md](./DESIGN.md) — Broader core design decisions.
- [CHANGELOG.md](../CHANGELOG.md) — What shipped and when, with per-item WHYs.
- [ROADMAP.md](../ROADMAP.md) — Forward-looking work (this subsystem is **shipped**; roadmap points here for rationale).
