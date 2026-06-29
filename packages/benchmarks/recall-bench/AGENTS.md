# @elizaos/recall-bench

Precision/Recall/nDCG/latency benchmark + CI gate for the **real** memory-recall
+ knowledge-retrieval pipeline (#9956). Drives shipped `@elizaos/core` code over
a committed, document-scale, labeled corpus — see [README.md](./README.md) for
the what/why and the committed baseline.

## Layout

```
metrics.ts        Pure IR metrics (P@K/R@K/MRR/nDCG/HitRate, percentiles) + summarizeRecall()
embedding.ts      Deterministic feature-hash embedding (FNV-1a tokens + char trigrams, L2-norm, 384d)
corpus.ts         buildCorpus(tier) + buildFacts(tier) + buildMorphologyCorpus() — labeled, deterministic PRNG
runtime.ts        buildBenchRuntime() — real AgentRuntime + plugin-sql/PGlite + DocumentService
run.ts            The runner: ingest → drive every SearchMode → emit report → budget gate (exit 0/1/2)
budgets.json      Committed per-mode floors + min observable fail-open drop (1k baseline + ~20% headroom)
baseline-1k.json  Committed reference metrics (the "before/after" artifact)
scripts/check-registry.py   Orchestrator-registration contract check (CI)
*.test.ts         Unit tests for the pure pieces + corpus design invariants
```

Run: `bun run bench:recall` (smoke) / `bun run bench:recall:1k` (gate) from the
repo root, or `bun run --cwd packages/benchmarks/recall-bench test` for units.

## Why these exact construction choices (do not "simplify" them away)

- **The morphology slice (`buildMorphologyCorpus` + `keyword-morph-*`) uses
  untagged real English families** because the main corpus's numeric-tagged
  tokens (`configure0`) defeat Porter2 (its suffix rules need a real
  letter-ending), so the main corpus CANNOT measure stemming. Each family's `-ing`
  query form is absent from its docs but shares their Porter stem → unstemmed BM25
  scores 0, stemmed BM25 matches. **Verify every form's stem offline before adding
  a family** (Porter doesn't strip prefixes — `reconfigure`→`reconfigur` — and
  drifts on irregulars/derivations — `analysis`→`analysi`≠`analyz`, `ran`≠`run`);
  keep the per-family stems mutually disjoint and distinct from any distractor.
- **`rankByKeyword` uses the `search.ts` `BM25` (with `{stemming:true}`), not the
  documents `bm25Scores`** — only the former has Porter2 stemming, a stop-word
  list, and Unicode/accent normalization (the documents tokenizer's `[^a-z0-9]`
  strip silently drops accented + CJK text). It is index-built per call; callers
  re-sort, so input order isn't relied on.
- **PGlite via `@elizaos/plugin-sql`, not `InMemoryDatabaseAdapter` or
  `plugin-inmemorydb`.** Core's in-memory `searchMemories` is a stub that returns
  `[]`; `plugin-inmemorydb` overwrites `metadata.type` with the table name, so
  `DocumentService` filters out every fragment. Only PGlite gives real pgvector
  cosine while preserving `metadata.type` — and it is embedded WASM (no server,
  no secrets).
- **`DocumentService.start(runtime)` directly**, not `runtime.getService("documents")`
  — the service getter is gated by `isNativeFeatureServiceEnabled`, off in a bare
  benchmark runtime. `start()` drives the same ingest/search code.
- **`addDocument({ content })` must be base64-encoded** (`Buffer.from(text).toString("base64")`).
  The text path base64-decodes `content` as a heuristic; raw text misfires it
  ("File … appears to be corrupted or incorrectly encoded").
- **Passing `query` to `runtime.searchMemories` triggers a BM25 rerank that
  *drops* zero-keyword-overlap candidates** (`rerankMemories` → `search.ts` BM25,
  `if (score <= 0) continue`). The raw-vector slice omits `query` to measure pure
  cosine. This bench *caught* DocumentService's `vector`/`hybrid` modes passing
  `query` (and `limit`, which the adapter ignores in favour of `count` → a silent
  10-fragment pool) — two structural bugs that throttled document-vector to 0.715
  vs the 0.965 cosine ceiling. Both are fixed in `service.ts`; the committed
  baseline reflects the corrected pipeline.
- **The fail-open slice calls `runtime.startRun()` before flipping the embedder
  to throw.** `embedRecallQuery` memoizes successful query vectors per run id; a
  fresh run id busts that cache so the throw actually reaches `_vectorSearch` and
  the keyword fall-open is observed (otherwise the drop reads as 0).

## Determinism contract

Every number is reproducible run-to-run: seeded `mulberry32` corpus, deterministic
`embedText`, deterministic pgvector cosine. **Never** introduce `Date.now()` /
`Math.random()` / wall-clock into the corpus or embedding — it would flake the CI
gate. (Latency is timed with `performance.now()` and only feeds p50/p95, never
ranking.) Honesty contract from `memperf`: unmeasured rows are `null`, never `0`;
`measured: true` only on a real run.

## Gotchas

- Run with `bun --conditions=eliza-source` so `@elizaos/*` resolves to workspace
  source; the runner calls `process.exit()` (lingering DB/task services otherwise
  keep the event loop alive).
- Fresh checkout: `bun run --cwd packages/shared build:i18n` first — the bench
  imports `@elizaos/core` source, which needs the generated keyword data.
- `factsProvider` is internal to core (not on the public barrel); the bench
  imports it via a relative source path — a benchmark legitimately reaches into
  the same tree to measure it.

Repo-wide rules (logger-only, ESM, naming) live in the root
[AGENTS.md](../../../AGENTS.md).
