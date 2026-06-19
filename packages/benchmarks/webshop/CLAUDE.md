# WebShop — Agent Guide

elizaOS adapter for the **WebShop** benchmark (Yao et al., NeurIPS 2022).
Evaluates web-interaction agents on product search and purchase tasks using
Princeton-NLP's upstream Gym environment, reward function, and 12k
human-written instructions. Registry id: `webshop`.

## Run

```bash
# Direct, from this directory (small 1k-product profile, bridge mode)
python -m elizaos_webshop --profile small --bridge --max-tasks 50

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks webshop --provider <p> --model <m>
```

Fetch the upstream data first if not already present:

```bash
python scripts/fetch_data.py --profile small   # ~9 MB, 1k products
python scripts/fetch_data.py --profile full    # ~2 GB, 1.18M products
```

## Smoke test (no API keys, no downloads)

```bash
python -m elizaos_webshop --use-sample-tasks --mock --max-tasks 3
```

Uses the bundled ~6-product sample catalog with the deterministic mock agent.
No external dependencies beyond a working install.

## Test the harness

```bash
pip install -e ".[dev]"
python -m spacy download en_core_web_sm
pytest packages/benchmarks/webshop/ -v
```

Tests are auto-skipped when heavy deps (spaCy model, torch, thefuzz, bs4) are
absent, so `pytest` still passes cleanly in a fresh checkout.

## Layout

| Path | Role |
| --- | --- |
| `elizaos_webshop/cli.py` | CLI entrypoint (`--mock`, `--bridge`, `--profile`, `--use-sample-tasks`) |
| `elizaos_webshop/runner.py` | Orchestration loop across tasks |
| `elizaos_webshop/environment.py` | Adapter over upstream `WebAgentTextEnv`; BM25 fallback |
| `elizaos_webshop/evaluator.py` | Reports Score + SR following the paper |
| `elizaos_webshop/eliza_agent.py` | Mock agent driving the upstream env |
| `elizaos_webshop/dataset.py` | Loads upstream JSONs, resolves train/test split |
| `elizaos_webshop/types.py` | Typed observation / step / report shapes |
| `upstream/web_agent_site/` | Vendored Princeton-NLP Flask sim + Gym env (unmodified) |
| `scripts/fetch_data.py` | Downloads catalog and instruction files |
| `tests/` | pytest smoke suite |

## Notes

- Results write to `benchmark_results/webshop/<timestamp>/` (gitignored):
  `webshop-results.json`, `webshop-summary.md`, `webshop-detailed.json`.
- Scored by `_score_from_webshop_json` in `registry/scores.py`.
- Reward function is upstream's `web_agent_site.engine.goal.get_reward`
  (TF-IDF / fuzzy match over title, attributes, options, price) — identical
  to the published paper.
- spaCy `en_core_web_sm` is required at runtime; install once with
  `python -m spacy download en_core_web_sm`.
- Full background: [README.md](README.md).
