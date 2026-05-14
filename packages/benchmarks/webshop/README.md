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

You also need the spaCy English model — upstream's `engine.goal.get_reward`
calls `nlp = spacy.load("en_core_web_sm")` at import time:

```bash
python -m spacy download en_core_web_sm
```

> **Note on models**: upstream's `setup.sh` installs `en_core_web_lg`. We
> use the smaller `en_core_web_sm` because the reward function only uses
> the POS tagger (no word vectors). If you want bit-identical behavior to
> the published baselines, install `en_core_web_lg` instead and edit
> `upstream/web_agent_site/engine/goal.py`'s `spacy.load(...)` call.

### 2. Fetch the data

```bash
python scripts/fetch_data.py --profile small        # 1k products (~9 MB)
# or
python scripts/fetch_data.py --profile full         # 1.18M products (~2 GB)
# or just the 12k human instructions:
python scripts/fetch_data.py --profile goals
```

Files are written to `packages/benchmarks/webshop/data/` and skipped if
already present. `gdown` is used under the hood (`pip install -e ".[fetch]"`).

### 3. Run

```bash
# Smoke test — no downloads, ~6 products, deterministic mock agent.
python -m elizaos_webshop --use-sample-tasks --mock --max-tasks 3

# Full Princeton WebShop, 1k-product profile, via the eliza TS bridge.
python -m elizaos_webshop --profile small --bridge --max-tasks 50

# Full 1.18M-product profile (slow first load).
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
├─ dataset.py              Loads upstream JSONs, resolves train/test split (90/10, seed=42)
├─ environment.py          Adapter around upstream WebAgentTextEnv; BM25 fallback
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
data/                      Created on first fetch; gitignored
tests/                     pytest smoke tests
```

## Optional / heavy dependencies

| Dep            | When needed                                  | Install |
|----------------|----------------------------------------------|--------|
| `spacy` + `en_core_web_sm` | **Always** — upstream's reward function requires it | `pip install spacy && python -m spacy download en_core_web_sm` |
| `rank_bm25`    | Always, unless pyserini is installed         | included in `dependencies` |
| `pyserini` + Java 11+ | Optional: bit-identical Lucene search; reproduces published numbers exactly | `pip install -e ".[pyserini]"` + install JDK 11 |
| `chromedriver` | Optional: only if you want to use the Selenium-backed `WebAgentSiteEnv` (we wrap the headless `WebAgentTextEnv` instead) | OS package |
| `elasticsearch`| Not required — the published env does not use it; legacy mention only | n/a |

If `pyserini` is missing we transparently fall back to a `rank_bm25.BM25Okapi`
index built in-process over each catalog's titles + descriptions. The reward
function (the only thing the paper's numbers are sensitive to) is unchanged.

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
