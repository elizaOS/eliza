# recall-bench — evidence (#9956)

recall-bench drives the **real `@elizaos/core` recall pipeline** over a
deterministic labeled corpus and emits IR quality + latency per recall mode,
with a CI regression gate. All numbers below are from **real runs** on this
machine (macOS, Bun 1.4 canary), key-free (deterministic concept-hash
embedding). Nothing here is mocked or fabricated.

## Tests

| test | result |
| --- | --- |
| `metrics.test.ts` (foundation #10153, 19 tests, vitest) + `metric-schema.test.ts` (5 tests, bun) | **24 pass / 0 fail** |
| `recall-eval.test.ts` (real-runtime, 3 tests) | **3 pass / 0 fail** — see `recall-eval-test.log` |
| `tsc -p tsconfig.check.json` | clean (no errors) |
| `python -m pytest packages/benchmarks/tests/test_ci_coverage.py` | **4 pass** (registry wiring intact) |

`recall-eval.test.ts` asserts, against the real runtime: (a) pure-vector
recall@5 > keyword recall@5 on semantic (non-lexical) queries, and (b) forcing
the query embed to throw collapses hybrid & vector recall@5 to the keyword
baseline (fail-open observable).

## Standard tier (1040 fragments, 200 queries) — baseline metrics

Full report: `baseline-standard-metrics.json` (committed). Orchestrator gate:
`run-all-standard.log` (exit 0, all budgets PASS).

| mode | recall@5 | ndcg@10 | mrr | p95 |
| --- | --- | --- | --- | --- |
| hybrid (`searchDocuments`) | **0.553** | 0.693 | 0.710 | 7 ms |
| vector (`searchDocuments`) | **0.551** | 0.692 | 0.714 | 7 ms |
| keyword (`searchDocuments`) | 0.466 | 0.571 | 0.572 | 55 ms |
| runtime-vector (raw cosine, no rerank) | **0.787** | 0.966 | 0.964 | 6 ms |
| keyword-chat-search (`scoreMemoryText`) | 0.281 | 0.448 | 0.302 | 2 ms |

- **Vector/hybrid beat keyword** (0.55 vs 0.47); pure runtime-vector is strongest
  (0.79). nDCG@10 for runtime-vector is 0.97 — the embedding ranks the relevant
  cluster at the top almost perfectly.
- `metrics.overall_accuracy = 0.553` (hybrid recall@5), `metrics.total_tasks = 200`
  for the orchestrator scorer.

## Fail-open delta (HARD gate)

Forcing the query embed to throw → `embedRecallQuery` returns `null` →
`hybrid`/`vector` fail open to `_keywordSearch`:

```
fail-open recall@5  hybrid=0.466 vector=0.466 keyword=0.466 -> delta=0.0000
```

`failOpen.maxRecallDeltaAt5` budget = 0.001; measured delta = **0.000000** (PASS).
The path-level evidence (`failopen-path-evidence.log`) shows that on a
pure-synonym query the HEALTHY hybrid returns 0 hits (the in-process BM25 rerank
in `searchMemories(..., {query})` drops zero-overlap candidates), while the
fail-open hybrid returns 20 hits via the pure keyword fallback — i.e. the
fail-open path is genuinely exercised, not stubbed.

## Small tier (160 fragments, 80 queries) — CI self-check

`run-all-small.log` (exit 0). hybrid 0.675 / vector 0.672 / keyword 0.653 /
runtime-vector 0.947 / keyword-chat-search 0.503; fail-open delta 0.0000.

## Key real-pipeline finding

`runtime.searchMemories(..., { query })` BM25-reranks the vector candidates and
**drops any candidate with no lexical overlap with the query**, which caps
`DocumentService` `vector`/`hybrid` recall on pure-semantic queries. The
`runtime-vector` row (which omits `query`, so raw cosine, no rerank) isolates the
embedding's true semantic recall and is reported separately — the gap between
runtime-vector (0.79) and vector/hybrid (0.55) quantifies how much the rerank
suppresses non-lexical recall. This is a real, reported property of the shipped
pipeline, not a benchmark artifact.

## Honesty / reproducibility notes

- The embedding is a deterministic **concept-aware content-hash** model (384-dim),
  registered as a real `ModelType.TEXT_EMBEDDING` handler — the runtime dispatches
  to it exactly like a cloud model. Reproducible and key-free. An optional
  real-provider embedding (OpenAI/local-inference) is a documented follow-up.
- The corpus generator is seeded (42) and regenerates byte-identically (verified
  by SHA across runs). `fixtures/corpus.small.json` + `queries.small.json` are a
  materialized snapshot of the `small` tier.
- Unmeasured rows are `null`, never `0` (`metric-schema.test.ts` pins this).

## Environment caveat

Run on macOS with the local Bun toolchain. Embedding/DB are in-process (PGlite),
no network, no API keys. The same harness runs in CI via
`.github/workflows/recall-bench.yml` on `ubuntu-latest` after
`bun run --cwd packages/shared build:i18n` (the real core source needs generated
i18n keyword data in a fresh checkout — same prerequisite as the memperf lane).
