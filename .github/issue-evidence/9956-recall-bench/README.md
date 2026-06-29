# Evidence — recall-bench (#9956)

A registered, document-scale, CI-gated Precision/Recall/nDCG/latency benchmark for
the **real** `@elizaos/core` memory-recall + knowledge-retrieval path. All numbers
come from driving shipped code (`DocumentService.searchDocuments`,
`AgentRuntime.searchMemories`, `factsProvider.get`, `scoreMemoryText`) over a
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

## Headline result (1k tier, deterministic)

| mode | Recall@5 | nDCG@5 |
| --- | --- | --- |
| `document-hybrid` | 0.880 | 0.864 |
| `document-vector` | 0.715 | 0.684 |
| `document-keyword` | 0.370 | 0.422 |
| `searchMemories-vector` | 0.965 | 0.974 |
| `keyword-chat-scoreMemoryText` | 0.095 | 0.125 |
| `facts-provider-keyword` | 1.000 | 1.000 |
| `document-vector-failopen` | 0.370 | 0.422 |

**Fail-open recall drop = 0.345 (observable).** Forcing `embedRecallQuery → null`
collapses `document-vector` (0.715) to keyword level (0.370) — the silent
degradation #9956 names, now measured and gated. `scoreMemoryText` degrades sharply
at document scale (0.095), making the keyword-vs-semantic gap explicit.

## Evidence checklist (PR_EVIDENCE.md)

- **Real-runtime trajectory** — `run-1k.stdout.txt` + `metrics-1k.json`: the real
  `searchMemories`/`DocumentService` path over the 1k corpus (not a mock).
- **Backend logs** — `failopen-path.debug.txt`: structured `[CORE:DOCUMENTS:RECALL-EMBED]`
  logs showing the path taken, including the forced fail-open run.
- **Before/after metrics JSON** — `metrics-1k.json` + committed `budgets.json`.
- **Screenshots / video / audio** — N/A: this is a benchmark/CI harness with no UI
  or voice surface; the metrics JSON, the budget gate, and `recall-bench.yml` are the
  verifiable artifacts.
