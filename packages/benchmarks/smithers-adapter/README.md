# smithers-adapter

Benchmark adapter for the **Smithers** agent harness (`smithers-orchestrator`,
a Bun + JSX durable workflow engine — https://github.com/smithersai/smithers).

It exposes a one-shot per-turn primitive, API-compatible with `hermes-adapter`
and `openclaw-adapter`, so the orchestrator can run the same benchmarks against
the `smithers` harness (`--agent smithers`).

## How it works

Each turn spawns a one-shot `bun` process running `smithers_adapter/smithers_turn.mjs`
inside the Smithers install directory. That script drives Smithers' own
`OpenAIAgent` (a `ToolLoopAgent` built on the Vercel `ai` SDK) for a single turn
against an OpenAI-compatible endpoint (Cerebras `gpt-oss-120b` by default), and
emits one JSON line: `{"text", "thought", "actions", "params": {"tool_calls", "usage"}}`.

Tools are declared **without** an `execute` handler, so the agent returns the
emitted tool calls for the benchmark runner to score instead of executing them
— exactly what single-turn benchmarks (BFCL, action-calling) need.

The model is forced onto the chat-completions endpoint via `provider.chat(model)`
because OpenAI-compatible backends such as Cerebras don't implement the newer
`/responses` endpoint `@ai-sdk/openai` defaults to.

## Install

The harness needs `bun` on PATH and `smithers-orchestrator` installed. The
standard location mirrors the openclaw install convention:

```
~/.eliza/agents/smithers/<version>/   # contains node_modules + package.json
```

Resolution precedence: `SMITHERS_DIR` env → `~/.eliza/agents/smithers/manifest.json`
→ newest versioned subdir → `~/.eliza/agents/smithers/0.21.0`.

```bash
mkdir -p ~/.eliza/agents/smithers/0.21.0 && cd $_
bun add smithers-orchestrator@0.21.0 @ai-sdk/openai ai zod
```

## Run a benchmark

```bash
cd packages/benchmarks
CEREBRAS_API_KEY=... python -m orchestrator.cli run \
  --model-profile cerebras-gpt-oss-120b \
  --benchmarks bfcl \
  --agent smithers
```

## GEPA prompt optimization

Smithers ships GEPA-style reflective prompt optimization
(`smithers optimize workflow.tsx --cases evals/*.jsonl --provider cerebras`).
See `docs/SMITHERS_INTEGRATION.md` for how an optimized prompt artifact can be
fed back into a benchmark workflow to lift scores.
