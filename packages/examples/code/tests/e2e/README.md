# Deterministic real-agent app-build e2e

Proves the **orchestrator → real eliza-code coding agent → plan/tool/file-write →
task_complete** pipeline end-to-end, deterministically, with **no live LLM**.

This is a *real* agent, not a fake/stub one. The only thing mocked is the model
**provider** (an OpenAI-compatible HTTP endpoint): the agent's provider is
pointed at a local record/replay proxy that serves a recorded "ideal"
gemma-4-31b session. Everything else is the production code path — the
orchestrator's `AcpService` spawns the same `src/acp.ts` ACP agent the live bot
uses (`codingOnly`), the agent plans, calls `fs/write_text_file`, and the
orchestrator executes those writes into a real workspace.

## Files

- `deterministic-app-build-replay.mjs` — the driver. Spawns the real agent via
  `AcpService`, sends the exact recorded prompt, asserts it builds a sane
  `index.html` with `stopReason === "end_turn"`.
- `llm-record-replay-proxy.mjs` — OpenAI-compatible record/replay proxy. In
  `record` it forwards to Cerebras and captures raw response bodies (handles SSE
  streaming) while absorbing 429 TPM rate-limits with backoff; in `replay` it
  serves recorded responses keyed by a volatile-normalized hash of
  `(model, messages, tools)`, with sequential fallback.
- `fixtures/random-color-gemma-session.json` — the recorded gemma-4-31b session.

## Run

Prerequisite (once per checkout): `bun install` at the repo root, which runs the
core codegen this from-source run needs. If you skipped the postinstall codegen,
run it explicitly: `node packages/shared/scripts/generate-keywords.mjs --target ts`.

Replay (default — **keyless, no live LLM, deterministic**, safe for CI):

```bash
bun run --cwd packages/examples/code e2e:deterministic-replay
# equivalently, from packages/examples/code:
bun --conditions eliza-source --tsconfig-override ../../../tsconfig.json \
  tests/e2e/deterministic-app-build-replay.mjs
```

Re-record the fixture against live Cerebras gemma-4-31b (needs a key):

```bash
LLM_MODE=record CEREBRAS_API_KEY=csk-... \
  bun --conditions eliza-source --tsconfig-override ../../../tsconfig.json \
  tests/e2e/deterministic-app-build-replay.mjs
```

## Why the fixed workspace

Record and replay use a **fixed** workspace path (reset clean each run), not a
per-run temp dir. Replaying an agentic loop is only deterministic when the
filesystem context is identical: the agent's tool results (file reads/writes,
git state) feed back into the conversation, so a different workspace would make
requests drift off the recorded turn sequence. The proxy additionally normalizes
volatile tokens (paths, UUIDs, timestamps) out of the match key.

The replay proxy also rewrites recorded workspace paths inside model responses
to the current fixed workspace. That keeps a fixture recorded on macOS usable on
Linux CI, where `/tmp/eliza-det-replay-workspace` is the real write target.

Re-record whenever the agent's prompt scaffolding or the orchestrator's ACP
event mapping changes in a way that alters the request sequence.
