# WebShop — research notes

This document describes the WebShop benchmark and how the
`elizaos-webshop` adapter integrates with it.

## Paper

**WebShop: Towards Scalable Real-World Web Interaction with Grounded
Language Agents** — Shunyu Yao, Howard Chen, John Yang, Karthik Narasimhan
(Princeton NLP). NeurIPS 2022.

- arXiv: <https://arxiv.org/abs/2207.01206>
- Code: <https://github.com/princeton-nlp/WebShop> (MIT)
- Project page: <https://webshop-pnlp.github.io/>

WebShop was the first large-scale benchmark for grounded language agents
that interact with a simulated e-commerce website. It scraped Amazon.com
to obtain ~1.18M product entries with realistic attributes, reviews,
images, and customization options, then collected 12,087 natural-language
shopping instructions from MTurk workers. Each instruction targets a
specific product and is annotated with the goal's *attributes*
(e.g. "noise cancelling"), *options* (e.g. color = black, size = 750ml),
and an upper price bound. An agent succeeds when it issues actions that
navigate the site (`search[...]`, `click[...]`) and ultimately purchases
a product that matches all three.

## Environment

The simulator is a small Flask application (`web_agent_site/app.py`) plus
templated HTML pages (`templates/`). For RL / LM-agent use, the same
internals are exposed as a Gym environment, `WebAgentTextEnv`
(`web_agent_site/envs/web_agent_text_env.py`), which wraps a `SimServer`
that calls the Flask view functions directly via
`app.test_request_context()` — no actual HTTP loopback is required.

Action space (string-typed):

| Action | Effect |
|---|---|
| `search[<keywords>]` | Run BM25 / Lucene search and render results page |
| `click[<product asin>]` | Navigate to a product page |
| `click[<option value>]` | Select a customization option |
| `click[Description]`, `click[Features]`, `click[Reviews]`, `click[Attributes]` | Sub-page navigation |
| `click[< Prev]`, `click[Next >]`, `click[Back to Search]` | Pagination |
| `click[Buy Now]` | Terminate the episode and trigger reward computation |

Observation modes (`observation_mode=`):

- `text` — visible HTML text with `[SEP]` separators (simple).
- `text_rich` — visible text with `[button]` / `[clicked button]` markers.
- `html` — raw HTML string.

## Reward (the crucial bit)

When the agent issues `click[Buy Now]`, upstream's
`web_agent_site/engine/goal.py::get_reward` runs:

```python
total = (num_attr_matches + num_option_matches + r_price) /
        (|attributes| + |options| + 1)
total *= r_type     # 0.0 if title is wildly off, 1.0 if it overlaps
```

Components:

- **`r_type`** (`get_type_reward`): a TF-IDF / POS-tag overlap score between
  the purchased product's title and the goal product's title, using spaCy's
  `en_core_web_sm` POS tagger to filter to `NOUN`/`PROPN`/`PNOUN`. The
  score is gated by query and category equality checks. If `title_score`
  is 0, the entire reward is 0. (Hence: spaCy is a hard dependency.)
- **`r_att` / `num_attr_matches`** (`get_attribute_reward`): `thefuzz.fuzz.
  token_set_ratio > 85` between each goal attribute and the purchased
  product's `Attributes`, falling back to substring match against title /
  bullet points / description.
- **`r_option` / `num_option_matches`** (`get_option_reward`):
  `thefuzz` fuzzy match between purchased options and goal options after
  normalizing colors (`normalize_color` in `engine/normalize.py`).
- **`r_price`**: 1 if `price <= goal['price_upper']`, else 0.

The aggregate reward is a single float in `[0, 1]`. The paper's headline
metrics are:

- **Score** = mean reward over the held-out 500 instructions.
- **SR**    = mean indicator(reward == 1.0) over the same set.

Reference numbers from the paper, test split:

| Model | Score | SR |
|---|---:|---:|
| Rule | 45.6 | 9.6 |
| IL   | 59.9 | 29.1 |
| IL+RL | 62.4 | 28.7 |
| Human (avg expert) | 82.1 | 59.6 |

## Our integration

### Vendored sources

Upstream is vendored verbatim under `upstream/web_agent_site/` and
`upstream/baseline_models/`. We removed the 16 MB Linux `chromedriver` and
some large redundant baseline data artefacts; everything reward- and
env-relevant is intact. The package import path is `web_agent_site`, the
same as upstream, so any tools or research code that already targets the
Princeton repo can be pointed at our `upstream/` directory without
modification.

### Data

`scripts/fetch_data.py` mirrors the Google Drive URLs in upstream's
`setup.sh`:

| Profile | Files | Size |
|---|---|---:|
| `goals` | `items_human_ins.json` | ~5 MB |
| `small` | `items_shuffle_1000.json`, `items_ins_v2_1000.json`, `items_human_ins.json` | ~15 MB |
| `full`  | `items_shuffle.json`, `items_ins_v2.json`, `items_human_ins.json` | ~2 GB |

Nothing is bundled in the repo — even `items_human_ins.json` is fetched on
demand. The `--use-sample-tasks` flag exposes a hand-written 6-product
sample catalog for tests.

### Split

We perform a deterministic 90/10 train/test split over the goal list
(seed=42, `WebShopDataset.SPLIT_SEED`) after applying upstream's own
`random.seed(233)` shuffle. The paper used a fixed held-out 500-instruction
test set generated similarly; numbers will not be bit-identical, but the
overall difficulty is matched.

### Search engine

Upstream uses Lucene via `pyserini`, which requires Java 11+ and a built
index under `search_engine/indexes*/`. To keep the adapter installable
without Java, we monkey-patch `engine.init_search_engine` and
`SimServer.__init__` so that when `pyserini` is unavailable we transparently
fall back to `rank_bm25.BM25Okapi` over titles + descriptions + categories.
This affects the *retrieval* step only; reward computation is unchanged.
Empirically the ranking is similar enough for evaluation, but if you want
to reproduce published numbers to within noise, install `pyserini` and
run upstream's `search_engine/run_indexing.sh`.

### Agent boundary

`WebShopRunner` constructs a single `WebShopEnvironment` and reuses it
across tasks. Agents are created via `create_webshop_agent(env, ...)`,
which returns a `MockWebShopAgent` by default. Real LM agents are routed
through the eliza TypeScript benchmark bridge (`--bridge`), which calls
into our env via `eliza_adapter.webshop`. Trajectory logging (ART / GRPO
formats) is plugged in at the runner level when
`--trajectories` is passed.

### What's *not* in scope here

- Training the IL/RL baselines (use upstream `baseline_models/train_*.py`).
- The Selenium-driven `WebAgentSiteEnv` (we wrap the headless text env).
- Human trajectory replay (vendored data not bundled).
- The `feat_conv.pt` / `feat_ids.pt` image features (large, not needed for
  text-only evaluation).

## References

- Princeton-NLP, WebShop GitHub: <https://github.com/princeton-nlp/WebShop>
- Yao et al., *WebShop*, NeurIPS 2022:
  <https://arxiv.org/abs/2207.01206>
- Anserini / pyserini (Lucene-Python bindings):
  <https://github.com/castorini/pyserini>
- rank-bm25 (pure-Python BM25):
  <https://github.com/dorianbrown/rank_bm25>
