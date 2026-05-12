# Memory Retrieval System Architecture

**Version:** 1.4.2  
**Last Updated:** 2024-05-20  
**Owner:** Memory Retrieval Team  

## Overview

The Memory Retrieval System is responsible for selecting and returning relevant memory entries from the memory store in response to user queries. The system processes approximately 500 queries per day against a store of ~200 seed memory entries spanning from January 2023 to present.

The retrieval pipeline consists of five sequential stages, each configured via `config/retrieval_config.yaml` and `config/scoring_weights.json`.

---

## Pipeline Stages

### Stage 1: Keyword Matching

The query is tokenized and matched against the inverted keyword index (`data/keyword_index.json`). Each memory entry receives a keyword match score based on the number and specificity of matching keywords.

- **Input:** Raw query string
- **Output:** Candidate pool of memory entries with keyword match scores
- **Typical candidate pool size:** 60–120 entries

### Stage 2: Seed Selection (Top-K)

From the candidate pool, the top-K entries are selected as "seeds" based on a composite score. The active weight names and numeric coefficients live in `config/scoring_weights.json` (single source of truth for the current formula).

- **Parameter:** `seed_quota` (default: 10)
- **Input:** Candidate pool with keyword scores
- **Output:** K seed memory entries

### Stage 3: Context Expansion (±N)

Each seed is expanded by retrieving the N entries immediately before and after it in chronological order. This provides conversational context around each seed memory.

- **Parameter:** `context_window` (default: 3)
- **Input:** K seed entries
- **Output:** Up to K × (2N + 1) entries (with potential overlaps)
- **Example:** With 10 seeds and context_window=3, maximum expansion is 10 × 7 = 70 entries

### Stage 4: Deduplication

When context windows of nearby seeds overlap, duplicate entries are removed according to the configured dedup strategy.

- **Parameter:** `dedup_strategy` (default: `keep_first`)
- **Strategies available:**
  - `keep_first`: Retain the entry from the first seed's window encountered
  - `keep_highest_score`: Retain the copy with the highest composite score
  - `merge`: Merge metadata from all copies (not yet implemented)
- **Typical reduction:** 5–15 entries removed

### Stage 5: Truncation and Sorting

The deduplicated result set is ordered using `sort_order`, then reduced so its size does not exceed `max_total_results`. Authoritative numeric and enum values for this deployment are in `config/retrieval_config.yaml`.

- **Parameters:** `max_total_results`, `sort_order`
- **Input:** Deduplicated entries (cardinality depends on seed quota, context window, and overlap)
- **Output:** Final bounded result set returned to callers

**Operations note:** When the post-expansion set is larger than the configured cap, the interaction of ordering, truncation, and upstream scoring determines which entries survive. Treat `docs/system_architecture.md` as a map of stages—not a substitute for reading the active YAML/JSON, logs (`DROP_AFTER_TRUNCATION` and related markers), `data/query_test_cases.csv`, and `reports/precision_analysis.csv` when diagnosing “missing” memories.

---

## Data Flow Diagram

```
Query
  │
  ▼
[Stage 1: Keyword Matching] ──→ Candidate Pool (~80-120 entries)
  │
  ▼
[Stage 2: Seed Selection]   ──→ Top-10 Seeds
  │
  ▼
[Stage 3: Context Expansion] ──→ ~70 entries (with overlaps)
  │
  ▼
[Stage 4: Deduplication]    ──→ ~58 entries (overlaps removed)
  │
  ▼
[Stage 5: Truncation]       ──→ Final result set (≤ max_total_results)
  │
  ▼
Final Result Set
```

## Configuration Files

| File | Purpose |
|------|---------|
| `config/retrieval_config.yaml` | Pipeline parameters (quotas, windows, limits) |
| `config/scoring_weights.json` | Composite scoring weights |
| `data/keyword_index.json` | Inverted keyword index |
| `data/memory_store.json` | Full memory store |

## Known Issues

1. **Bucket-level precision spread:** Average precision varies by time bucket; see `reports/precision_analysis.csv`. Use `data/query_test_cases.csv` for per-query drill-down.

2. **Context window overlap:** Seeds that are close in ID space can produce overlapping windows, affecting how many distinct entries compete for the final cap.

3. **No explicit seed-survival mechanism:** The design does not allocate guaranteed final slots per Stage-2 seed; use logs to confirm which seeds appear in the returned set after assembly.

## Metrics

Current system precision by time bucket (from `reports/precision_analysis.csv`):

| Time Bucket | Precision | Recall |
|-------------|-----------|--------|
| Q1-2023     | 0.31      | 0.28   |
| Q2-2023     | 0.42      | 0.38   |
| Q3-2023     | 0.55      | 0.51   |
| Q4-2023     | 0.68      | 0.62   |
| Q1-2024     | 0.82      | 0.78   |
| Q2-2024     | 0.91      | 0.88   |
