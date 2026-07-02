# #10694 — BACKGROUND action real-LLM scenario evidence

Live-model scenario runs for the new BACKGROUND coverage
(`plugins/plugin-app-control/test/scenarios/background-set-color.scenario.ts`,
`background-shader-undo-redo.scenario.ts`), captured against a **live**
Cerebras endpoint (provider `openai` in first-class Cerebras mode,
`OPENAI_LARGE_MODEL=gpt-oss-120b`, key sourced from the repo `.env`, never
logged — artifacts swept for `csk-`).

## Artifacts

- `report.json` — final run (run 4): per-turn text, responseText, every action
  call with parameters and results, per-check verdicts. This IS the trajectory.
- `run/trajectories/<agent>/tj-*.json` — per-message trajectory files (Stage-1
  RESPONSE_HANDLER prompt+raw output, toolSearch, planner stages with the full
  offered tool list, model provider/latency/token metrics).
- `run/viewer/index.html` — run viewer.
- `live-run.log` — full key-free CLI log (server `[ClassName]` lines included).

Deterministic-lane twin (zero-key, runs on every PR):
`packages/scenario-runner/test/scenarios/deterministic-background-actions.scenario.ts`
— 8 asserted action turns + an exact ordered `background:apply` broadcast
ledger. Green in `--lane pr-deterministic` (36/36 scenarios).

## Final live results (run 4)

| scenario | result |
| --- | --- |
| `background-set-color` | **PASSED** — model selected `BACKGROUND {op:"set", color:"teal"}` from "change the app background to teal"; handler broadcast exactly `{op:"set", mode:"shader", color:"#0891b2"}` (curated teal hex); exact-ledger custom check green. |
| `background-shader-undo-redo` | **FAILED (real finding, kept red)** — Stage-1 REPLY-larp: turns 1–3 answered in prose ("Here's a quick way to add a slow lava-lamp-style animated background using CSS…", "Reverting the background to its previous state." — claimed, no action). Only the reset turn routed `BACKGROUND {op:"reset"}` (succeeded, broadcast went out). Judge score 0.00. |

## Hand-read of the trajectories (what the model actually did)

Four live runs were executed while iterating; all were read by hand.

1. **Run 1 (pre-fix)** — every model stage returned empty output in ~90 ms with
   0 tokens. Root cause found in the trajectory: `prepareMockedTestEnvironment`
   exports `ELIZA_MOCK_OPENAI_BASE`, which is authoritative inside
   plugin-openai and silently rerouted "live" calls to the wire mock. Fixed in
   `packages/scenario-runner/src/runtime-factory.ts`
   (`clearLlmWireMockEnvForLiveProvider` — clears the mock LLM bases whenever a
   real provider is selected; the deterministic proxy lane keeps them).
2. **Run 2 (live wire, original phrasing)** — Stage-1 raw output read from
   `tj-*.json`: `{"processMessage":"RESPOND","plan":{"contexts":["simple"],
   "reply":"Here's a quick CSS snippet to set a teal background…",
   "requiresTool":false}}` — the model classified "make the background teal" as
   a generic coding question and answered with CSS; the planner never ran. On
   the reset turn it emitted `candidateActions:["SET_BACKGROUND"]` →
   planner (20 tools, BACKGROUND offered) → `BACKGROUND {op:"reset"}` executed.
   Also observed: the planner attempted `BACKGROUND {preset: ""}` on the
   lava-lamp turn and was rejected by enum validation — strict tool schemas
   force the model to emit every key, so `""` is its only "unset". Fixed in
   core (`dropEmptyOptionalArgs` in
   `packages/core/src/runtime/execute-planned-tool-call.ts`): empty-string
   values on declared OPTIONAL parameters are treated as omitted; required
   params still fail loudly. Unit-tested.
3. **Run 3 (app-anchored phrasing)** — "change the app background to teal" now
   routed BACKGROUND, but the planner stuffed `{op:"set", color:"teal",
   preset:"aurora"}` and the handler's explicit-preset precedence turned a teal
   color request into the aurora shader. Fixed in
   `plugins/plugin-app-control/src/actions/background.ts`: an explicit preset
   only outranks a resolvable color when the text itself asks for a shader
   (shader noun / preset vocabulary). Unit-tested both directions.
4. **Run 4 (all fixes)** — `background-set-color` passed end to end with a
   clean `{op:"set", color:"teal"}` tool call and the exact `#0891b2`
   broadcast. `background-shader-undo-redo` stayed red: gpt-oss-120b's Stage-1
   is run-to-run inconsistent on this multi-turn flow (routed BACKGROUND on
   3/4 turns in run 1, 2/4 in run 3, 1/4 in run 4), REPLY-larping "Reverting
   the background to its previous state." without calling the action.

## Honest residual (kept as a red live scenario, not papered over)

gpt-oss-120b's Stage-1 message handler intermittently classifies app-background
requests as `contexts:["simple"], requiresTool:false` and answers in prose —
including *claiming* the background was changed ("Reverting the background to
its previous state.") when no action fired. The scenario keeps asserting the
correct expectation (4 routed BACKGROUND calls + exact
glsl-lava/undo/redo/reset broadcast ledger); its red is a routing-quality
signal, not a harness defect. The deterministic lane pins the handler contract
itself, so this red isolates exactly the model-routing gap.
