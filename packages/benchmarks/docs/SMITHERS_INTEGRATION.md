# Smithers harness integration

This documents how the **Smithers** agent harness (`smithers-orchestrator`,
https://github.com/smithersai/smithers — a Bun + JSX durable workflow engine)
is wired into the benchmark suite as a fourth harness alongside
`eliza`, `hermes`, and `openclaw`.

## What Smithers is

Smithers is a durable control plane for long-running coding agents: you author
workflows as `.tsx` (JSX components `<Workflow>`, `<Task>`, `<Sequence>`,
`<Parallel>`, `<Branch>`, `<Ralph>`), run them for minutes-to-days, and get
crash recovery, retries, approvals, replay, evals, and GEPA-style prompt
optimization. State persists to SQLite; tasks validate against Zod schemas.

For benchmarking we don't need the durable workflow engine per turn — we need a
single-turn primitive: *given messages + tools, produce one model response with
token usage*. Smithers exposes exactly that through its **`OpenAIAgent`** (a
`ToolLoopAgent` built on the Vercel `ai` SDK), which the adapter drives directly.

## Architecture

```
orchestrator → bfcl runner (BENCHMARK_HARNESS=smithers)
  → smithers_adapter.bfcl.SmithersBFCLAgent
    → SmithersClient.send_message(text, context)      [Python]
      → spawn: bun run smithers_turn.mjs               [one-shot subprocess]
        → new OpenAIAgent({ model: provider.chat(model) })  [Smithers / ai SDK]
          → Cerebras /v1/chat/completions (gemma-4-31b)
      ← {text, thought, actions, params:{tool_calls, usage}}  [one JSON line]
```

Key decisions:

- **Per-turn `bun` subprocess.** Mirrors the hermes (venv subprocess) and
  openclaw (CLI subprocess) pattern. The orchestrator never imports Bun/Smithers
  deps; it only needs `bun` on PATH and a resolved Smithers install.
- **Forced chat-completions.** `@ai-sdk/openai` v6 defaults bare model ids to
  the `/responses` endpoint, which Cerebras does not implement (404). The
  harness uses `provider.chat(model)` to force `/v1/chat/completions`.
- **Execute-less tools.** Benchmark tools are declared without an `execute`
  handler, so the `ToolLoopAgent` halts after emitting tool calls and returns
  them for the runner to score (BFCL is single-turn, no real tool execution).
- **Usage passthrough.** The `ai` SDK usage block (`inputTokens`,
  `outputTokens`, `totalTokens`, `cachedInputTokens`, raw provider counts) is
  normalized to the same telemetry shape hermes/openclaw write, so cost
  accounting reads Smithers runs identically.

## Files

| Path | Role |
| --- | --- |
| `smithers-adapter/smithers_adapter/smithers_turn.mjs` | One-shot per-turn Bun harness (canonical source; copied into the install dir at runtime so Bun resolves `smithers-orchestrator`). |
| `smithers-adapter/smithers_adapter/client.py` | `SmithersClient` — spawns the harness, parses output, writes telemetry. API-compatible with `HermesClient`. |
| `smithers-adapter/smithers_adapter/server_manager.py` | `SmithersManager` — thin lifecycle (validate bun + install, materialize script). |
| `smithers-adapter/smithers_adapter/bfcl.py` | `SmithersBFCLAgent` + `build_bfcl_agent_fn` — BFCL glue. |
| `orchestrator/adapters.py` | `SMITHERS_BENCHMARKS` gate + adapter path / ignored-dir registration. |
| `bfcl/runner.py`, `bfcl/__main__.py` | `smithers` dispatch branch. |

## Install

```bash
mkdir -p ~/.eliza/agents/smithers/0.22.0 && cd $_
bun add smithers-orchestrator@0.22.0 @ai-sdk/openai ai zod
```

Resolution precedence: `SMITHERS_DIR` env → `~/.eliza/agents/smithers/manifest.json`
→ newest versioned subdir → `~/.eliza/agents/smithers/0.22.0`. Requires `bun >= 1.3.0`.

## Run

```bash
cd packages/benchmarks
CEREBRAS_API_KEY=... BENCHMARK_HARNESS=smithers \
BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gemma-4-31b \
PYTHONPATH=smithers-adapter:hermes-adapter:openclaw-adapter:eliza-adapter \
.venv-standard/bin/python -m benchmarks.bfcl run --provider eliza --model gemma-4-31b --categories simple --sample 8
```

Verified live (measured on the previous default model, Cerebras
`gpt-oss-120b`): BFCL simple → **87.5% (7/8)** and **100% (3/3)** on small
samples — in range with hermes/openclaw (100% on the same samples).

## Extending coverage

The harness contract is benchmark-agnostic (`SmithersClient.send_message`).
To add another benchmark:

1. Add `smithers_adapter/<bench>.py` mirroring `hermes_adapter/<bench>.py`,
   swapping `HermesClient` → `SmithersClient`.
2. Add `"<bench>"` to `SMITHERS_BENCHMARKS` in `orchestrator/adapters.py`.
3. Add a `smithers` dispatch branch in that benchmark's runner (as in
   `bfcl/runner.py`).

Good next targets (single-turn / tool-calling, lowest friction):
`action_calling`, `clawbench`, `agentbench`, `mint`, `tau_bench`.

## GEPA prompt optimization

Smithers ships GEPA-style reflective prompt optimization:

```bash
smithers optimize workflow.tsx \
  --cases evals/cases.jsonl --suite bfcl-gepa \
  --provider cerebras --model gemma-4-31b \
  --artifact .smithers/optimizations/bfcl-gepa.json
```

GEPA discovers every `<Task>` prompt in a workflow, runs a **baseline eval**
over the case file, asks the optimizer model to emit prompt **patches**
(`{"patches":[{"nodeId","prompt","rationale"}]}`), re-runs the suite with the
candidate artifact, and writes the artifact only when the score improves by
`--minImprovement`. Score = `passRate * 0.8 + assertionPassRate * 0.2`.

**How to use it to compete in these benchmarks.** The Smithers BFCL agent uses a
fixed system prompt (`_DEFAULT_SYSTEM_PROMPT` in `bfcl.py`). To lift the score:

1. Express the BFCL turn as a one-`<Task>` Smithers workflow whose prompt is the
   system prompt + the query, with the expected function call(s) as the eval
   `expected`.
2. Build `evals/bfcl.jsonl` from a slice of BFCL cases.
3. Run `smithers optimize ... --provider cerebras` to evolve the prompt.
4. Feed the winning prompt back as `_DEFAULT_SYSTEM_PROMPT` (or load the artifact
   via `SMITHERS_OPTIMIZATION_ARTIFACT`).

This is Smithers' structural advantage in the comparison: the same harness that
runs the benchmark can *self-optimize* its prompts against a held-out eval slice
before the scored run, using a cheap Cerebras model as the patch generator.
