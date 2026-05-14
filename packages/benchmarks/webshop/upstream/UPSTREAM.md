# Vendored WebShop sources

The `upstream/` directory contains code vendored from
**Princeton NLP's WebShop** project:

- Repo: <https://github.com/princeton-nlp/WebShop>
- Paper: Yao et al., 2022, *"WebShop: Towards Scalable Real-World Web
  Interaction with Grounded Language Agents"* (NeurIPS 2022).
- License: MIT (see `upstream/LICENSE.md`).

We vendor:

- `web_agent_site/` — Flask app, simulated Flask "server" used by the Gym env,
  product catalog loader, instruction goal & reward functions (`engine/goal.py`,
  `engine/engine.py`), HTML templates, and the Gym env classes:
  - `envs/web_agent_text_env.py` — the headless text/HTML Gym env (default for
    RL agents and what we wrap).
  - `envs/web_agent_site_env.py` — the Selenium-driven env that drives a real
    Flask server in a browser (not used by our adapter but kept for parity).
- `baseline_models/` — original baseline agents, used as reference. The
  bundled `il_trajs_finalized_images.zip`, `goal_query_predict.json`, and
  `items_human_ins.json` (duplicates of `data/items_human_ins.json` after
  fetching) are intentionally **not** vendored — they are large and either
  redundant or only needed for retraining baselines. Fetch them via
  `scripts/fetch_data.py` (see `data` profile flags).
- `setup.sh` — original Princeton bootstrap script. We do not invoke it
  directly (it assumes `gdown` + `conda` + Java) but it documents the
  authoritative data URLs, which we mirror in `scripts/fetch_data.py`.
- `requirements.txt` — original dependency pin set.

We removed `web_agent_site/envs/chromedriver` (16 MB Linux binary) since
the headless `WebAgentTextEnv` does not need it. Install `chromedriver`
yourself if you wish to use `web_agent_site_env.py`.

## Modifications

The vendored Python files are **unmodified** from upstream
(commit fetched at vendoring time). All elizaOS-specific logic lives in
`../elizaos_webshop/` and wraps the upstream Gym env via composition rather
than monkey-patching.
