# Experience Bench — Agent Guide

Evaluates the elizaOS experience service: retrieval quality (Precision@K, Recall@K,
MRR, Hit Rate@K), reranking correctness, and end-to-end learn-then-apply cycle
effectiveness. Not registered in the suite registry — run directly.

## Run

```bash
# Direct mode — no LLM required (default: 1000 experiences, 100 queries, 20 learning cycles)
python run_benchmark.py

# Custom scale
python run_benchmark.py --experiences 2000 --queries 200 --learning-cycles 50 --output results.json

# Agent mode via the elizaOS TypeScript benchmark bridge (requires ELIZA_BENCH_URL / ELIZA_BENCH_TOKEN)
python run_benchmark.py --mode eliza-agent --provider groq --model qwen3-32b
```

## Smoke test (no API keys)

The `direct` mode (default) runs entirely in-process without any LLM or external
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
| `elizaos_experience_bench/eliza_runner.py` | TypeScript bridge runner (eliza-agent/eliza-bridge modes) |
| `tests/` | pytest suite covering generator, evaluators, runner, and bridge |

## Notes

- Results write to the path given by `--output` (no default output directory; prints to stdout when omitted).
- Not registered in `registry/commands.py` or `registry/scores.py` — no orchestrator integration.
- Reproducible by default: seeded RNG (`--seed 42`). Change with `--seed`.
- Full background: [README.md](README.md).
