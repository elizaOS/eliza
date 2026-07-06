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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
