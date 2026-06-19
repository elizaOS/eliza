# ElizaOS tau-bench Benchmark

Faithful, vendored implementation of Sierra's [tau-bench](https://github.com/sierra-research/tau-bench) (Yao et al., 2024) wired into the ElizaOS evaluation harness.

## What this package contains

This package **vendors** the upstream tau-bench source tree under
`elizaos_tau_bench/upstream/` (MIT, see `elizaos_tau_bench/upstream/LICENSE`)
and provides an ElizaOS-friendly runner + LLM judge + pass^k harness on top
of it.

Vendored from:
- repo: `https://github.com/sierra-research/tau-bench`
- commit: `59a200c6d575d595120f1cb70fea53cef0632f6b`

Upstream modules used directly:
- `upstream/envs/base.py` (`Env`, action/tool/reward semantics)
- `upstream/envs/retail/` (115 tools, products/users/orders DBs, wiki, rules)
- `upstream/envs/airline/` (50 tools, flights/reservations/users DBs, wiki, rules)
- `upstream/envs/retail/tasks_test.py` -- 115 official retail tasks
- `upstream/envs/airline/tasks_test.py` -- 50 official airline tasks
- `upstream/envs/user.py` -- LLM-based User simulator (LLM / React / Verify / Reflection strategies)
- `upstream/types.py` -- Action, Task, EnvResponse, ...

Total tasks loaded: **165** (115 retail + 50 airline test split). Retail also
exposes `dev` and `train` splits via `--task-split`.

## Architecture

```
TauBenchRunner (elizaos_tau_bench/runner.py)
  iter_tasks() -> for each task:
    for trial in num_trials:
      Env = upstream.get_env(...)   # real DB + 115/50 tools + wiki + rules
      agent.solve(Env, task_index)  # multi-turn tool-calling loop:
        while not done:
          LLM -> Action
          Env.step(Action)
            if tool: invoke against real DB
            if RESPOND: User.step(msg)   # LLM user simulator (gpt-4o)
                                         # produces next user turn
                                         # until ###STOP###
      judge_outputs_satisfied(...)     # gpt-4o-mini gates task.outputs
  pass_k.calculate_pass_hat_k(...)     # unbiased pass^k estimator
```

The agent loop mirrors upstream `ToolCallingAgent.solve`: the agent emits
either a function/tool call (executed by `Env`) or a RESPOND action (forwarded
to the user simulator). The user simulator is a real multi-turn LLM by
default (`--user-model gpt-4o`); the rollout ends when it emits
`###STOP###` or `agent_max_turns` is reached.

## Installation

```bash
cd packages/benchmarks/tau-bench
pip install -e ".[dev]"
```

Core dependencies: `httpx`, `pydantic`, `pytest`, `pytest-asyncio`.
`litellm` is optional (`pip install -e ".[litellm,dev]"`). When it is not
installed, the built-in agent, user simulator, and judge can call an
OpenAI-compatible chat-completions endpoint by setting
`TAU_BENCH_OPENAI_BASE_URL` or `OPENAI_BASE_URL` (for example a local
llama.cpp server at `http://127.0.0.1:8080/v1`).

## Required environment variables

| Component        | Env var (default provider = openai) | Default model |
|------------------|--------------------------------------|---------------|
| Agent LLM        | `OPENAI_API_KEY`                     | `gpt-4o`      |
| User simulator   | `OPENAI_API_KEY`                     | `gpt-4o`      |
| LLM judge        | `OPENAI_API_KEY`                     | `gpt-4o-mini` |

Override providers with `--agent-provider`, `--user-provider`, `--judge-provider`.
With LiteLLM installed, any LiteLLM provider works. Without LiteLLM, use
`openai-compatible`, `local`, or `llama.cpp` with an OpenAI-compatible base URL.
The runner checks each provider's API key up front and refuses to start unless
every required one is present (or you pass `--mock`).

## Upstream data assets

The repository ships only compact smoke fixtures for the sample task IDs. Full
retail and airline JSON data is fetched lazily from `sierra-research/tau-bench`
into `~/.cache/elizaos_tau_bench/upstream/<ref>/...` when an official benchmark
run first needs it. Set `TAU_BENCH_DATA_DIR` to use a pre-populated local copy,
`TAU_BENCH_DATA_MODE=smoke` for fixture-only sample runs, or
`TAU_BENCH_DISABLE_DATA_DOWNLOAD=1` to require local files and fail if missing.

## Quick start

Run the full 165-task benchmark with pass^4 (paper default):

```bash
python -m elizaos_tau_bench --num-trials 4
```

Run only retail dev split with a single trial:

```bash
python -m elizaos_tau_bench --domain retail --task-split dev --num-trials 1
```

Run a tiny smoke (4 sample tasks) with the deterministic mock agent -- no LLM,
no API keys required:

```bash
python -m elizaos_tau_bench --mock --use-sample-tasks
```

Run a specific task subset:

```bash
python -m elizaos_tau_bench --domain retail --task-ids 0 1 2 --num-trials 4
```

Use a non-OpenAI model for the agent but keep openai for user/judge:

```bash
python -m elizaos_tau_bench \
    --agent-provider anthropic --agent-model claude-3-5-sonnet-latest \
    --user-provider openai --user-model gpt-4o \
    --judge-provider openai --judge-model gpt-4o-mini
```

Disable the LLM judge (fall back to upstream's literal substring check):

```bash
python -m elizaos_tau_bench --no-llm-judge
```

## Pass^k

pass^k = probability that **all** k independent trials of a task succeed.
We compute the unbiased estimator from the paper:

    pass^k = E_task [ C(c, k) / C(n, k) ]

where n = total trials, c = successful trials, per task. Defaults to k in {1,2,4}
and `--num-trials 4` (paper default).

## LLM judge

Upstream's reward gate for `task.outputs` is a literal substring search in the
agent's RESPOND messages -- brittle when the agent paraphrases correctly. The
judge here calls a small LLM (`--judge-model gpt-4o-mini`) with a strict JSON
schema:

    {"per_output": {"<output>": true|false, ...}, "explanation": "..."}

A task passes when both (a) the upstream data-hash check succeeds (agent's
actions reach the same DB state as the ground-truth actions) and (b) every
required output is satisfied per the judge. If the judge LLM is unavailable
(missing API key, transient failure, unparseable response) it falls back to
the upstream substring check and records that in the explanation.

## Programmatic API

```python
from elizaos_tau_bench import TauBenchConfig, TauBenchRunner

cfg = TauBenchConfig(
    domains=["retail", "airline"],
    task_split="test",
    num_trials=4,
    agent_model="gpt-4o",
    user_model="gpt-4o",
    judge_model="gpt-4o-mini",
    output_dir="./out",
)
report = TauBenchRunner(cfg).run()
print(report.pass_k[4].pass_hat_k)
```

`report.results` is the per-(task, trial) list; `report.to_dict()` serializes
everything in a stable JSON shape that's also written to
`<output_dir>/report.json` and `<output_dir>/trajectories.json`.

## Tests

```bash
pytest packages/benchmarks/tau-bench/
```

Tests cover dataset loading, pass^k math, judge behaviour, completion adapter
fallbacks, output JSON contracts, and an end-to-end smoke that runs one retail
task with a stubbed completion adapter -- verifying the multi-turn
user-simulator loop runs and at least one tool call lands.

## License

This package is MIT-licensed. The vendored `elizaos_tau_bench/upstream/` tree
is (c) 2024 Sierra and distributed under the upstream MIT license -- see
`elizaos_tau_bench/upstream/LICENSE`. Copyright headers (`# Copyright Sierra`)
are preserved verbatim across every vendored file.
