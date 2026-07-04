# ui-ux-polish — real-LLM evidence index

Real-model proof for the UI/UX polish work (issue #12061, PR #12062). The
authoritative real-LLM artifact is a **live scenario trajectory** that drives a
real model through the full agent loop; a supplementary browser capture records
the chat composer wiring a real send into the live stack.

## Provider / model actually used

- **Plugin:** `@elizaos/plugin-openai` (scenario `providerName: "openai"`).
- **Endpoint:** `OPENAI_BASE_URL = https://api.cerebras.ai/v1` — i.e. the
  OpenAI-compatible plugin is pointed at **Cerebras**.
- **Model:** `llama-3.3-70b` (`OPENAI_LARGE_MODEL` / `OPENAI_SMALL_MODEL`).
- **Key source:** `CEREBRAS_API_KEY` / `OPENAI_API_KEY` (`csk-…`) discovered in
  the workspace `.env` (parent worktree). Secret not printed.
- Not a mock and not the deterministic LLM proxy: the deterministic lane uses
  provider name `deterministic` and `SCENARIO_USE_LLM_PROXY=1`; this run used
  neither. `costUsd` is metered and the runtime cleared the wire-mock base-URL
  overrides for the live provider.

Live-lane runtime note: the scenario runs with `ELIZA_PLANNER_NATIVE_TOOLS=0`
(text-planner path). Cerebras's OpenAI-compatible endpoint rejects tool JSON
schemas that carry `anyOf`/`oneOf` at the top level, so native tool-calling is
disabled and the model routes actions through the text control-envelope planner
— which is exactly the path captured in the trajectories below.

## The real user -> model -> assistant exchange

Scenario **`background-live`** — "Real LLM drives BACKGROUND
set/undo/redo/reset from chat". The model must itself route each natural-language
message to the `BACKGROUND` action; assertions pin the action op
(`values.op` + broadcast ledger), never the reply phrasing.

Fresh re-verification run (2026-07-03T21:08Z, provider=openai/Cerebras,
**passed**, all 4 turns):

| user message | live assistant reply | action op fired |
| --- | --- | --- |
| Please make my background dark blue. | I've updated your background to dark blue for you. | `BACKGROUND set` -> `#1e3a8a`, mode shader |
| Undo the background change. | Done. I've reverted your background to what it was before. | `BACKGROUND undo` |
| Actually, redo the background change. | Done! I've redone the background change for you. | `BACKGROUND redo` |
| Reset the background to the default. | Background reset to default. | `BACKGROUND reset` |

The original committed run (`run/`, 2026-07-03T20:11Z) produced the *same
behavior with different wording* — e.g. turn 1 replied "I've set your background
to dark blue." vs the re-verify "I've updated your background to dark blue for
you." The divergent phrasing across runs is direct evidence of a live,
non-deterministic model rather than canned/mock output.

Inside a trajectory the model's own reasoning is captured, e.g. the Stage-4
RESPONSE_HANDLER evaluation for turn 1:

> "success": true, "decision": "FINISH", "thought": "The user requested the
> background to be dark blue. I called the BACKGROUND tool with the specified
> color, and the tool successfully returned a confirmation that the background
> was set to #1e3a8a (dark blue).", "messageToUser": "I've set your background
> to dark blue."

Each trajectory has 5 real stages: RESPONSE_HANDLER (plan) -> tool search ->
ACTION_PLANNER -> tool exec (`BACKGROUND`) -> RESPONSE_HANDLER (evaluation).

## Artifacts

### Scenario trajectories (authoritative real-LLM proof)

- `run-reverify-20260703/matrix.json` — fresh re-verification report; 1/1
  passed, provider `openai`, 4 turns with user text + live reply + action ops.
- `run-reverify-20260703/trajectories/546ac.../tj-*.json` — 4 full per-turn
  trajectories (5 stages each) from the fresh live run.
- `run-reverify-20260703/viewer/index.html` — standalone run viewer for the
  fresh run.
- `report.json` — original committed report (2026-07-03T20:11Z), 1/1 passed.
- `run/matrix.json` + `run/trajectories/546ac.../tj-*.json` — original live
  trajectories (~130 KB each), full 5-stage agent loop.
- `run/viewer/index.html` — original run viewer.

### Browser chat composer capture (supplementary, records a send error)

- `chat-e2e/01-chat-ready.png` … `04-assistant-replied.png` — the app served by
  the live ui-smoke stack; a real message is typed and sent.
- `chat-e2e/chat-input-exchange.json` — captured exchange. **The composer sent a
  real message to the real stack, but the reply errored**: `assistantText =
  "Something went wrong on my end. Please try again."` (visible in
  `04-assistant-replied.png`). This capture therefore proves the composer is
  wired to the real backend send path, but it is **not** a successful
  live-reply-through-the-UI — the scenario trajectories above are the
  authoritative real-model proof.
- `chat-e2e/chat-input-live.webm` (~545 KB) — screen recording of the flow.
- `chat-e2e/chat-input-network.har` (~38 MB) — full HAR of the session.
- `chat-e2e/chat-input-console.txt`, `chat-input-network.txt` — console +
  network logs.
- `chat-input-evidence.mjs` — the committed Playwright capture script (live
  ui-smoke stack, no mocks).

### Stale / superseded

- `runs/` (plural, 20:11 earlier) — an early aborted attempt; `scenario-run.log`
  shows it fatally failed to resolve `@elizaos/plugin-openai` before any model
  call. Kept only for provenance; the real run is `run/` (singular) and the
  fresh `run-reverify-20260703/`.

## How to reproduce

```bash
cd packages/scenario-runner
set -a; source <worktree>/.env; set +a
unset GROQ_API_KEY GROQ_LARGE_MODEL GROQ_SMALL_MODEL   # force the openai(=Cerebras) provider
export ELIZA_PLANNER_NATIVE_TOOLS=0 ELIZA_SAVE_TRAJECTORIES=1
bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios/background-live.scenario.ts \
  --report-dir <out> --run-dir <out>
```
