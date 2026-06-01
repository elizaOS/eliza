# LOCA-bench — Agent Guide

Evaluates language agents under extreme and controllable context growth (Long-Context Abilities of Agents). Tasks span 15 environment types at 8K–256K token context sizes. Vendored from [hkust-nlp/LOCA-bench](https://github.com/hkust-nlp/LOCA-bench) with an elizaOS harness layer in `eliza_loca/`. Not registered in the suite orchestrator — run directly via the `loca` CLI.

## Run

```bash
# From this directory, after installation
loca run -c task-configs/final_8k_set_config.json -m deepseek-reasoner --max-context-size 130000

# Claude Code / Anthropic API path (requires LOCA_ANTHROPIC_API_KEY)
loca run-claude-agent -c task-configs/final_8k_set_config.json
loca run-claude-api   -c task-configs/final_8k_set_config.json -m claude-sonnet-4-5
```

Context-size presets available in `task-configs/`: 8K, 16K, 32K, 64K, 96K, 128K, 256K.

## Context management strategies

| Flag | Strategy |
|------|----------|
| (default) | `react` — basic ReAct |
| `-s ptc` | Programmatic Tool Calling |
| `-s memory_tool` | Persistent memory across turns |
| `--context-reset` | Clear tool-result history at threshold |
| `--thinking-reset` | Clear thinking blocks at threshold |

## One-time setup

```bash
# uv (recommended)
uv venv --python 3.10 && source .venv/bin/activate
bash install.sh   # installs Python deps + Node + npm MCP packages
```

Requires `LOCA_OPENAI_API_KEY` + `LOCA_OPENAI_BASE_URL` for the default path, or `LOCA_ANTHROPIC_API_KEY` for the Claude paths.

## Test the harness

```bash
pip install -e .
pytest tests/ -v
```

## Layout

| Path | Role |
|------|------|
| `loca/cli/` | `loca` CLI entry point (`loca.cli.main:app`) |
| `task-configs/` | Preset configs by context size (8K–256K, plus `debug.json`) |
| `gem/envs/` | 15 task environment implementations |
| `eliza_loca/` | elizaOS harness: Cerebras runner, proxy, trajectory audit, long-context utils |
| `mcp_convert/` | Local mock MCP servers (Calendar, Email, BigQuery, Sheets, etc.) |
| `tests/` | pytest suite for `eliza_loca` harness |
| `vis_traj/server.py` | Web-based trajectory replayer |
| `install.sh` | One-shot dependency installer |

## Notes

- Results write to `outputs/inf_{strategy}_{config}_{model}_{params}_{timestamp}/` (gitignored).
- Key output files: `results.json` (aggregate), `all_trajectories.json` (per-task trajectories), `eval.json` per task state.
- Not registered in the suite orchestrator (`registry/commands.py`) — no `--benchmarks` shorthand.
- Full background: [README.md](README.md).
