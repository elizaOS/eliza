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
