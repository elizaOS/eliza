# agentbench_matrix

AgentBench adapter for the elizaOS code-agent comparison matrix. It wraps the
`elizaos_agentbench` runner so the orchestrator can drive AgentBench across
multiple agents (elizaos, opencode, …) and models, then normalize results into
the common matrix schema.

**Not run standalone.** Imported dynamically by
`orchestrator/code_agent_matrix.py` as
`benchmarks.agentbench_matrix.code_agent_matrix`.

## Files

| File | Purpose |
|------|---------|
| `code_agent_matrix.py` | Entry point. `run_agentbench_matrix()` is the public API called by the orchestrator; `main()` / `__main__` provide a thin CLI for local debugging. |
| `__init__.py` | Package marker; re-exports nothing. |
| `tests/test_code_agent_matrix.py` | Integration smoke test — invokes the CLI with `--mock --max-tasks 1` and asserts the normalized JSON shape. |

## Supported environments

Five AgentBench environments are enabled by default: `os`, `webshop`,
`web_browsing`, `database`, `knowledge_graph`. Pass `--envs` (comma-separated)
to restrict the slice.

## Key env vars injected at runtime

`BENCHMARK_TASK_AGENT`, `BENCHMARK_MODEL_PROVIDER`, `BENCHMARK_MODEL_NAME`,
`ELIZA_AGENT_ORCHESTRATOR`, and model-override vars
(`OPENAI_LARGE_MODEL`, `GROQ_LARGE_MODEL`, etc.). All are set by
`_configure_agent_env()` before the `ElizaServerManager` starts.
