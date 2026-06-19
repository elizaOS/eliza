# hermes-adapter

Benchmark adapter for the [hermes-agent](https://github.com/NousResearch/hermes-agent)
tool-calling LLM agent. Drop-in equivalent of the `eliza-adapter` API surface,
swapping the eliza TypeScript bench server for hermes-agent's Python `HermesAgentLoop`.

Default deployment model: **subprocess** — a thin Python script runs inside the
hermes-agent venv (`~/.eliza/agents/hermes-agent-src/.venv`) and exchanges JSON
on stdout. The orchestrator Python does not need to import any of hermes-agent's
heavy dependencies (atroposlib, openai, modal, datasets, …).

## Layout

```
hermes_adapter/
  __init__.py          re-exports
  client.py            HermesClient — drop-in equivalent of ElizaClient
  server_manager.py    HermesAgentManager — lifecycle owner
  env_runner.py        runs hermes-agent's `evaluate` for a native env
  lifeops_bench.py     per-benchmark agent_fn factory (LifeOpsBench)
  bfcl.py              per-benchmark agent_fn factory (BFCL)
  clawbench.py         per-benchmark agent_fn factory (clawbench)
```

## Quick example

```python
from hermes_adapter import HermesClient

client = HermesClient()
client.wait_until_ready(timeout=60)
print(client.send_message("say PONG").text)
```

## Running hermes-agent's NATIVE benchmark environments

```python
from pathlib import Path
from hermes_adapter import run_hermes_env

result = run_hermes_env(
    env_id="tblite",
    output_dir=Path("/tmp/tblite-out"),
    max_tasks=2,
)
print(result.score, result.samples_path)
```

The four native env_ids: `hermes_swe_env`, `tblite`, `terminalbench_2`, `yc_bench`.
