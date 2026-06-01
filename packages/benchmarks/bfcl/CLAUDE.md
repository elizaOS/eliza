# BFCL — Agent Guide

Berkeley Function-Calling Leaderboard benchmark: evaluates LLM function-calling
accuracy across single-turn (AST equality), multi-turn (executable runtime state
comparison), and agentic (web search, memory) categories. Registered in the suite
registry as `bfcl`.

## Run

```bash
# Direct — sample of 50 tests, default provider (Groq gpt-oss-120b)
python -m benchmarks.bfcl run --sample 50

# Direct — specific provider and model
python -m benchmarks.bfcl run --provider openai --model openai/gpt-5 --sample 50

# Direct — specific categories only
python -m benchmarks.bfcl run --categories simple,multiple,multi_turn_base

# Direct — full benchmark with network-gated categories enabled
python -m benchmarks.bfcl run --full --enable-network

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks bfcl --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
python -m benchmarks.bfcl run --mock --sample 10
```

## Test the harness

```bash
pytest bfcl/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `__main__.py` | CLI entrypoint (`python -m benchmarks.bfcl`) |
| `runner.py` | Main execution loop |
| `agent.py` | Agent abstraction (real + mock) |
| `dataset.py` | Dataset loading (HuggingFace or local) |
| `evaluators/` | AST, executable, and relevance evaluators |
| `executable_runtime/` | Vendored upstream tool implementations (GorillaFS, MathAPI, etc.) |
| `types.py` | `BFCLCategory`, `BFCLConfig`, leaderboard score types |
| `reporting.py` | Result printing and summary |
| `elizaos_bfcl/` | elizaOS action catalog for the eliza provider |
| `tests/` | pytest suite |
| `scripts/run_benchmark.py` | Standalone run script (alternative entrypoint) |

## Notes

- Results write to `./benchmark_results/bfcl/` as `bfcl_results_*.json` (gitignored).
- Scored by `_score_from_bfcl_json` in `registry/scores.py`.
- Network-gated categories (`rest_api`, `web_search_base`, `web_search_no_snippet`) are
  skipped without `--enable-network` and excluded from the accuracy denominator.
- Memory categories (`memory_kv`, `memory_vector`, `memory_rec_sum`) are skipped unless
  upstream `bfcl-eval` is installed.
- Vendored upstream sources are Apache 2.0; see `executable_runtime/NOTICE`.
- Full background: [README.md](README.md).
