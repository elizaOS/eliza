# Hermes-Adapter — Agent Guide

Bridge adapter connecting the elizaOS benchmark suite to [hermes-agent](https://github.com/NousResearch/hermes-agent)
(NousResearch). Wraps hermes-agent's native `BaseEnv` benchmark environments — TBlite (100 terminal tasks),
TerminalBench 2 (89 terminal tasks), YC-Bench (long-horizon strategic tasks), and SWE Env (SWE-bench style coding
tasks) — behind a subprocess CLI so the orchestrator can run them without importing hermes-agent's heavy Python
dependencies. Registered as `hermes_tblite`, `hermes_terminalbench_2`, `hermes_yc_bench`, `hermes_swe_env`.

## Publishable Hermes client path

Publishable adapter turns always run in a fresh subprocess using the pinned
Hermes venv. `native_runtime.py` sets an isolated `HERMES_HOME` before importing
the pinned checkout's `run_agent.py`, instantiates `run_agent.AIAgent` with
`api_mode="chat_completions"`, points it at the suite's loopback subscription
gateway, calls `run_conversation`, and closes the agent.

The pinned checkout is only an import source. Native subprocess cwd and
`TERMINAL_CWD` both point at the benchmark workspace so Hermes's model-facing
working-directory prompt and any generated task instructions target the code
under evaluation, not `~/.eliza/agents/hermes-agent-src`.

For tool benchmarks, the parent generates the `eliza-benchmark-tools` user
plugin under that isolated home. It registers only the benchmark schemas via
upstream `ctx.register_tool`, captures executed calls, enables only the
`eliza_benchmark_scoped` toolset, and disables Tool Search. Both health and turn
results fail closed unless the imported source belongs to the pinned checkout,
AIAgent instantiated successfully, the loaded tool names exactly match the
generated plugin, and native provenance reports `publishable_native=true`.

`mode="in_process"`, remote/non-loopback base URLs, raw OpenAI SDK calls, direct
provider proxies, and results without verified native provenance are
nonpublishable diagnostic paths. Do not use them for scores, canaries, or
evidence. Tests use fake upstream modules and must not spend subscription
credits; live evidence is a separate gateway-backed run whose telemetry is
reviewed manually.

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
python -m pytest -q
ruff check hermes_adapter tests
```

## Layout

| Path | Role |
| --- | --- |
| `run_env_cli.py` | CLI entrypoint — subprocess shim used by the orchestrator |
| `hermes_adapter/env_runner.py` | Core `run_hermes_env()` — invokes hermes-agent's `evaluate` flow |
| `hermes_adapter/client.py` | `HermesClient` — drop-in equivalent of `ElizaClient` |
| `hermes_adapter/native_runtime.py` | Pinned AIAgent runner + generated scoped-tool plugin bridge |
| `hermes_adapter/server_manager.py` | `HermesAgentManager` — lifecycle owner for the subprocess server |
| `hermes_adapter/harness_openai_proxy.py` | OpenAI-compatible proxy routing between harnesses |
| `hermes_adapter/swe_env_smoke.py` | SWE-env smoke runner (`run_humanevalpack_swe_smoke`) |
| `hermes_adapter/{lifeops_bench,bfcl,clawbench,...}.py` | Per-benchmark `agent_fn` factories |
| `tests/` | pytest suite for the adapter layer |
| `pyproject.toml` | Package definition; install with `pip install -e .` |

## Notes

- Publishable client runs require a loopback OpenAI-compatible subscription gateway (`CLAUDE_SUBSCRIPTION_GATEWAY_URL` / `OPENAI_BASE_URL`) and its token (`CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN` / `OPENAI_API_KEY`).
- Two hermes-agent checkouts are required, at different revisions. The native client lane (`HermesClient`) imports `run_agent` from `~/.eliza/agents/hermes-agent-src/` (override with `--repo-path`); provision it with `benchmarks/lib/agent_install.py` (tracks upstream `main` — the pinned env revision below predates `AIAgent`'s `tool_progress_mode`/`register_tool(override=...)` API and fails the native health probe). The env lane (`env_runner.py`: `hermes_tblite`/`hermes_terminalbench_2`/`hermes_yc_bench`) verifies its own checkout at `packages/benchmark-data/source-audit/hermes-agent.git` (override with `HERMES_BENCH_REPO_PATH`) pinned to `PINNED_HERMES_ENV_REVISION`, plus a YC-Bench checkout at `packages/benchmark-data/source-audit/yc-bench` pinned to `PINNED_YC_BENCH_REVISION`.
- The env-lane venv needs `atroposlib`; installing hermes-agent's `.[rl]` extra fails because pip's recursive submodule init hits a dead commit in upstream atropos (`bleuberi-repo`). Clone `NousResearch/atropos` at the extra's pinned revision without submodules and `pip install` it from the local path instead.
- Publication gates consume `agent_runtime`, `native_runtime_class`, `native_runtime_api`, `tool_bridge_plugin`, `tool_bridge_api`, `transport`, and `publishable_native` from health/turn telemetry.
- Results write to `<output_dir>/hermes_<env>_<timestamp>.json`.
- Scored by `_score_from_hermes_env_json` in `registry/scores.py` (line 1504).
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
