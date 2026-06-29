# recall-bench — agent guide

CI-gated benchmark over the **real `@elizaos/core` memory-recall pipeline**
(issue #9956). Mirrors `../memperf/` structurally (TS harness spawned by an
`.mjs` orchestrator, `budgets.json` exit-code gate, null-not-zero honesty
contract) but, unlike memperf, **is registered** in the orchestrator
(id `recall_bench`).

## Layout

```
ir-metrics.ts / .test.ts   IR metrics (P/R/MRR/nDCG/HitRate) + known-value unit test
concept-lexicon.ts         shared topic/concept vocab (corpus + embedding agree on it)
corpus-gen.ts              deterministic seeded (42) templated corpus + query generator
recall-harness.ts          boots inline runtime + concept-hash embedding + documentsPlugin
                           + plugin-sql (PGlite), ingests, runs each recall mode
recall-kpi.ts              main entry: per-mode metrics + HARD fail-open regression + gate
metric-schema.mjs / .test  frozen versioned schema + skippedRow (every numeric null)
recall-eval.test.ts        CI-safe real-runtime regression test
lib.mjs / run-all.mjs      record/load helpers; orchestrator that propagates the exit code
budgets.json               quality floors + latency ceilings + fail-open cap
tsconfig.check.json        standalone typecheck
fixtures/                  materialized small corpus (regenerable from corpus-gen.ts)
```

## Run

```bash
bun test packages/benchmarks/recall-bench/ir-metrics.test.ts          # no install needed
bun test --conditions=eliza-source packages/benchmarks/recall-bench/recall-eval.test.ts
bun run bench:recall                                                   # node run-all.mjs
node packages/benchmarks/recall-bench/run-all.mjs --tier standard      # >=1k fragments
bun --conditions=eliza-source packages/benchmarks/recall-bench/recall-kpi.ts --smoke
```

`recall-eval.test.ts` and the harness import `@elizaos/core` SOURCE, so run them
under `bun --conditions=eliza-source`. A fresh checkout needs
`bun run --cwd packages/shared build:i18n` first (generates keyword data the
core source imports).

## Hard rules / gotchas (do NOT regress these)

- **No `package.json`** — recall-bench is not a workspace package (that's why
  `tsconfig.check.json` exists). Run with `bun`/`node`, not via turbo.
- **null, never 0** for unmeasured rows. `skippedRow` sets every numeric field
  null. The schema test pins this.
- **Each `bootHarness()` gets a FRESH in-memory PGlite** (unique `PGLITE_DATA_DIR`
  temp dir) AND closes + clears the process-global `pgLiteClientManager`
  singleton on `cleanup()`. Without both, the on-disk default `.eliza/.elizadb`
  and the shared singleton leak fragments across boots and corrupt recall numbers.
- **Embedding model registered BEFORE `runtime.initialize()`** — `ensureEmbeddingDimension`
  probes it (null params → zero vector of length 384).
- **Fail-open is toggled at runtime, not boot:** ingest with a healthy embedding,
  then set `boot.failSwitch.failing = true` so only QUERY-time embeds throw. If
  ingestion embeds also threw, no fragment would store and even keyword recall
  would be empty (not the fail-open behaviour under test).
- **Real-pipeline finding:** `runtime.searchMemories(..., { query })` BM25-reranks
  vector hits and drops zero-lexical-overlap candidates, capping `vector`/`hybrid`
  recall on pure-semantic queries. `runtime-vector` omits `query` (raw cosine) to
  isolate the embedding's true recall. Don't "fix" the vector/keyword closeness by
  removing the rerank from the measured `vector`/`hybrid` rows — that closeness is
  a real, reported property of the shipped pipeline.
- **Determinism:** the corpus generator is seeded (42) and must regenerate
  byte-identically. The concept lexicon is the single source of truth shared by
  the corpus generator AND the embedding — keep them in sync.

## Registry

Registered as `recall_bench` (CI lane `smoke`). Touch points if you rename/move:
`registry/commands.py` (builders + `BenchmarkDefinition`), `registry/scores.py`
(`_score_from_recall_bench_json`), `registry/__init__.py` (re-export + `__all__`),
`orchestrator/adapters.py` (`registry_dir_map["recall_bench"]="recall-bench"`),
`orchestrator/ci_coverage.py` (`CI_LANE_BY_BENCHMARK["recall_bench"]="smoke"`).
The harness emits top-level `metrics.overall_accuracy` (= hybrid recall@5) +
`metrics.total_tasks` (= #queries) for the scorer. After any registry edit run
`python -m pytest packages/benchmarks/tests/test_ci_coverage.py`.

## Definition of done

`bun test` (ir-metrics + metric-schema), `bun test --conditions=eliza-source
recall-eval.test.ts`, and `node run-all.mjs` (exit 0) all green; budgets in
`budgets.json` reflect a real baseline with margin; CI lane `.github/workflows/recall-bench.yml`
present.
