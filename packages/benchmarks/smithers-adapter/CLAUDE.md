# Smithers Adapter — Agent Guide

Harness bridge that lets the benchmark orchestrator run benchmarks against the
**Smithers** agent (`smithers-orchestrator`, a Bun + JSX durable workflow engine).
API-compatible with `hermes-adapter` and `openclaw-adapter`; select it with
`--agent smithers`. Not registered as a standalone benchmark — it wraps other
benchmarks (BFCL, action-calling, etc.) run against the Smithers harness.

Each turn spawns a one-shot `bun` process running `smithers_turn.mjs` inside
the Smithers install directory. The script drives Smithers' `OpenAIAgent`
(ToolLoopAgent on the Vercel `ai` SDK) for one turn against an OpenAI-compatible
endpoint (Cerebras `gpt-oss-120b` by default) and emits one JSON line.

## Install

Requires `bun` on PATH and `smithers-orchestrator` installed:

```bash
mkdir -p ~/.eliza/agents/smithers/0.22.0 && cd $_
bun add smithers-orchestrator@0.22.0 @ai-sdk/openai ai zod
```

Install the Python package (from `packages/benchmarks/`):

```bash
pip install -e smithers-adapter/
```

## Run

```bash
# Run BFCL against the Smithers harness (from packages/benchmarks/)
CEREBRAS_API_KEY=... python -m orchestrator.cli run \
  --model-profile cerebras-gpt-oss-120b \
  --benchmarks bfcl \
  --agent smithers
```

Override the install directory with `SMITHERS_DIR` env if not using the default
`~/.eliza/agents/smithers/` location.

## Test the harness

```bash
pip install -e smithers-adapter/[dev]
pytest smithers-adapter/tests/ -v
```

Tests are offline (no API keys or real Smithers install required).

## Layout

| Path | Role |
| --- | --- |
| `smithers_adapter/client.py` | `SmithersClient` — one-shot turn via `bun` subprocess |
| `smithers_adapter/smithers_turn.mjs` | Bun script materialized next to `node_modules` |
| `smithers_adapter/server_manager.py` | `SmithersManager` — lifecycle (health check + script materialization) |
| `smithers_adapter/bfcl.py` | `SmithersBFCLAgent` — BFCL-runner-compatible wrapper |
| `smithers_adapter/agentbench.py` | AgentBench adapter |
| `smithers_adapter/tau_bench.py` | Tau-bench adapter |
| `smithers_adapter/swe_bench.py` | SWE-bench adapter |
| `smithers_adapter/terminal_bench.py` | Terminal-bench adapter |
| `smithers_adapter/context_bench.py` | Context-bench adapter |
| `smithers_adapter/clawbench.py` | ClawBench adapter |
| `smithers_adapter/woobench.py` | WooBench adapter |
| `tests/` | Offline pytest suite |

## Notes

- Not a registered benchmark — used as `--agent smithers` alongside any
  compatible benchmark in the orchestrator.
- Install resolution: `SMITHERS_DIR` env → `~/.eliza/agents/smithers/manifest.json`
  → newest versioned subdir → `~/.eliza/agents/smithers/0.22.0`.
- The harness script (`smithers_turn.mjs`) is copied from the Python package into
  the Smithers install dir at runtime so Bun can resolve bare imports from
  `node_modules`.
- Full background: [README.md](README.md).
