# recall-bench (#9956)

Quality benchmark for the agent's **memory-recall + knowledge-retrieval** path —
`AgentRuntime.searchMemories`, `DocumentService.searchDocuments` (hybrid /
vector / keyword), and the keyword chat-search surface (`scoreMemoryText`). The
repo measures retrieval *cost* (`memperf`) and LLM *context-window* attention
(`context_bench`) but never retrieval *correctness* at document scale, and the
recall path **fails open** (a slow/errored embed silently degrades semantic
recall to keyword-only) with no metric guarding it. See #9956.

## Status

The deterministic scoring **foundation** (`metrics.ts`, landed in #10153) plus
the full **real-`@elizaos/core` harness + CI regression gate** are now in place.
The harness drives the genuine recall pipeline (no Python/mock reimplementation)
over a deterministic, seeded, labelled corpus and emits per-mode IR quality +
latency metrics with a budget gate.

- `metrics.ts` / `metrics.test.ts` — Precision@K, Recall@K, MRR, nDCG@K,
  HitRate@K, nearest-rank latency percentiles, and `summarizeRecall()`. Pure
  functions, no I/O. Honesty contract from `memperf`: unmeasured rows are `null`
  (never `0`); a summary is `measured: true` only when ≥1 query was scored.
- `concept-lexicon.ts` + `corpus-gen.ts` — deterministic (seed 42) concept-centric
  corpus + query generator. Relevance is defined **by construction** (topic/concept
  cluster membership), so labels need no hand-judging. Tiers: `small`
  (160 fragments / 80 queries) and `standard` (1040 fragments / 200 queries);
  regenerates byte-identically.
- `recall-harness.ts` — boots a **real** `AgentRuntime` + `@elizaos/plugin-sql`
  (PGlite, in-process) + the real `documentsPlugin`, registers a deterministic
  content-hash `TEXT_EMBEDDING` model, ingests the corpus through the real
  `DocumentService.addDocument` path, then runs each `SearchMode`, the low-level
  `runtime.searchMemories` + `embedRecallQuery` path, the `scoreMemoryText`
  keyword chat-search surface, and the forced fail-open path.
- `recall-kpi.ts` — per-mode metrics + the **HARD fail-open regression assertion**
  (force `embedRecallQuery → null`, assert hybrid/vector recall collapses to the
  keyword baseline) + the budget regression gate (quality floors `≥`, latency
  ceilings `≤`). Exit `0` budgets pass · `1` regression · `2` nothing measurable.
- `budgets.json` — committed quality floors + latency ceilings, gated in CI.

### Work-order completion (the checklist #10153 left open)

- [x] Driver ingesting a document-scale corpus through the **real** `DocumentService`
      (no Python/mock reimpl) + a query set with ground-truth relevant fragment ids.
- [x] Per-mode emission (hybrid / vector / keyword) so the hard-coded
      `HYBRID_VECTOR_WEIGHT 0.6 / 0.4` and the fail-open degradation are each quantified.
- [x] Fail-open assertion: force `embedRecallQuery → null` and assert recall drops
      to the keyword baseline (hard gate).
- [x] Keyword chat-search surface (`scoreMemoryText`) scored separately.
- [x] Registered in `registry/commands.py` + `registry/scores.py`; `recall-bench.yml`
      CI lane + committed `budgets.json`, mirroring `memperf`.
- [ ] **FACTS-provider recall slice** — documented follow-up (the four other recall
      surfaces fully exercise the path; `factsProvider` is not on the top-level barrel).

## Run

```bash
# Pure metric/schema unit tests (no workspace install needed):
bun test --conditions=eliza-source packages/benchmarks/recall-bench/metrics.test.ts
bun test --conditions=eliza-source packages/benchmarks/recall-bench/metric-schema.test.ts

# Real-runtime regression test (boots PGlite + real DocumentService):
bun test --conditions=eliza-source packages/benchmarks/recall-bench/recall-eval.test.ts

# Full harness + budget gate (deterministic; key-free):
bun run bench:recall            # node run-all.mjs → dashboard + exit-code gate
bun run bench:recall:json       # JSON to stdout
RECALL_TIER=standard bun run bench:recall   # 1040-fragment tier (default: standard)
```

## Embedding model

The harness registers a **deterministic content-hash** `TEXT_EMBEDDING` model
(384-dim, L2-normalised bag-of-token sha256). It is registered through the real
`Plugin.models` layer, so `DocumentService` / `embedRecallQuery` / ingestion all
dispatch to it exactly as they would a cloud model — this **is** the real recall
path, just reproducible and key-free, which makes it a reliable CI regression
gate. An optional real-provider embedding mode (OpenAI 1536 / local gte-small
384) for absolute semantic-quality numbers is a documented follow-up.

## Exit codes (mirrors `memperf`)

- `0` — measured rows present, all budgets pass.
- `1` — a quality floor missed, a latency ceiling crossed, or the fail-open
  regression became observable beyond its delta budget (the gate).
- `2` — nothing measurable on this host; deterministic self-check passed → skip.
