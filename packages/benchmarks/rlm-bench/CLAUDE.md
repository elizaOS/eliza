# RLM-Bench — Agent Guide

Recursive Language Model benchmark: S-NIAH (streaming needle-in-a-haystack) +
OOLONG (long-document retrieval/reasoning) from
[arXiv:2512.24601](https://arxiv.org/abs/2512.24601). Registered in the suite
registry as `rlm_bench`.

## Run

```bash
# Direct, from this directory
python run_benchmark.py --mode rlm --backend gemini \
  --dual-model --root-model gemini-2.0-flash --subcall-model gemini-2.0-flash

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks rlm_bench --provider <p> --model <m>
```

Modes: `stub` (mock LLM), `rlm` (RLM plugin), `eliza` (elizaOS runtime), `custom`.

## Smoke test (no API keys)

```bash
python run_benchmark.py --mode stub --context-lengths 1000,10000
```

Stub mode is deterministic and offline — used for readiness/CI checks.

## Test the harness

```bash
pip install -e .[dev]                  # once, from this directory
pytest elizaos_rlm_bench/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint (`--mode stub\|rlm\|eliza\|custom`) |
| `elizaos_rlm_bench/generator.py` | Task generation (S-NIAH, OOLONG) |
| `elizaos_rlm_bench/runner.py` | Execution loop |
| `elizaos_rlm_bench/evaluator.py` | Scoring |
| `elizaos_rlm_bench/reporting.py` | JSON + markdown report writers |
| `elizaos_rlm_bench/tests/` | pytest suite |

## Notes

- Results write to `benchmark_results/rlm-bench/` (gitignored).
- Scored by `_score_from_rlmbench_json` in `registry/scores.py`.
- Paper tables, strategy analysis, and plugin integration: [README.md](README.md).
