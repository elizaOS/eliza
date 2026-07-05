# openclaw CLI-native investigation — #13777 / #13766

The prior multitask-bench evidence ran the openclaw lane through the direct
OpenAI-compat shim (`OPENCLAW_DIRECT_OPENAI_COMPAT=1`) and labeled it
**"partial, not CLI-native"** on the premise that the openclaw CLI hard-rejects
`gpt-oss-120b` (`FailoverError: Unknown model`) and that custom-model
registration is *undocumented*. This directory records the deeper
investigation. **Model:** `gpt-oss-120b` on Cerebras. **CLI:** `OpenClaw
2026.6.11`. **Date:** 2026-07-05.

## Finding 1 — the rejection is NOT a wall, and it IS documented (myth busted)

Reading the CLI's own `dist/model-*.js` resolver, `Unknown model` means only
that the model is absent from the *built-in catalog*. openclaw resolves it
through **custom OpenAI-compatible provider registration**
(`models.providers.<id>` with `baseUrl` + `api: openai-completions` + a
`models[]` entry). The error message the prior agent hit literally ends with:

> …Add `{ "id": ..., "name": ... }` to `models.providers[...].models[]`… For
> custom or proxy providers, also set `api` and `baseUrl`… See
> https://docs.openclaw.ai/concepts/model-providers.

So it is documented at the exact URL the CLI prints, and the CLI has
non-interactive `config patch` / `config set` helpers to write it. The
"undocumented" claim was wrong.

- **`cerebras.openclaw.json5`** — the exact key-free config applied into an
  isolated `bench-cerebras` profile (apiKey is a SecretRef to
  `$CEREBRAS_API_KEY`; the key is never on disk). Apply with
  `openclaw --profile bench-cerebras config patch --file cerebras.openclaw.json5`.
- **`models-list.txt`** — `cerebras/gpt-oss-120b … Auth: yes … default`. The
  model resolves; no FailoverError.

## Finding 2 — one live CLI-native turn works end-to-end (proven)

- **`smoke-turn.json`** — `openclaw agent --local --json --model
  cerebras/gpt-oss-120b --thinking medium` output: `{"payloads":[{"text":
  "PONG"}]}`, real `usage` (total 20007, reasoningTokens 36), full
  agent-harness metadata. The real `openclaw agent` tool-loop, not the shim.
- **`smoke-turn.transport.txt`** — the live provider call:
  `provider=cerebras api=openai-completions … url=https://api.cerebras.ai/v1/chat/completions
  status=200`, `[agent] run … ended with stopReason=stop`.

## Finding 3 — CLI-native LifeOpsBench *scoring* is blocked by a real CLI boundary (honest limitation)

- **`multitask-openclaw-cli-native-N1.json`** — the multitask-bench openclaw
  lane, run **CLI-native** (`OPENCLAW_USE_CLI=1`, no shim), N=1: 10/10
  completed, **`mean_score=0.000`**, `turns=1` per task, `tokens=0`.
- **`cli-native-scoring-gap-trajectory.json`** — why. The `openclaw agent`
  command owns its own tool execution; it has no mode to accept a
  benchmark-injected tool catalog and hand back *unexecuted* structured
  `tool_calls` for the harness to run against its own LifeWorld. On the CLI
  path the benchmark tools are flattened into the `--message` text as
  **context-only** (the prompt says so verbatim), so the model:
  1. emits its intended tool call as **JSON text inside the assistant
     message** (`{"name":"CALENDAR_SEARCH_EVENTS", …}`) instead of a structured
     `tool_calls` array — the LifeOpsBench runner parses the structured slot,
     finds nothing, and scores 0; and
  2. on multi-turn scenarios hits **`Context overflow: prompt too large`**
     because the whole conversation + catalog is re-flattened into one string.

This is an **architectural boundary of the `openclaw agent` CLI** (it executes
tools itself and returns natural-language `payloads`), not a config gap. It is
exactly the limitation the adapter README's original caveat described — the fix
for that caveat is to state it precisely, not to relabel the shim as native.

## Bottom line

- **CLI-native provider registration**: solved, documented, proven live.
- **The `FailoverError` / "undocumented" story**: corrected in the code and
  docs.
- **CLI-native LifeOpsBench score parity**: not achievable through the
  `openclaw agent` CLI as it exists in 2026.6.11 — the direct-compat path
  remains the only transport that yields structured `tool_calls` the
  benchmark scorer can execute, and it stays disclosed as partial. The
  published scalar for the openclaw lane therefore continues to come from the
  disclosed direct-compat path; the CLI-native path is the real agent but
  cannot be scored against a harness-owned tool world.
