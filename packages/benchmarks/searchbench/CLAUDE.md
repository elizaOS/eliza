# searchbench — agent guide (#13534)

Regression benchmark for corpus-wide chat message search (Postgres FTS +
`pg_trgm`) against a **real** ≥10k-message PGlite store. Full usage, metrics,
and exit codes are in [`README.md`](README.md); this file is the agent-facing
map.

## Layout

- `searchbench-kpi.ts` — measuring harness. Runs under
  `bun --conditions=eliza-source` because it imports the real
  `@elizaos/plugin-sql` PGlite adapter + `DatabaseMigrationService` (which
  installs the `eliza_message_search_document` FTS + trigram GIN indexes) and
  calls the real `IDatabaseAdapter.searchMessages`. Seeds a deterministic
  corpus, evaluates a labeled gold set, emits `results/searchbench/latest.json`.
- `run-all.mjs` — orchestrator (pure Node). Spawns the harness, writes
  `results/summary/`, propagates the harness exit code so CI gates on it.
- `metric-schema.mjs` — per-query + aggregate metric shape and `ndcgAtK`.
- `budgets.json` — regression budgets (recall/precision/MRR/nDCG/latency/index).
- `lib.mjs` — shared Node helpers.

## Contract (mirrors memperf)

- A metric is `measured:true` only when a real query produced it. Unmeasured →
  `null`, never `0`. No fabricated rows.
- Exit `0` = all budgets pass, `1` = a measured budget regressed, `2` = nothing
  measurable (genuine environment failure) — never a false green.
- Gold cases use rare unique tokens so filler noise can never satisfy them;
  recall/precision then isolate search behaviour, not lexical luck.

## Gotchas

- The harness resolves `@elizaos/*` from source via `--conditions=eliza-source`;
  running it under plain `node`/`bun` without that condition will fail to import
  the PGlite adapter.
- `pg_trgm` is available in the bundled PGlite; the partial-word gold case
  depends on it. If a future PGlite build drops it, `searchMessages` degrades to
  FTS + unindexed `LIKE` (correct, slower) and the partial case may slow, not
  break.
