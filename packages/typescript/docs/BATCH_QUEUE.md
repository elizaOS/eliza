# Batch queue toolkit (`utils/batch-queue`)

This document explains **when** to use `PriorityQueue`, `BatchProcessor`, `TaskDrain`, and the composed `BatchQueue`, and **why** they exist as separate layers.

---

## Problem

Several subsystems needed the same building blocks:

- **Priority-ordered work** (high before normal before low)
- **Bounded or unbounded queues** (optional backpressure, not silent eviction by default)
- **Batch draining** with a **concurrency cap** on I/O (embedding API, HTTP)
- **Retries** with backoff (reuse `utils/retry.ts`)
- **Task-system scheduling** — `tags: ["queue", "repeat"]` tasks so the **task service owns *when*** work runs, not ad-hoc timers

Duplicating this in `EmbeddingGenerationService`, `PromptBatcher`, and ad-hoc loops (e.g. action-filter embedding) caused drift and inconsistent retry behavior.

---

## Three composable layers (and why not one class)

| Layer | Role | Why separate |
|-------|------|----------------|
| **`PriorityQueue<T>`** | Pure in-memory ordering + optional `maxSize` / `onPressure` | No async, no runtime — easy to test and reuse in tests or non-agent code. |
| **`BatchProcessor<T>`** | Run a **batch** of items with `Semaphore` + per-item retries | Stateless: same processor can serve multiple producers; action-filter uses it **without** a queue or tasks. |
| **`TaskDrain`** | Find-or-create repeat tasks + optional `registerTaskWorker` | Task **names** and **metadata** differ per use case (`EMBEDDING_DRAIN` vs `BATCHER_DRAIN` + `affinityKey`). Split avoids one god-object. |
| **`BatchQueue<T>`** | Composes all three + `isDraining` guard | Embedding-sized use case: enqueue → periodic drain → process batch. |

**Why not fold embeddings into `PromptBatcher`?** Embeddings call `TEXT_EMBEDDING`; the batcher dispatches structured **text generation** with schemas. Different model types and packing rules — sharing only the queue/scheduling primitives keeps each domain honest.

---

## Unbounded queue by default

**Why:** Queue items are small (references + metadata). The real bottleneck is **I/O** (embedding endpoint, LLM), not RAM. Capping the queue and **silently evicting** work loses requested embeddings with little memory benefit.

**Optional `maxSize`:** Use when staleness matters (e.g. trimming old buffered messages). Pair with `onPressure` so the **caller** decides drop vs persist vs reject — no built-in silent eviction.

---

## `TaskDrain` and `skipRegisterWorker`

- **`EMBEDDING_DRAIN`:** `TaskDrain` registers the worker **and** creates the repeat task. The worker’s `execute` calls `BatchQueue.drain()`.

- **`BATCHER_DRAIN`:** `TaskService` registers **one** worker for that name; `execute` reads `metadata.affinityKey` and calls `promptBatcher.drainAffinityGroup(affinityKey)`. Each affinity therefore uses `TaskDrain` with **`skipRegisterWorker: true`** — only the DB repeat task is created/updated/deleted; no second worker registration.

**Why `maxFailures: -1` on repeat tasks:** `JSON.stringify(Infinity)` becomes `null` in some paths; `-1` round-trips and means “never auto-pause” drain tasks (see CHANGELOG / task system notes).

---

## Retry semantics (`BatchProcessor`)

- **`maxRetriesAfterFailure`:** After the first failure, retry up to *N* more times → **total attempts = N + 1** (aligned with the old embedding “re-queue until `retryCount < maxRetries`” idea).

- **Per-item override:** If `item` has a numeric `maxRetries`, `getPerItemMaxAttempts` uses `maxRetries + 1` attempts. **Why:** Payloads can request stricter or looser limits per memory.

- **Inline retries vs re-enqueue:** Retries happen **inside** `processOne` with backoff sleep, not by pushing back onto the priority queue. **Why:** Simpler lifecycle, no lost items between ticks, backoff avoids hammering a failing API; the semaphore is released between attempts so other work can proceed.

---

## Consumers in core

| Consumer | What it uses | Notes |
|----------|----------------|-------|
| `EmbeddingGenerationService` | `BatchQueue` | No `maxSize`; `maxParallel` 10; task description for operators. |
| `PromptBatcher` | `TaskDrain` per affinity | Sections + dispatcher unchanged; only task lifecycle DRY’d. |
| `ActionFilterService.buildIndex` | `BatchProcessor` only | Batches of 10 actions; retries on transient embedding errors. |
| `PromptDispatcher` | `Semaphore` (via `shared` re-export) | Unchanged API; implementation lives in `batch-queue/semaphore.ts`. |

---

## Imports

```typescript
import {
  BatchQueue,
  BatchProcessor,
  PriorityQueue,
  TaskDrain,
  Semaphore,
} from "@elizaos/core"; // or ../utils/batch-queue from inside the package
```

Barrel: [`src/utils/batch-queue.ts`](../src/utils/batch-queue.ts) re-exports from [`src/utils/batch-queue/index.ts`](../src/utils/batch-queue/index.ts).

---

## Related

- [DESIGN.md](DESIGN.md) — high-level agent design.
- [LLM_ROUTING.md](LLM_ROUTING.md) — prompt batcher vs `useModel` (orthogonal to this queue toolkit).
- [CHANGELOG.md](../CHANGELOG.md) — batch-queue entries under Unreleased.
