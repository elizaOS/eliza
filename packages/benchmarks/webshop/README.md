# elizaos-webshop

ElizaOS adapter for the **WebShop** benchmark (Yao et al., NeurIPS 2022 —
*"WebShop: Towards Scalable Real-World Web Interaction with Grounded
Language Agents"*). This package wraps Princeton-NLP's published
[`WebShop`](https://github.com/princeton-nlp/WebShop) repository (vendored
under `upstream/`) so eliza agents can be evaluated on the same gym
environment, instruction set, and reward function as the original paper.

## What changed (vs. the previous 2.0.0)

The previous version of this package shipped a toy in-process state machine
with 5 hard-coded products, 3 hand-written instructions, and a custom
regex-driven reward. **That is gone.** This rewrite:

- Vendors upstream's `web_agent_site/` (Flask sim, Gym env, reward function,
  HTML templates), `baseline_models/`, `setup.sh`, and `LICENSE.md` under
  `upstream/` (MIT, attribution preserved in `upstream/UPSTREAM.md`).
- Replaces our environment with a thin adapter
  (`elizaos_webshop/environment.py`) over upstream's
  `WebAgentTextEnv` Gym env. Agents see the same observations and act with
  the same `search[query]` / `click[value]` action vocabulary as the
  published baselines.
- Uses upstream's `web_agent_site.engine.goal.get_reward` (TF-IDF / fuzzy
  match over title, attributes, options, and price) — **not** our old custom
  scorer. Reward semantics are now bit-for-bit identical to the paper.
- Loads tasks from `items_human_ins.json` (12,087 human-written
  instructions) and product catalogs from `items_shuffle*.json`
  (1k or 1.18M products, fetched on demand).
- Keeps a tiny built-in sample catalog (~6 products) behind
  `--use-sample-tasks` for smoke tests.

## Quickstart

### 1. Install

From the repo root:

```bash
cd packages/benchmarks/webshop
pip install -e .
```

You also need the pinned spaCy English model used by the scored reward path:

```bash
python -m spacy download en_core_web_sm
```

Publication-grade runs require spaCy 3.8.7 and `en_core_web_sm` 3.8.0; the
orchestrator records and validates both versions in every result.

### 2. Fetch the data

```bash
python scripts/fetch_data.py --profile small        # 1k products (~4.6 MB)
# or
python scripts/fetch_data.py --profile full         # 1.18M products (~5.7 GB)
# or just the 12k human instructions:
python scripts/fetch_data.py --profile goals
```

Files are written to `packages/benchmarks/webshop/data/` and skipped if
their exact size and SHA-256 match the pinned upstream corpus. Google Drive is
the primary source; a revision-pinned Hugging Face mirror is accepted only
when it produces the same bytes.

Full runs also require the official Lucene projection and pinned runtime:

```bash
pip install -e ".[full,fetch]"
python -m spacy download en_core_web_sm
python scripts/build_search_index.py
```

The generated index contains 1,181,370 searchable documents. The remaining
60 of 1,181,430 executable products have an empty official search projection;
none is targeted by a human goal. The manifest records both counts.

### 3. Run

```bash
# Smoke test — no downloads, ~6 products, deterministic mock agent.
python -m elizaos_webshop --use-sample-tasks --mock --max-tasks 3

# Diagnostic 1k-product profile, via the eliza TS bridge.
python -m elizaos_webshop --profile small --bridge --max-tasks 50

# Publishable 500-task test split over the full 1.18M-product profile.
python -m elizaos_webshop --profile full --bridge --max-tasks 500
```

Results are written to `./benchmark_results/webshop/<timestamp>/`:

- `webshop-results.json` — top-level metrics
- `webshop-summary.md` — human-readable summary table
- `webshop-detailed.json` — per-task steps & rewards

## Metrics

Following the paper:

- **Score** = mean reward across instructions, range [0, 1].
- **SR** (Success Rate) = fraction of instructions where reward == 1.0,
  meaning the agent purchased a product that matched the goal title,
  attributes, options, and price.

The runner reports both.

## Architecture

```
elizaos_webshop/
├─ cli.py                  CLI entry: --profile / --use-sample-tasks / --mock / --bridge
├─ dataset.py              Streams the corpus and reproduces the official shuffled splits
├─ environment.py          Adapter around WebAgentTextEnv; required Lucene full-run path
├─ evaluator.py            Reports Score + SR following the paper
├─ runner.py               Orchestration; reuses one env across tasks
├─ eliza_agent.py          MockWebShopAgent driving the *real* upstream env
├─ trajectory_integration.py
└─ types.py                Lightweight typed observation / step / report shapes

upstream/
├─ web_agent_site/         Vendored Princeton-NLP code (unmodified)
├─ baseline_models/        Reference baselines (TWL / IL / RL)
├─ setup.sh                Original bootstrap
├─ LICENSE.md              MIT
└─ UPSTREAM.md             Vendoring notes

scripts/fetch_data.py      Downloads items_shuffle*, items_ins*, items_human_ins
scripts/build_search_index.py  Builds and validates the full Lucene projection
data/                      Created on first fetch; gitignored
tests/                     pytest smoke tests
```

## Optional / heavy dependencies

| Dep            | When needed                                  | Install |
|----------------|----------------------------------------------|--------|
| `spacy` + `en_core_web_sm` | **Always** — upstream's reward function requires it | `pip install spacy && python -m spacy download en_core_web_sm` |
| `rank_bm25`    | Small/sample diagnostic profiles only | included in `dependencies` |
| `pyserini` 2.1.0 + Java 21 | Required for the full publishable profile | `pip install -e ".[full]"` + install JDK 21 |
| `chromedriver` | Optional: only if you want to use the Selenium-backed `WebAgentSiteEnv` (we wrap the headless `WebAgentTextEnv` instead) | OS package |
| `elasticsearch`| Not required — the published env does not use it; legacy mention only | n/a |

The full profile fails closed if its Lucene index or pinned runtime provenance
is missing or mismatched. BM25 is confined to small/sample diagnostics, whose
reports are not publication-eligible.

## Running the tests

```bash
pip install -e ".[dev]"
python -m spacy download en_core_web_sm
pytest packages/benchmarks/webshop/
```

The smoke tests are auto-skipped if spaCy / `en_core_web_sm` / `torch` /
`thefuzz` / `bs4` are unavailable, so a freshly-cloned repo without the heavy
deps still runs `pytest` cleanly.

## Citation

If you use this package, please cite Princeton-NLP's paper:

```bibtex
@inproceedings{yao2022webshop,
  title  = {WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents},
  author = {Yao, Shunyu and Chen, Howard and Yang, John and Narasimhan, Karthik},
  booktitle = {Advances in Neural Information Processing Systems},
  year   = {2022},
}
```
