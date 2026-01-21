# Matching — Synthetic Personas + Match Matrices

This repo contains **synthetic personas** and **pairwise match matrices** for three domains:

- **Dating**
- **Cofounder matching**
- **Local meetup / friendship**

Everything is **self-contained** (no external services required).

## What’s included

- Persona datasets (SF + NYC) with:
  - required onboarding fields (name, age, location)
  - optional enrichment (interests, values, preferences, etc.)
  - multiple conversations (agent ↔ user)
  - extracted facts with evidence pointers into conversations
- Match matrices per domain with scores from **-100 to 100**
  - includes `topMatches` and `worstMatches` per persona for demos
- Benchmark pair lists:
  - `benchmarks.json`: generated top/bottom pairs from the matrix (great for demos; not independent ground truth)
  - `benchmarks_curated.json`: curated “known good/bad” pairs intended as human ground truth

See `docs/DATASET.md` for the full schema-level overview.

## Regenerate datasets

```bash
python3 scripts/generate_dataset.py
```

Outputs go to:

- `data/dating/*`
- `data/cofounders/*`
- `data/friendship/*`

## Verify datasets (recommended)

After regenerating, run:

```bash
python3 scripts/validate_dataset.py
python3 scripts/verify_benchmarks.py
python3 scripts/verify_curated_benchmarks.py
```

## Query matches (CLI)

```bash
python3 scripts/query_matches.py --domain dating --persona D-SF-001 --top 5
python3 scripts/query_matches.py --domain business --persona C-NY-033 --worst 5
```

## LLM reranking (dating)

This repo includes an optional LLM-based reranker that uses the deterministic score only for **coarse filtering**, then asks an LLM to produce a **ranked top 10** per persona.

Set a Groq API key and run:

```bash
export GROQ_API_KEY="..."
python3 scripts/llm_rerank_dating.py --model openai/gpt-oss-120b --topK 30
python3 scripts/evaluate_dating_rankings.py --llm data/dating/llm_rankings.json
```

## Schemas

- `schema/persona.schema.json`
- `schema/match-matrix.schema.json`

## Notes

- Personas are **fictional** and intended for demos, test harnesses, and evaluation.
- Score functions are deterministic and designed to create a wide spread of outcomes for benchmarking.

