# Social-Alpha — Agent Guide

Trust marketplace benchmark that evaluates systems on real Discord crypto-chat data
from the ElizaOS Trenches community. Measures four capabilities via the
EXTRACT / RANK / DETECT / PROFIT suites and produces a composite Trust Marketplace
Score (TMS). Registered in the suite registry as `social_alpha`.

## Run

```bash
# Direct, from this directory — rule-based baseline, bundled smoke fixture
python -m benchmark.harness --data-dir fixtures/smoke-data --system baseline

# With the full Trenches Chat dataset (267k messages, requires download)
python -m benchmark.harness --data-dir trenches-chat-dataset/data --system baseline

# LLM-backed full system (requires provider keys)
python -m benchmark.harness --data-dir trenches-chat-dataset/data --system full --model groq/llama-3.3-70b-versatile

# Run a single suite
python -m benchmark.harness --data-dir fixtures/smoke-data --suite extract

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks social_alpha --provider <p> --model <m>
```

Available `--system` values: `baseline` (rule-based, no LLM), `smart` (improved
heuristics), `full` (LLM extraction), `oracle` (perfect-knowledge upper bound),
`eliza-bridge` (TypeScript agent via elizaOS bridge).

## Smoke test (no API keys)

The harness falls back to `fixtures/smoke-data` automatically when the full dataset
is absent. Running baseline against the fixture needs no keys:

```bash
python -m benchmark.harness --data-dir fixtures/smoke-data --system baseline
```

## Test the harness

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `benchmark/harness.py` | CLI entrypoint (`python -m benchmark.harness`) |
| `benchmark/suites/` | Four scored suites: `extract`, `rank`, `detect`, `profit` |
| `benchmark/systems/` | System implementations: `full_system`, `oracle`, `smart_baseline`, `token_registry` |
| `benchmark/protocol.py` | Abstract `SocialAlphaSystem` interface + dataclasses |
| `benchmark/ground_truth.py` | Ground-truth generation and caching |
| `fixtures/smoke-data/` | Bundled minimal fixture for key-free runs |
| `trenches-chat-dataset/` | Full dataset (267k messages; fetched separately) |
| `tests/` | pytest suite |

## Notes

- Results write to the `--output` directory as `benchmark_results_<system>.json` (not committed).
- Composite TMS weights: EXTRACT 25%, RANK 30%, DETECT 25%, PROFIT 20%.
- Scored by `_score_from_social_alpha_json` in `registry/scores.py`; score is TMS / 100 (ratio, higher is better).
- Full dataset schema and download instructions: [trenches-chat-dataset/README.md](trenches-chat-dataset/README.md).
