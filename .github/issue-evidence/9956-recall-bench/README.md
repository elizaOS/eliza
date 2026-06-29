# Evidence — recall-bench (#9956)

A registered, document-scale, CI-gated Precision/Recall/nDCG/latency benchmark for
the **real** `@elizaos/core` memory-recall + knowledge-retrieval path. All numbers
come from driving shipped code (`DocumentService.searchDocuments`,
`AgentRuntime.searchMemories`, `factsProvider.get`, `rankByKeyword`) over a
committed labeled corpus ingested through the real `DocumentService.addDocument`
— no Python re-implementation, no mocked `searchMemories`.

## Reproduce

```bash
bun run --cwd packages/shared build:i18n        # fresh checkout: generated keyword data
bun run bench:recall:1k                          # the document-scale CI gate
bun run --cwd packages/benchmarks/recall-bench test   # unit tests
python3 packages/benchmarks/recall-bench/scripts/check-registry.py   # orchestrator registration
```

The embedding is a deterministic in-bench function (no model bundle, no
credentials), so every number is byte-reproducible run-to-run and on CI.

## Artifacts

| file | what it proves |
| --- | --- |
| `metrics-1k.json` | Committed before/after metrics JSON: per-`SearchMode` P@K/R@K/MRR/nDCG/HitRate + p50/p95 over the 1,000-doc corpus, `measured:true` only on a real run (`null`, never `0`, otherwise). Mirrors `packages/benchmarks/recall-bench/baseline-1k.json`. |
| `run-1k.stdout.txt` | The real 1k run: per-mode recall/nDCG/p95 and `budgets PASS (16/16)`. |
| `failopen-path.debug.txt` | Backend `[CORE:DOCUMENTS:RECALL-EMBED]` structured logs (`LOG_LEVEL=debug`) showing `embedRecallQuery` returning null and `_vectorSearch` failing open to keyword — **once per query** in the forced fail-open slice. |

## Headline result (1k tier, deterministic — after the ranking fix)

| mode | Recall@5 | nDCG@5 |
| --- | --- | --- |
| `document-hybrid` | 0.950 | 0.957 |
| `document-vector` | 0.965 | 0.974 |
| `document-keyword` | 0.370 | 0.422 |
| `searchMemories-vector` | 0.965 | 0.974 |
| `keyword-chat-bm25` | 0.510 | 0.547 |
| `facts-provider-keyword` | 1.000 | 1.000 |
| `document-vector-failopen` | 0.370 | 0.422 |
| `keyword-morph-stemmed` | 1.000 | 1.000 |
| `keyword-morph-unstemmed` | 0.050 | 0.036 |

**Fail-open recall drop = 0.595 (observable); stemming recall lift = 0.950
(observable).** Forcing `embedRecallQuery → null` collapses `document-vector`
(0.965) to keyword level (0.370). On the morphology slice, Porter2 stemming lifts
keyword recall 0.050 → 1.000 — both silent degradations #9956 names, now gated.

### Ranking issues this bench caught + fixed

The parametric knobs (hybrid 0.6/0.4 weight, `match_threshold`) are left untouched
(embedding-specific → tuning on the deterministic embedding would overfit).

| metric | before | after |
| --- | --- | --- |
| `document-vector` | 0.715 | **0.965** |
| `document-hybrid` (default) | 0.880 | **0.950** |
| `keyword-chat` ranking | 0.095 | **0.510** |
| keyword stemming lift | (unmeasured) | **0.950** |
| fail-open drop | 0.345 | **0.595** |

- **`plugin-sql` + `core/.../documents/service.ts` (document recall)** —
  `_vectorSearch`/`_hybridSearch` passed `limit:` (the adapter ignored it, honouring
  `count:` → pool silently capped at 10) and `query:` (a runtime BM25 rerank that
  drops zero-overlap candidates, silently keyword-filtering the semantic results
  `vector` mode exists for). Fix: honour `limit` in plugin-sql + drop `query`. Core
  search tests green (25/25).
- **`agent/.../memory-routes.ts` (keyword chat-search)** — `scoreMemoryText`
  (pairwise substring + term-presence, **no IDF**) collapsed to 0.095; replaced
  with `rankByKeyword` on the `search.ts` BM25 (Porter2 stemming + stop-words +
  Unicode). keyword-chat 0.095 → 0.510; the new `keyword-morph-*` slice isolates
  the stemming lift (unstemmed 0.050 → stemmed 1.000). The 3 ranking callers move
  to batch BM25; the browse *filter* keeps boolean term-matching. Caller contract
  tests green (7/7).

## Evidence checklist (PR_EVIDENCE.md)

- **Real-runtime trajectory** — `run-1k.stdout.txt` + `metrics-1k.json`: the real
  `searchMemories`/`DocumentService` path over the 1k corpus (not a mock).
- **Backend logs** — `failopen-path.debug.txt`: structured `[CORE:DOCUMENTS:RECALL-EMBED]`
  logs showing the path taken, including the forced fail-open run.
- **Before/after metrics JSON** — `metrics-1k.json` + committed `budgets.json`.
- **Screenshots / video / audio** — N/A: this is a benchmark/CI harness with no UI
  or voice surface; the metrics JSON, the budget gate, and `recall-bench.yml` are the
  verifiable artifacts.
