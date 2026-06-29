# Recall-Bench KPI Dashboard

Generated: 2026-06-29T17:39:09.456Z

Status: **PASS**

## Run

- tier: standard (seed 42), docs: 1040, queries: 200, fragments: 1040
- embedding: deterministic-content-hash-384
- measured: 5 modes, skipped: 0 modes
- fail-open recall@5 delta: 0.0000 (keyword baseline recall@5: 46.6%)

## Per recall mode

| mode | measured | recall@5 | ndcg@10 | mrr | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- |
| hybrid | yes | 55.3% | 69.3% | 0.710 | 6 ms | 7 ms |
| vector | yes | 55.1% | 69.2% | 0.714 | 6 ms | 6 ms |
| keyword | yes | 46.6% | 57.1% | 0.572 | 51 ms | 56 ms |
| runtime-vector | yes | 78.7% | 96.6% | 0.964 | 6 ms | 6 ms |
| keyword-chat-search | yes | 28.1% | 44.8% | 0.302 | 2 ms | 2 ms |

## Budget checks

- PASS hybrid.recallAt5: 55.3% / ≥ 45.0%
- PASS hybrid.ndcgAt10: 69.3% / ≥ 55.0%
- PASS hybrid.latencyMsP95: 7 ms / ≤ 200 ms
- PASS vector.recallAt5: 55.1% / ≥ 45.0%
- PASS vector.ndcgAt10: 69.2% / ≥ 55.0%
- PASS vector.latencyMsP95: 6 ms / ≤ 200 ms
- PASS keyword.recallAt5: 46.6% / ≥ 35.0%
- PASS keyword.ndcgAt10: 57.1% / ≥ 45.0%
- PASS keyword.latencyMsP95: 56 ms / ≤ 300 ms
- PASS runtime-vector.recallAt5: 78.7% / ≥ 65.0%
- PASS runtime-vector.ndcgAt10: 96.6% / ≥ 85.0%
- PASS runtime-vector.latencyMsP95: 6 ms / ≤ 200 ms
- PASS selfCheck.minRecallAt5: 55.3% / ≥ 30.0%
- PASS failOpen.maxRecallDeltaAt5: 0.0% / ≤ 0.1%

---

Budgets live in `budgets.json`. Ratchet floors up as the recall pipeline improves.
