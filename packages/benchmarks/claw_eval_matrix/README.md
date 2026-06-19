# claw_eval_matrix

Claw-Eval adapter for the code-agent comparison matrix. Runs the deterministic YAML slice of the [Claw-Eval](../claw-eval) benchmark through any supported code-agent adapter and scores results without an LLM judge.

**Not run standalone.** Imported dynamically by `orchestrator/code_agent_matrix.py`, which supplies `task_agent`, `model_provider`, `model`, and output paths.

## Files

| File | Role |
|---|---|
| `code_agent_matrix.py` | Core module. Loads deterministic tasks from `../claw-eval/tasks/`, dispatches each task to the agent via subprocess, scores responses against YAML-defined components (`keywords_present`, `categories_present`, `min_length`, `tool_called`), and assembles the result dict. |
| `agent_command.py` | Built-in command helper invoked per task. Injects adapter-specific env vars, starts `ElizaServerManager`, sends the task prompt, and writes a per-task `agent-result.json`. Override via `CLAW_EVAL_AGENT_COMMAND_TEMPLATE` or the adapter-specific env var. |
| `tests/test_code_agent_matrix.py` | Unit + mock-run tests covering task loading, scoring, command template generation, and mock matrix runs. |

## Supported adapters

`elizaos` and `opencode` (passed via `--adapter` to `agent_command.py`). Additional adapters can be wired in via the `CLAW_EVAL_AGENT_COMMAND_TEMPLATE_<ADAPTER>` environment variable.

## Scoring

Tasks are filtered to those with only deterministic check types (no `llm_judge` components). Each component is scored 0–1 and weighted to produce a per-task score; a task is considered passing at ≥ 0.75.
