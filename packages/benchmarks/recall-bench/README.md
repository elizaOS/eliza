# recall-bench (#9956)

Precision / Recall / nDCG / latency benchmark for the agent's **memory-recall +
knowledge-retrieval** path, plus a CI regression gate. The repo measures
retrieval *cost* (`memperf`) and LLM *context-window* attention (`context_bench`)
but never retrieval *correctness* at document scale — and the recall path **fails
open** (a slow/errored embed silently degrades semantic recall to keyword-only)
with no metric guarding it. This bench closes that gap.

It drives the **real `@elizaos/core` code** — no Python re-implementation, no
mocked `searchMemories`:

- `DocumentService.searchDocuments` in all three `SearchMode`s (`hybrid` /
  `vector` / `keyword`), ingested through the real `DocumentService.addDocument`.
- `AgentRuntime.searchMemories` (the raw cosine path the providers ride).
- The `FACTS` provider (`factsProvider.get`) — keyword + recency, no vectors.
- `rankByKeyword` — the keyword chat-search surface (`memory-routes.ts`, BM25).
- A forced **fail-open**: `embedRecallQuery → null` (via a throwing query
  embedder) so `_vectorSearch` falls open to keyword, and the recall drop is
  measured.

The runtime is a real `AgentRuntime` backed by `@elizaos/plugin-sql` + **PGlite**
(embedded WASM Postgres with real pgvector cosine) — no DB server, no model
bundle, no credentials. The embedding is a deterministic in-bench function
(`embedding.ts`), so every number is **fully reproducible** run-to-run and on a
hosted CI runner.

## What it is NOT

The deterministic embedding measures **ranking-pipeline correctness** (does the
hybrid/vector/keyword/fail-open machinery rank the right fragments?), not
production embedding *quality*. It is a regression gate on the recall *code*, not
a leaderboard for an embedding model. That separation is deliberate: a real
embedding model would make the bench non-deterministic and credential-bound,
defeating the CI gate.

## Run

```bash
bun run bench:recall           # smoke tier (60 docs) — fast local check
bun run bench:recall:1k        # 1k tier — the document-scale CI gate
bun run --cwd packages/benchmarks/recall-bench test   # unit tests (pure pieces)
```

Or via the orchestrator (registered as `recall_bench` in `registry/commands.py`):
the command resolves to `bun --conditions=eliza-source run.ts --tier <tier>` with
`tier ∈ {smoke, 1k, 10k}`.

Exit codes follow the `memperf` contract: `0` budgets pass · `1` a budget
regressed (the gate) · `2` nothing measurable.

## Corpus (deterministic, committed as code)

`corpus.ts` generates a labeled corpus deterministically (seeded PRNG) — it is
committed *as code*, reproducible and diffable, rather than as a giant JSON
fixture. Three doc classes per topic make the metrics meaningful:

- **relevant** — the topic's ground-truth answers; carry the query's exact base
  token *and* extra same-root morphological forms (rich trigram mass).
- **confusable** — carry the same base token but a *foreign* body (disjoint
  roots). Keyword/BM25 can't tell them from relevant; the vector embedding sits
  far from the query. These are what a healthy vector pass ranks out and a
  fail-open keyword pass lets pollute the top-K — the mechanism that makes the
  fail-open a **measurable** recall drop.
- **noise** — disjoint roots, no query token; pad to document scale.

Tiers: `smoke` = 60 docs / 6 queries · `1k` = 1,000 / 40 · `10k` = 10,000 / 40.
Relevance is labeled at the *document* level (robust to how `DocumentService`
chunks each doc into fragments).

## Output (`results/recall-bench-results.json`, baseline in `baseline-1k.json`)

Per-`SearchMode` rows with Precision@5, Recall@5, MRR, nDCG@5, HitRate@5, p50/p95
latency, each `measured: true` only on a real run (`null`, never `0`, otherwise).
Plus the `failOpen` block (`vectorRecallAt5`, `failOpenRecallAt5`, `recallDrop`,
`observable`) and the budget `checks`.

### Committed 1k baseline (deterministic)

| mode | Recall@5 | nDCG@5 |
| --- | --- | --- |
| `document-hybrid` | 0.950 | 0.957 |
| `document-vector` | 0.965 | 0.974 |
| `document-keyword` | 0.370 | 0.422 |
| `searchMemories-vector` | 0.965 | 0.974 |
| `keyword-chat-bm25` | 0.370 | 0.422 |
| `facts-provider-keyword` | 1.000 | 1.000 |
| `document-vector-failopen` | 0.370 | 0.422 |

**Fail-open recall drop 0.595 (observable).** Hybrid/vector clearly out-recall
keyword; forcing the query embed to fail collapses `document-vector` (0.965) to
keyword level (0.370). The keyword chat-search (`keyword-chat-bm25`) now matches
the document-keyword BM25 ceiling (0.370) — keyword methods can't beat the
confusable distractors (that needs the vector path), exactly the
keyword-vs-semantic gap #9956 wants tracked.

### Three ranking issues this bench caught + fixed

**(a) `service.ts` document recall** — the first run exposed `document-vector` at
**0.715** while pure cosine (`searchMemories-vector`) hit **0.965** — a 25-point
gap *inside the ranking*, not the retrieval. Root cause, both structural (robust
to any embedding, not synthetic-embedding tuning):

The first run exposed `document-vector` at **0.715** while pure cosine
(`searchMemories-vector`) hit **0.965** — a 25-point gap *inside the ranking*,
not the retrieval. Root cause, both structural (robust to any embedding, not
synthetic-embedding tuning):

1. **`_vectorSearch`/`_hybridSearch` passed `limit:` but the adapter honours
   `count:`** → the candidate pool silently fell back to the default **10**
   fragments instead of the intended 20/40.
2. **They passed `query:` to `searchMemories`**, triggering a runtime BM25 rerank
   that **drops zero-keyword-overlap candidates** (`search.ts`,
   `if (score <= 0) continue`) — i.e. it silently keyword-filters the semantic
   results `vector` mode exists to return (the mode's own comment even says "Pure
   vector (cosine-similarity)"). Every other semantic-recall caller already omits
   `query`; document search was the lone outlier.

Fix (pure-vector candidates + `count`): **document-vector 0.715 → 0.965**,
**document-hybrid (the default) 0.880 → 0.950**. The parametric knobs
(`HYBRID_VECTOR_WEIGHT` 0.6/0.4, `match_threshold`) are deliberately **left
alone** — their optimum depends on the real embedding's cosine distribution, so
tuning them against this deterministic embedding would overfit, not improve.

**(b) Keyword chat-search** — `scoreMemoryText` was a pairwise substring +
term-presence count with **no IDF**, so at document scale filler/common words
tied with real hits and it collapsed to **0.095**. Replaced with corpus-aware
BM25 (`rankByKeyword`, reusing the existing `bm25Scores`): **keyword-chat 0.095 →
0.370**, now equal to the document-keyword BM25 ceiling. It deliberately does
*not* climb past 0.370 — the confusable distractors are keyword-indistinguishable
by design, so beating them requires the vector path, not a keyword hack.

**(c)** The `match_threshold` / hybrid-weight knobs are intentionally untouched
(see above) — chasing the benchmark number by tuning them would overfit the
synthetic embedding rather than improve production retrieval.

## Budgets & CI

`budgets.json` holds per-mode floors (Recall@5 / nDCG@5 / p95) and a minimum
observable fail-open drop, calibrated to the 1k baseline with ~20% headroom.
`.github/workflows/recall-bench.yml` runs the unit tests, the registry-contract
check (`scripts/check-registry.py`), and the 1k gate; it turns red when a budget
is crossed (e.g. a bad hybrid-weight change, or semantic recall silently
collapsing into keyword).

## Files

- `metrics.ts` / `metrics.test.ts` — pure IR metrics + `summarizeRecall()`.
- `embedding.ts` / `embedding.test.ts` — deterministic feature-hash embedding.
- `corpus.ts` / `corpus.test.ts` — the labeled corpus + facts + design invariants.
- `runtime.ts` — the real `AgentRuntime` + PGlite + `DocumentService` harness.
- `run.ts` — the runner (ingests, drives every mode, emits the report, gates).
- `budgets.json` / `baseline-1k.json` — committed budgets + reference metrics.
- `scripts/check-registry.py` — orchestrator-registration contract check.
