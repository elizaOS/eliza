# Experience Bench — Agent Guide

Evaluates the elizaOS experience service: retrieval quality (Precision@K, Recall@K,
MRR, Hit Rate@K), reranking correctness, and end-to-end learn-then-apply cycle
effectiveness. Not registered in the suite registry — run directly.

## Run

```bash
# Default Eliza bridge mode (1000 memories, 100 retrievals, 20 learnings)
# Requires ELIZA_BENCH_URL and ELIZA_BENCH_TOKEN.
python run_benchmark.py

# Deterministic direct-service smoke (no LLM)
python run_benchmark.py --mode direct

# Custom scale
python run_benchmark.py --experiences 2000 --queries 200 --learning-cycles 50 --output results.json

# Agent mode alias for the same elizaOS TypeScript benchmark bridge
python run_benchmark.py --mode eliza-agent --provider groq --model qwen3-32b
```

## Smoke test (no API keys)

The explicitly selected `direct` mode runs entirely in-process without any LLM or external
service. It is the smoke path:

```bash
python run_benchmark.py --experiences 50 --queries 10 --learning-cycles 5
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint; `--mode direct\|eliza-agent\|eliza-bridge` |
| `elizaos_experience_bench/runner.py` | Direct benchmark execution loop |
| `elizaos_experience_bench/service.py` | In-process Python experience service (no TS dependency) |
| `elizaos_experience_bench/generator.py` | Synthetic experience + learning-scenario generator |
| `elizaos_experience_bench/evaluators/` | Retrieval, reranking, learning, and hard-case evaluators |
| `elizaos_experience_bench/types.py` | `BenchmarkConfig`, `BenchmarkResult`, metrics DTOs |
| `tests/` | pytest suite covering generator, evaluators, runner, and bridge |

## Notes

- Results write to the path given by `--output` (no default output directory; prints to stdout when omitted).
- The full campaign marks this cohort unsupported for three-harness publication:
  the CLI only owns the Eliza bridge and the Python service supplies memory.
- Bridge reports include expected/completed learning and retrieval counts; a
  generic acknowledgement is not accepted as a successful memory write.
- Reproducible by default: seeded RNG (`--seed 42`). Change with `--seed`.
- Full background: [README.md](README.md).
