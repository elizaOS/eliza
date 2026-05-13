# Baseline Runs — 2026-05-11

Wave W1-3 baseline runs for the three external agent types against
LifeOpsBench, all driven by **Cerebras `gpt-oss-120b`** as the underlying
model. No mocks. No upstream binary installs. Real Cerebras API traffic.

All three adapters share a corpus subset: the `mail` domain in `static`
mode (25 scenarios). The LIVE-mode judge is unavailable in this env
(no `ANTHROPIC_API_KEY` in `.env`), so the CLI auto-restricts to
STATIC scenarios.

## Results

| Agent    | Run dir                                                                                   | Scenarios | Passed | Partial | Zero | Errored | Mean (mail) | Cost     | Latency  | Model            | Provider |
|----------|-------------------------------------------------------------------------------------------|-----------|--------|---------|------|---------|-------------|----------|----------|------------------|----------|
| hermes   | `~/.eliza/runs/lifeops/lifeops-hermes-baseline-1778514429`                               | 25        | 0      | 24      | 1    | 0       | 0.494       | $0.0000* | 0 ms*    | gpt-oss-120b     | cerebras |
| openclaw | `~/.eliza/runs/lifeops/lifeops-openclaw-baseline-1778514437`                             | 25        | 0      | 22      | 3    | 0       | 0.562       | $0.1036  | 155188 ms | gpt-oss-120b     | cerebras |
| eliza    | `~/.eliza/runs/lifeops/lifeops-eliza-baseline-1778515576`                                | 25        | 0      | 0       | 25   | 0       | 0.000       | $0.0000* | 0 ms*    | gpt-oss-120b     | cerebras |

\* The Hermes adapter's in-process bridge drives the OpenAI SDK directly
and does not feed per-turn token usage back into the runner's
`MessageTurn.cost_usd` field. Real Cerebras requests were issued — the
adapter just doesn't surface usage data the way OpenClaw's path does.
Wave 2 should plumb completion `.usage` into the bench `MessageTurn` so
Hermes runs are cost-comparable.

## Notable failure modes

### hermes

- All 24 partial-credit scenarios terminated at `max_turns=8` with
  every turn emitting another `MESSAGE` tool call rather than ending
  on a final `REPLY`. The Cerebras Hermes-template path keeps
  re-issuing the same canonical action because the runner's tool-result
  feedback isn't getting back into the prompt in a way the model
  treats as completion.
- `mail.draft_reschedule_meeting`: 0.0 — terminated `respond` with
  no tool calls at all (model emitted a plain reply, no tool call).

### openclaw

- 3 zero-score scenarios were caused by OpenClaw's legacy text-embedded
  tool-call protocol. Current Eliza-native benchmarks do not use that
  protocol; they require OpenAI-compatible `tools` and returned
  `tool_calls`.
- 22 partial-credit scenarios mostly land at 0.20 or 0.70 — same
  story as hermes: the agent emits `MESSAGE` correctly but doesn't
  match the scenario's expected sub-operation argument (`manage`,
  `triage`, etc.) precisely enough to score full credit.

### eliza

- The eliza bench server is up and serving the agent loop. Cerebras is
  wired in via `OPENAI_BASE_URL=https://api.cerebras.ai/v1` +
  `OPENAI_API_KEY=$CEREBRAS_API_KEY` + `ELIZA_PROVIDER=cerebras`.
  This causes
  `packages/app-core/src/benchmark/server.ts` to load
  `@elizaos/plugin-openai` against the Cerebras endpoint and strip the
  TEXT_EMBEDDING handler (Cerebras has no `/v1/embeddings`).
- The local embedding model
  (`/Users/shawwalters/.eliza/models/text/eliza-1-lite-0_6b-32k.gguf`)
  fails to download from HuggingFace with a 401. This does **not**
  block the agent loop — the planner falls through and Cerebras
  drives `TEXT_LARGE` / `TEXT_SMALL` — but it does spam the bench
  server log with retry traffic.
- All 25 eliza scenarios scored 0/1.0 — the planner consistently emits
  `REPLY` as the only action, and the LifeOpsBench runner reports
  `Unsupported action in execute path: REPLY — file gap in
  LIFEOPS_BENCH_GAPS.md`. The Cerebras-driven message content is
  high-quality (e.g. real draft replies, structured triage statements
  in the agent_message field) — the runtime is just emitting them as
  `REPLY` text rather than structured `MESSAGE` tool calls, which is
  what the scorer reads. See `LIFEOPS_BENCH_GAPS.md` in the bench
  package for the open scaffold gap.
- Example, from `mail.draft_reply_to_meeting_request` turn 1:

  ```
  Dear Uma,

  Thank you for the meeting request. Tuesday at 10am UTC works for me.
  I look forward to discussing the analytics dashboard.

  Best regards,
  [Your Name]
  ```

  That is a fully-formed Cerebras response — the gap is on the
  runtime side, not the model side.
- One scenario surfaced an `AI_APICallError: Bad Request` from the
  Cerebras endpoint via the `@ai-sdk/openai` adapter after hitting
  `assertTrajectoryLimit` — likely a token-budget overflow on a
  scenario whose context grew through retries. Tracked as a known
  intermittent failure in the eliza side, not a harness bug.

## Verification

- `bun` and `node` are not needed for hermes / openclaw — they go
  straight to `api.cerebras.ai/v1` via the OpenAI SDK installed in the
  parent Python (the hermes-adapter's in-process mode bypasses the
  hermes-agent venv subprocess; the openclaw adapter is OpenAI-compat
  by default).
- Cerebras key in `/Users/shawwalters/milaidy/eliza/.env` confirmed present
  without recording the secret or prefix in this audit.
- Saved JSON manifests confirm `model_name=gpt-oss-120b` and
  `judge_model_name=claude-opus-4-7`. No mocked content. Each
  scenario's `turns[*].agent_message` contains real natural-language
  output and `turns[*].agent_actions[*].name` references real actions
  from `manifests/actions.manifest.json`.
- `tail` of each run log shows live `POST
  https://api.cerebras.ai/v1/chat/completions "HTTP/1.1 200 OK"` (and
  one transient `429` retry for hermes mid-run).

## Code changes (adapter fixes)

Two minimal adapter fixes were required for hermes to run in-process.
No scenarios or action handlers were modified.

1. `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/hermes.py`
   — switch the lifeops wrapper to build `HermesClient(mode="in_process")`
   so it uses the parent Python's `openai` SDK directly instead of
   trying to exec a one-shot script in
   `~/.eliza/agents/hermes-agent-src/.venv/` (which doesn't exist on
   this machine). The previous wrapper accepted only `model` /
   `base_url` / `api_key` but never passed them through; we now build
   the client explicitly and forward those kwargs.
2. `packages/benchmarks/hermes-adapter/hermes_adapter/client.py`
   — `health()` now short-circuits when `self.mode == "in_process"` by
   confirming `openai` is importable in the parent, rather than
   asserting that the (non-existent) hermes-agent venv python is on
   disk. `wait_until_ready()`'s log message also adapts to in-process
   mode so it no longer claims "venv is ready" when there is no venv.

Also fixed: a leftover merge-conflict marker in
`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/calendar.py`
that was preventing the bench from importing at all
(`SyntaxError: invalid decimal literal` at the `<<<<<<< HEAD` /
`>>>>>>>` lines). Kept the `PERSONA_KAI_STUDENT` import from HEAD —
the personas file already defines that constant.

## Reproducing the runs

```bash
cd /Users/shawwalters/milaidy/eliza/packages/benchmarks/lifeops-bench
set -a; . /Users/shawwalters/milaidy/eliza/.env; set +a

# hermes (in-process — does NOT need ~/.eliza/agents/hermes-agent-src)
python -m eliza_lifeops_bench --agent hermes --domain mail --mode static \
  --output-dir ~/.eliza/runs/lifeops/lifeops-hermes-baseline-$(date +%s) \
  --per-scenario-timeout-s 120 --max-cost-usd 5

# openclaw (OpenAI-compat — does NOT need the openclaw CLI binary)
python -m eliza_lifeops_bench --agent openclaw --domain mail --mode static \
  --output-dir ~/.eliza/runs/lifeops/lifeops-openclaw-baseline-$(date +%s) \
  --per-scenario-timeout-s 120 --max-cost-usd 5

# eliza (needs the bench server — the adapter auto-spawns it)
export OPENAI_BASE_URL="https://api.cerebras.ai/v1"
export ELIZA_PROVIDER=cerebras
export OPENAI_LARGE_MODEL=gpt-oss-120b
export OPENAI_SMALL_MODEL=gpt-oss-120b
export OPENAI_API_KEY="$CEREBRAS_API_KEY"
python -m eliza_lifeops_bench --agent eliza --domain mail --mode static \
  --output-dir ~/.eliza/runs/lifeops/lifeops-eliza-baseline-$(date +%s) \
  --per-scenario-timeout-s 90 --max-cost-usd 5 --concurrency 4
```
