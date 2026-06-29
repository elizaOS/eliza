# recall-bench (#9956)

Quality benchmark for the agent's **memory-recall + knowledge-retrieval** path —
`AgentRuntime.searchMemories`, `DocumentService.searchDocuments` (hybrid /
vector / keyword), and the `DOCUMENTS` / `FACTS` recall providers. The repo
measures retrieval *cost* (`memperf`) and LLM *context-window* attention
(`context_bench`) but never retrieval *correctness* at document scale, and the
recall path **fails open** (a slow/errored embed silently degrades semantic
recall to keyword-only) with no metric guarding it. See #9956.

## Status

This package currently ships the **deterministic scoring foundation** that the
rest of #9956 builds on, fully unit-tested in isolation:

- `metrics.ts` — Precision@K, Recall@K, MRR, nDCG@K, HitRate@K, nearest-rank
  latency percentiles, and `summarizeRecall()`. Pure functions, no I/O. Honesty
  contract from `memperf`: unmeasured rows are `null` (never `0`), and a summary
  is `measured: true` only when at least one query was actually scored.
- `metrics.test.ts` — 19 cases with hand-computed expected values, including a
  guard that a fail-open keyword regression scores **strictly below** the vector
  path (the silent-degradation risk #9956 names).

```bash
bunx vitest run packages/benchmarks/recall-bench/metrics.test.ts
```

## Remaining work-order (the harness + CI gate)

These need the **real** `@elizaos/core` pipeline stood up over a labelled
corpus, and a CI runner — tracked in #9956, not yet in this package:

- [ ] Driver that ingests a document-scale corpus through the real
      `DocumentService` (no Python/mock reimpl) + a query set with ground-truth
      relevant fragment ids, runs each `SearchMode`, and feeds results through
      `summarizeRecall`.
- [ ] Per-mode emission (hybrid / vector / keyword) so the hard-coded
      `HYBRID_VECTOR_WEIGHT 0.6 / 0.4` and the fail-open degradation are each
      quantified.
- [ ] A fail-open assertion: force `embedRecallQuery` to return `null` and
      assert a measured recall drop vs the vector path.
- [ ] Cover the keyword chat-search surface (`scoreMemoryText`) and a
      `FACTS`-provider recall slice against the same corpus.
- [ ] Register in `registry/commands.py` + `registry/scores.py` and wire
      `recall-bench.yml` with a committed `budgets.json`, mirroring `memperf`.
