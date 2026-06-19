# Prior Proposals for Fixing Seed Eviction

**Document Owner:** Memory Retrieval Team  
**Last Updated:** 2024-05-25  
**Context:** The truncation stage (Stage 5) of the retrieval pipeline systematically drops older seed memories when the result set exceeds `max_total_results`. This document collects previous proposals for addressing this issue.

---

## Proposal 1: Increase `max_total_results` to 100

**Author:** Sarah Kim  
**Date:** 2024-03-10  
**Status:** Draft — Not Implemented  

### Description

The simplest fix: double `max_total_results` from 50 to 100. With 10 seeds and ±3 context expansion, the maximum pre-dedup size is 70 entries. After dedup, this typically falls to 55–65 entries, which would fit within a limit of 100 without any truncation.

### Analysis

- **Pros:** Zero code changes required. Eliminates truncation entirely for most queries.
- **Cons:**
  - Downstream consumers (LLM context window, UI rendering) are designed for 50 results max.
  - Latency testing showed a 40% increase in end-to-end response time when returning 100 results.
  - Memory consumption increases proportionally.
  - Does not address the root cause — if `seed_quota` or `context_window` are ever increased, the problem returns.

### Decision

Rejected by tech lead due to latency concerns. The team agreed that a more targeted fix is needed.

---

## Proposal 2: Round-Robin Context Slot Allocation

**Author:** Marcus Chen  
**Date:** 2024-04-02  
**Status:** Draft — Incomplete  

### Description

Instead of expanding all seeds fully and then truncating, allocate context slots evenly across seeds using a round-robin approach:

1. Reserve 1 slot per seed (10 slots for seed entries themselves).
2. Remaining budget = `max_total_results` - `seed_quota` = 40 slots.
3. Distribute 40 context slots across 10 seeds: 4 context entries per seed.
4. For each seed, select the 4 closest context entries (2 before, 2 after when possible).

### Analysis

- **Pros:** Guarantees every seed appears in the final result. Fair allocation.
- **Cons:**
  - Does not handle deduplication — if two seeds are close together, their context windows overlap and the round-robin wastes slots on duplicates.
  - The proposal does not specify what happens when a seed is near the boundary (id=1 or id=200) and cannot fill its context allocation.
  - No implementation sketch or pseudocode provided.

### Open Questions

- How to handle overlapping windows between adjacent seeds?
- Should seeds with higher relevance scores get more context slots?
- What is the fallback when a seed cannot fill its allocation?

### Decision

Tabled pending answers to open questions. Marcus moved to a different project.

---

## Proposal 3: Weight-Based Priority Queue

**Author:** Priya Patel  
**Date:** 2024-04-18  
**Status:** Draft — Sketch Only  

### Description

Use a priority queue to manage the result set, where each entry's priority is a function of:
- Its parent seed's relevance score
- Its distance from the parent seed
- A temporal diversity bonus

The queue would be bounded at `max_total_results`. When a new entry is added and the queue is full, the lowest-priority entry is evicted. This ensures that high-relevance seeds and their close context are protected.

### Sketch

```
priority(entry) = seed_relevance * decay(distance) + diversity_bonus(time_bucket)
```

Where:
- `decay(distance)` = 1.0 / (1 + distance_from_seed)
- `diversity_bonus(time_bucket)` = bonus if the time bucket is underrepresented in the current queue

### Analysis

- **Pros:** Elegant solution that balances relevance, context proximity, and temporal diversity.
- **Cons:**
  - No concrete algorithm for computing `diversity_bonus` — how to define "underrepresented"?
  - No analysis of computational complexity.
  - No handling of the deduplication stage — does dedup happen before or after the priority queue?
  - No prototype or benchmark results.

### Decision

Acknowledged as promising but needs significant development. No one has been assigned to flesh it out.

---

## Summary

| Proposal | Approach | Status | Blocker |
|----------|----------|--------|---------|
| 1. Increase limit | Raise max_total_results to 100 | Draft | Latency increase unacceptable |
| 2. Round-robin | Allocate context slots per seed | Draft | Incomplete — no dedup handling |
| 3. Priority queue | Weight-based eviction | Draft | Sketch only — no algorithm detail |

All three proposals remain in draft status. The eviction problem continues to affect retrieval quality for older memories, as documented in `reports/precision_analysis.csv` and the retrieval run logs.
