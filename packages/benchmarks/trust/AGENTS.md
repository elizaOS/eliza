# Trust — Agent Guide

Adversarial security detection benchmark: evaluates an agent's ability to identify
prompt injection, social engineering, impersonation, credential theft, privilege escalation,
data exfiltration, resource abuse, and content policy violations. 165 cases across 9 categories
(130 malicious + 35 benign false-positive controls). Registered in the suite registry as `trust`.

## Run

```bash
# Direct, from this directory (defaults to oracle handler — no API keys needed)
python run_benchmark.py

# With a specific handler
python run_benchmark.py --handler oracle        # perfect-score baseline (validates framework)
python run_benchmark.py --handler random        # coin-flip baseline (validates discrimination)
python run_benchmark.py --handler eliza         # LLM-based via elizaOS TS bridge
python run_benchmark.py --handler llm           # direct OpenAI-compatible endpoint

# Filter options
python run_benchmark.py --categories prompt_injection social_engineering
python run_benchmark.py --difficulty hard
python run_benchmark.py --tags encoding multi-language
python run_benchmark.py --threshold 0.8 --output results.json

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks trust --provider <p> --model <m>
```

## Smoke test (no API keys)

The oracle handler is fully deterministic and requires no credentials. It validates
the benchmark framework itself and must always score 100%.

```bash
python run_benchmark.py --handler oracle
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_benchmark.py` | CLI entrypoint; handler registration and argument parsing |
| `elizaos_trust_bench/runner.py` | Benchmark execution loop and metrics aggregation |
| `elizaos_trust_bench/corpus.py` | 165 test cases across 9 threat categories |
| `elizaos_trust_bench/baselines.py` | `PerfectHandler` (oracle) and `RandomHandler` baselines |
| `elizaos_trust_bench/scorer.py` | Precision, recall, F1, and false-positive-rate computation |
| `elizaos_trust_bench/types.py` | `TrustHandler` protocol, `BenchmarkConfig`, enums |
| `elizaos_trust_bench/reporter.py` | Console and JSON report formatting |
| `tests/` | pytest suite covering corpus, scorer, and baselines |

## Notes

- Results write to the path given by `--output` (default: none; orchestrator writes `trust-results.json`).
- Scored by `_score_from_trust_json` in `registry/scores.py`.
- When the orchestrator runs with `provider=mock`, it automatically uses the oracle handler.
- Metrics: per-category precision/recall/F1, overall macro F1, false-positive rate, difficulty breakdown.
- To test a custom agent, implement the `TrustHandler` protocol from `elizaos_trust_bench.types` and
  pass it directly to `TrustBenchmarkRunner.run_and_report()` — see [README.md](README.md).
- Full background and test case design philosophy: [README.md](README.md).
