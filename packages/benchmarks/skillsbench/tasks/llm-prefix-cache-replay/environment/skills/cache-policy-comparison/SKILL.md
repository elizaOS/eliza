---
name: cache-policy-comparison
description: Compare and implement eviction policies (LRU, LFU, FIFO, S3FIFO, ARC) for bounded-capacity caches. Use when choosing or implementing an eviction policy for a buffer pool, page cache, CDN edge, or LLM KV cache, or when writing a replay simulator that supports multiple policies. Clarifies recency vs frequency semantics, queue topology, saturating counters, ghost buffers, and the second-chance rule that distinguishes modern FIFO-family policies from classic LRU.
---

# Overview

An eviction policy decides which resident entry a cache removes when a new entry is admitted beyond capacity. Four policies cover almost every replay-and-measure task:

| Policy   | Data structure                  | On hit                       | On admit                             | Eviction choice                                   |
|----------|---------------------------------|------------------------------|--------------------------------------|---------------------------------------------------|
| LRU      | OrderedDict                      | Move to tail                 | Append at tail                       | Pop head                                          |
| LFU      | `{key: freq}` + insertion order  | `freq[k] += 1`               | `freq[k] = 1`                         | Min `freq`, tiebreak by insertion order           |
| FIFO     | OrderedDict                      | Nothing                      | Append at tail                       | Pop head                                          |
| S3FIFO   | Three FIFO queues + `freq[k]`    | `freq[k] = min(freq+1, cap)` | Admit to small; ghost-hit admits to main | Second-chance on main; small drains to main/ghost |

Each has subtleties that trip naive implementations.

# LRU

Use an `OrderedDict` where the tail is the most-recently-accessed key. On hit, `move_to_end`. On miss + insert, append; pop from head if over capacity.

Most common bug: **forgetting to update recency on a hit**. Without the refresh, LRU degenerates to FIFO — hit rate drops substantially on any workload with recency structure.

```python
from collections import OrderedDict

class LRU:
    def __init__(self, capacity):
        self.capacity = capacity
        self._d = OrderedDict()

    def contains(self, k): return k in self._d

    def access(self, k):
        if k in self._d:
            self._d.move_to_end(k)
        else:
            self._d[k] = None
            if len(self._d) > self.capacity:
                self._d.popitem(last=False)
```

# LFU

Keep `freq: dict[key, int]` and a tie-breaker — an insertion counter is simplest and deterministic. On hit, increment `freq[k]`. On miss at capacity, evict `min(freq)` with ties broken by insertion order (oldest first).

Typical bugs:

- **No tie-breaker.** `min(freq.items(), key=lambda x: x[1])[0]` has implementation-defined behaviour across interpreters and distributions. Always include a secondary key.
- **Frequency pollution.** A block that was hot once and then went cold can linger forever because its freq is permanently above newcomers. Production systems add aging (periodic decay of freq) or combine with a recency signal (W-TinyLFU). Pure LFU is correct for the task as specified but fragile in practice.

# FIFO

One queue, insertion order, no hit-time update. Useful as a lower-bound baseline.

Do NOT call it "LRU without hit update" — conceptually different even when implementations overlap. Hit on a FIFO cache is still a hit for accounting; the block just does not change rank.

# S3FIFO

A modern FIFO-family policy (Yang et al., SOSP 2023) that matches or beats LRU on typical web and LLM workloads with a fraction of the bookkeeping cost — which is why recent production systems (Twitter, Google) have been switching to it. The full algorithm — three queues, saturating frequency counter, second-chance eviction on the main queue — is implemented in the `prefix-cache-replay` skill. Consult that skill if your task uses S3FIFO.

# Workload implications

- Strong **recency** → LRU wins slightly.
- Stable **hot set** with long tail (Zipf) → LFU or S3FIFO.
- Nearly uniform random → all converge toward `capacity / working_set` hit rate.
- **Prefix-shared LLM workloads** are mixed — shared prefixes are both recent and frequent, so LRU/LFU/S3FIFO typically sit within a few percent of each other at the same capacity, but they differ in which blocks remain resident at end-of-trace, and their miss-handling costs diverge. Measure, don't assume.

# Comparing hit rates on a trace

Replay the same trace through each policy at identical capacity, record `total_hit_tokens / total_prompt_tokens` and the final resident set. Do not compare hit rate alone — also compare:

- Final residency — how many unique blocks are resident at the end. Under S3FIFO this is often strictly less than capacity because ghost entries absorb the admission pressure.
- Per-request hit-token distribution — two policies can have similar overall hit rate but very different per-request variance.
- Admission effort — under policies with ghost structures, the bookkeeping cost per access is non-trivial.

# Common mistakes

- Reusing an LRU implementation when the task specifies S3FIFO (or vice versa). The final hit rate and residency will both differ; no partial credit for "close enough".
- Making ghost count as resident, or treating a ghost hit as a hit for token accounting.
- Forgetting to saturate `freq` — unbounded counters turn the main-queue second-chance loop into a spin.
- Under LFU, using Python `min(d.items(), key=d.get)` without an explicit insertion-order tiebreaker.
- Misordering admission and residency check. Always check `h ∈ cache` BEFORE applying the admission side effects of the current request, otherwise every request self-hits.
- Final cache size off by small constants because you forgot to exclude ghost or you forgot to subtract the S-cap vs M-cap split.
