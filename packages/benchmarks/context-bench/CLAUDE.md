# Context-Bench — Agent Guide

Needle-in-a-haystack (NIAH), semantic NIAH, multi-hop context retrieval, and
conversation-compaction drift benchmark. Registered in the suite registry as
`context_bench`. Query path always routes through the elizaOS TypeScript
benchmark server (eliza adapter) — direct OpenAI/Anthropic/mock modes were
removed in favour of the TS bridge.

## Run

```bash
# Direct, from this directory (full matrix via eliza TS bridge)
python run_benchmark.py --provider eliza

# Quick mode: NIAH-basic only, 2 lengths × 3 positions × 2 tasks
python run_benchmark.py --provider eliza --quick

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks context_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
python run_benchmark.py --provider mock
```

The `mock` provider uses a deterministic local regex-based query function — no
API calls, no TS bridge.

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint; parses args, starts/stops eliza TS bridge |
| `elizaos_context_bench/runner.py` | Main benchmark execution loop |
| `elizaos_context_bench/suites/niah.py` | NIAH + semantic NIAH suite |
| `elizaos_context_bench/suites/multihop.py` | Multi-hop reasoning suite |
| `elizaos_context_bench/drift.py` | Conversation-compaction drift suite (aggregates TS harness JSONL) |
| `elizaos_context_bench/generator.py` | Context and needle generation |
| `elizaos_context_bench/evaluators/` | Retrieval + position (lost-in-the-middle) evaluators |
| `elizaos_context_bench/reporting.py` | ASCII heatmap + markdown report generation |
| `elizaos_context_bench/types.py` | Core type definitions |
| `tests/` | pytest suite |

## Notes

- Results write to `./benchmark_results/` (prefix `context_bench_*.json`).
- Scored by `_score_from_contextbench_json` in `registry/scores.py`.
- Drift harness (TypeScript): `scripts/benchmark/drift-harness.ts`. Dry-run
  mode is deterministic and requires no API keys; real runs use an
  OpenAI-compatible chat-completions endpoint.
- Optional extras: `pip install -e ".[embeddings]"` for semantic similarity
  scoring; `pip install -e ".[drift]"` for Python drift aggregation helpers.
- Full background and configuration reference: [README.md](README.md).
