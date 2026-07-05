# Hermes-Adapter — Agent Guide

Bridge adapter connecting the elizaOS benchmark suite to [hermes-agent](https://github.com/NousResearch/hermes-agent)
(NousResearch). Wraps hermes-agent's native `BaseEnv` benchmark environments — TBlite (100 terminal tasks),
TerminalBench 2 (89 terminal tasks), YC-Bench (long-horizon strategic tasks), and SWE Env (SWE-bench style coding
tasks) — behind a subprocess CLI so the orchestrator can run them without importing hermes-agent's heavy Python
dependencies. Registered as `hermes_tblite`, `hermes_terminalbench_2`, `hermes_yc_bench`, `hermes_swe_env`.

## Run

```bash
# Direct — run one env via the CLI shim (from this directory)
python run_env_cli.py --env tblite --output /tmp/hermes-out --model gpt-oss-120b --provider cerebras
python run_env_cli.py --env terminalbench_2 --output /tmp/hermes-out --model gpt-oss-120b
python run_env_cli.py --env yc_bench --output /tmp/hermes-out --model gpt-oss-120b --max-tasks 3
python run_env_cli.py --env hermes_swe_env --output /tmp/hermes-out --model gpt-oss-120b

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks hermes_tblite --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks hermes_terminalbench_2 --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks hermes_yc_bench --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks hermes_swe_env --provider <p> --model <m>
```

Key flags for `run_env_cli.py`:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--env` | required | `tblite`, `terminalbench_2`, `yc_bench`, `hermes_swe_env` (and aliases) |
| `--output` | required | Directory for artifacts + JSON result |
| `--model` | required | Model name |
| `--provider` | `cerebras` | OpenAI-compatible provider label |
| `--harness` | `hermes` | `eliza`, `hermes`, or `openclaw` |
| `--max-tasks` | None | Cap number of eval samples |
| `--task-filter` | None | Forwarded to the env's `--env.task_filter` |
| `--timeout-seconds` | 7200 | Hard subprocess timeout |
| `--force` | false | Re-run even if a cached eval-summary exists |

## Test the harness

```bash
pip install -e .[dev]
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `run_env_cli.py` | CLI entrypoint — subprocess shim used by the orchestrator |
| `hermes_adapter/env_runner.py` | Core `run_hermes_env()` — invokes hermes-agent's `evaluate` flow |
| `hermes_adapter/client.py` | `HermesClient` — drop-in equivalent of `ElizaClient` |
| `hermes_adapter/server_manager.py` | `HermesAgentManager` — lifecycle owner for the subprocess server |
| `hermes_adapter/harness_openai_proxy.py` | OpenAI-compatible proxy routing between harnesses |
| `hermes_adapter/swe_env_smoke.py` | SWE-env smoke runner (`run_humanevalpack_swe_smoke`) |
| `hermes_adapter/{lifeops_bench,bfcl,clawbench,...}.py` | Per-benchmark `agent_fn` factories |
| `tests/` | pytest suite for the adapter layer |
| `pyproject.toml` | Package definition; install with `pip install -e .` |

## Notes

- Requires `CEREBRAS_API_KEY` (or the provider's equivalent key) for live runs.
- hermes-agent must be checked out at `~/.eliza/agents/hermes-agent-src/` (default); override with `--repo-path`.
- Results write to `<output_dir>/hermes_<env>_<timestamp>.json`.
- Scored by `_score_from_hermes_env_json` in `registry/scores.py` (line 1504).
- Full background: [README.md](README.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
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
