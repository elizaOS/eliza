# searchbench — chat message search at scale (#13534)

Regression benchmark for corpus-wide chat message search: Postgres FTS
(`websearch_to_tsquery` + `ts_rank_cd`) with a `pg_trgm` partial-word fallback,
measured against a **real** ≥10,000-message PGlite store. Follow-up to the
shallow `ILIKE` keyword search shipped in #9955.

## What it proves

- **Retrieval quality** over a labeled gold set of edge cases (multi-word
  non-adjacent, partial-word/trigram, accent fold, quoted phrase vs OR, URL,
  emoji, CJK, attachment filename, near-duplicate, and the older-than-any-recency-
  window hit): precision@10, recall@10, MRR, nDCG@10.
- **Latency** of the index-backed hot path: p50 / p95 / max query time. The
  searchable document is a STORED generated column (`message_search_document`),
  so no query recomputes the fold/attachment function per row. The latency
  budget is capability-aware: with `pg_trgm` the partial/substring fallback is a
  trigram-GIN index scan (tight budget, cloud/production); without it (the
  bundled PGlite build) that fallback scans the stored column (relaxed budget,
  ~10x slower under WASM). Both still catch the pre-materialization
  O(n)-recompute regression that made p95 ≈ 11s.
- **Index build time** (`REINDEX` of the FTS GIN index on the full corpus).

## Honesty contract

A metric is `measured:true` only when a real `searchMessages` call against the
real store produced it. Unmeasured metrics are `null`, never `0` — a fabricated
zero recall would silently pass a budget. The run exits non-zero when a measured
budget in `budgets.json` regresses; it exits `2` (nothing measurable) only on a
genuine environment failure, never as a false green.

## Run

```bash
node packages/benchmarks/searchbench/run-all.mjs          # dashboard + gate
node packages/benchmarks/searchbench/run-all.mjs --json   # machine-readable

# harness alone (writes results/searchbench/latest.json):
bun --conditions=eliza-source packages/benchmarks/searchbench/searchbench-kpi.ts
```

Env knobs: `SEARCHBENCH_CORPUS` (default 10000), `SEARCHBENCH_LATENCY_REPEATS`
(default 5), `POSTGRES_URL` is not used — the harness always drives PGlite.

## Files

- `searchbench-kpi.ts` — the measuring harness (real PGlite adapter + migrations,
  corpus generation, gold-set evaluation).
- `metric-schema.mjs` — the per-query + aggregate metric schema and `ndcgAtK`.
- `budgets.json` — regression budgets the harness gates on.
- `run-all.mjs` — orchestrator; spawns the harness, writes `results/summary/`.
- `lib.mjs` — shared Node helpers (quantiles, result persistence, git info).

## Exit codes

| code | meaning |
| --- | --- |
| 0 | measured gold set present, all budgets pass |
| 1 | a budget regressed (recall/precision/MRR/nDCG/latency/index-build) |
| 2 | nothing measurable (PGlite/import failure) — no false green |
