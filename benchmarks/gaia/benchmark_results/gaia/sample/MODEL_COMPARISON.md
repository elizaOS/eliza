# GAIA Benchmark - Model Comparison

**Dataset:** `sample`

This table compares results across all tested models for this dataset. Results are sorted by overall accuracy.

## Best per model

| Provider | Model | Overall | Level 1 | Level 2 | Level 3 | Questions | Errors | Tokens | Latency (s) |
|----------|-------|---------|---------|---------|---------|-----------|--------|--------|-------------|
| groq | llama-3.1-8b-instant | 100.0% | 100.0% | 100.0% | 100.0% | 5 | 0 | 1,706 | 0.3 |
| openai | gpt-4o-mini | 100.0% | 100.0% | 100.0% | 100.0% | 5 | 0 | 1,820 | 3.1 |
| anthropic | claude-3-5-haiku-20241022 | 0.0% | 0.0% | 0.0% | 0.0% | 1 | 1 | 0 | 0.3 |


## Latest run per model

| Provider | Model | Overall | Questions | Errors | Tokens | Latency (s) | Timestamp |
|----------|-------|---------|-----------|--------|--------|-------------|-----------|
| groq | llama-3.1-8b-instant | 0.0% | 5 | 0 | 238,724 | 20.0 | 2026-01-12T11:29:51.444743 |
| openai | gpt-4o-mini | 100.0% | 5 | 0 | 1,820 | 3.1 | 2026-01-12T00:35:40.591544 |
| anthropic | claude-3-5-haiku-20241022 | 0.0% | 1 | 1 | 0 | 0.3 | 2026-01-12T00:43:46.360335 |

## Notes

- This comparison is for a **non-official dataset source** (e.g. sample/jsonl).
- Official GAIA leaderboard scores are **not comparable** unless `--dataset gaia` is used.


---
*Updated automatically by ElizaOS GAIA Benchmark Runner*
