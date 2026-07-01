# #10757 / #8795 — live-LLM scenario lane on a subscription-only host (CLI provider)

Proof that `eliza-scenarios` can run a **live-only** scenario end-to-end on a host
with **no API key**, using the TOS-clean `@elizaos/plugin-cli-inference` backend
(`ELIZA_CHAT_VIA_CLI=claude` cold-spawns `claude --print` per call; the CLI reads
`~/.claude/.credentials.json` itself — eliza never sees the token).

## What changed

- `packages/core/src/testing/live-provider.ts` — new `"cli"` live provider:
  available when `ELIZA_CHAT_VIA_CLI` names a valid backend (`claude`,
  `claude-sdk`, `codex`, `codex-sdk`) **and** that backend's own on-disk
  credentials file exists (`~/.claude/.credentials.json` for claude*,
  `~/.codex/auth.json` for codex*). Appears in `availableProviderNames()` and
  `selectLiveProvider()` with `pluginPackage: "@elizaos/plugin-cli-inference"`,
  a clearly-labeled sentinel `apiKey`
  (`cli-subscription:no-api-key-cli-reads-own-credentials`), and env
  passthrough of `ELIZA_CHAT_VIA_CLI` / `ELIZA_PLANNER_NATIVE_TOOLS` / the
  `ELIZA_CLI_*` knobs. Kept **last** in preference order — any real API key
  (or Eliza Cloud key) always wins.
- `packages/scenario-runner/src/runtime-factory.ts` — when the `cli` provider
  serves the runtime, registers a `TEXT_SMALL → TEXT_LARGE` bridge plugin:
  plugin-cli-inference intentionally registers large-tier handlers only
  (TEXT_LARGE / TEXT_MEGA / RESPONSE_HANDLER, plus ACTION_PLANNER in
  text-planner mode) and core's fallback chains have no small→large edge, so
  without the bridge the scenario path's small-tier triage calls would find no
  handler. TEXT_EMBEDDING is already covered by the runner's existing
  zero-vector fallback.
- `packages/scenario-runner/src/cli.ts` — the "no LLM provider" refusal message
  now documents the subscription route.
- Unit tests: `packages/core/src/testing/live-provider.test.ts` (8 tests,
  temp-`HOME` hermetic — never touches the real `~/.claude`).

## Exact command

```bash
cd /home/shaw/eliza-worktrees/lifeops-audit
ELIZA_CHAT_VIA_CLI=claude ELIZA_PLANNER_NATIVE_TOOLS=0 ELIZA_CLI_TIMEOUT_MS=240000 \
  bun packages/scenario-runner/bin/eliza-scenarios run \
  plugins/plugin-personal-assistant/test/scenarios \
  --scenario brush-teeth-basic \
  --report <run>/report.json --run-dir <run>/run
```

- Backend: `claude` (cold-spawn `claude --print`, default model
  `claude-opus-4-7`); `@anthropic-ai/claude-agent-sdk` is not installed in this
  worktree, so the warm `claude-sdk` backend was not used.
- Host state during the run: **no** GROQ/OPENAI/ANTHROPIC/GOOGLE/OPENROUTER key,
  no Eliza Cloud key; `~/.claude/.credentials.json` present (Claude Max
  subscription).
- Runner banner: `provider: cli`; runId `eda40050-168c-4c8f-b8bf-64b7ae15b6ac`.
- Duration: scenario 95.0 s total — turn 1 35.9 s, turn 2 59.0 s (each turn is
  several cold `claude` spawns: planner + response handler + retries).

## Result — the lane works; the scenario failed on assertions

Both turns produced **real model replies** and real planner-routed actions
(see `report.json`):

- Turn 1 (`brush-teeth preview`): reply
  `"— I've set a daily reminder to brush your teeth at 8 AM and 9 PM."`,
  planner called `SCHEDULED_TASKS_CREATE` 3×.
- Turn 2 (`brush-teeth confirm`): reply
  `"Saved. I'll remind you to brush your teeth every day at 8 AM and 9 PM."`,
  planner called `SCHEDULED_TASKS_CREATE` 4×. **All turn-2 assertions passed.**

Final status: `failed` — honestly recorded, with why:

1. `responseIncludesAny` (turn 1): the scenario wants one of
   `[brush teeth, brushing habit, set that up]`; the model said
   "brush **your** teeth", which is not a substring match. Phrasing
   brittleness in the scenario, not a lane failure.
2. `definitionCountDelta` final check: expected 1 new "Brush teeth" habit
   definition; the model instead created scheduled reminders via
   `SCHEDULED_TASKS_CREATE`, whose first attempts bounced on
   `MISSING_TRIGGER` / a `expression.trim` error inside the scheduled-task
   create path (LifeOps trigger-schema behavior under concurrent repair on this
   branch), so no habit definition matching the title existed at check time.

Neither failure is in the provider plumbing: the CLI provider was selected,
`plugin-cli-inference` registered and served ACTION_PLANNER + RESPONSE_HANDLER +
TEXT_LARGE, the small-tier bridge engaged, trajectories recorded real LLM calls
(e.g. a `RESPONSE_HANDLER` stage with latency 5.7 s returning
`{"contexts":["tasks","automation"],"intents":["schedule recurring reminder"],...}`),
and the run viewer + report + native matrix were all written.

## Artifacts

- `report.json` — full machine-readable scenario report (`providerName: "cli"`).
- `console-excerpt.log` — runner log excerpt: provider selection, cli-inference
  enablement, bridge registration, scenario result, totals.
- `run-dir-listing.txt` — `--run-dir` contents: `viewer/index.html`,
  `matrix.json`, and two trajectory JSONs with the real LLM call records.

## Honest caveats

- Cold-spawn `claude` is slow (~30–60 s per turn). For regular use install
  `@anthropic-ai/claude-agent-sdk` and use `ELIZA_CHAT_VIA_CLI=claude-sdk`
  (warm session, ~1–2 s per call after warm-up).
- The proof run exits 1 because of the two assertion failures above; the model
  genuinely responded on every turn. The lane-gating change (exit 2 "no LLM
  provider" refusal) is what this evidence targets, and that gate now passes on
  a subscription-only host.
- `smallModel`/`largeModel` on the `cli` provider config both name the same
  subscription-served model; small-tier calls route through the bridge to
  TEXT_LARGE by design.
