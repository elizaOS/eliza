# #10694 / #11360 — BACKGROUND action real-LLM scenario evidence

Live-model scenario runs for the BACKGROUND coverage
(`plugins/plugin-app-control/test/scenarios/background-set-color.scenario.ts`,
`background-shader-undo-redo.scenario.ts`), captured against a **live**
Cerebras endpoint (provider `openai` in first-class Cerebras mode, model
**gemma-4-31b** — the live-provider default when only `CEREBRAS_API_KEY` is
set; key sourced from the environment, never logged — artifacts swept for
`csk-`).

This directory previously held a **failing** run (undo/redo/reset misrouted to
non-BACKGROUND actions — the #11360 gap). It now holds a clean **passing** run
captured after the #11360 routing fix.

## Artifacts

- `report.json` — the passing evidence run: per-turn text, every action call
  with parameters and results, per-check verdicts. This IS the trajectory.
- `run/trajectories/<agent>/tj-*.json` — per-message trajectory files (Stage-1
  RESPONSE_HANDLER prompt+raw output, toolSearch ranking with per-stage scores
  and tiering, planner stages, model provider/latency/token metrics).
- `run/viewer/index.html` — run viewer.
- `live-run.log` — full key-free CLI log (server `[ClassName]` lines included).

Deterministic-lane twin (zero-key, runs on every PR):
`packages/scenario-runner/test/scenarios/deterministic-background-actions.scenario.ts`
— 8 asserted action turns + an exact ordered `background:apply` broadcast
ledger. Green in `--lane pr-deterministic` (36/36 scenarios, re-run with the
#11360 fix applied).

## Command

```bash
cd packages/scenario-runner && CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run ../../plugins/plugin-app-control/test/scenarios \
  --scenario background-set-color,background-shader-undo-redo \
  --report-dir <out> --run-dir <out>
```

## Final live results (evidence run, gemma-4-31b)

| scenario | result |
| --- | --- |
| `background-set-color` | **PASSED** — model selected `BACKGROUND {op:"set", color:"teal"}` (with planner-stuffed `preset:"nebula"` that the explicit-preset-vs-color precedence correctly ignored); handler broadcast exactly `{op:"set", mode:"shader", color:"#0891b2"}` (curated teal hex); exact-ledger check green. |
| `background-shader-undo-redo` | **PASSED** — all four turns routed `BACKGROUND` with the correct op: `set` (glsl lava from "give me a slow lava-lamp style animated background"), `undo`, `redo`, `reset`; exact broadcast ledger `set(glsl lava) → undo → redo → reset`; judge score 1.0. |

## Reliability (the #11360 core ask)

`background-shader-undo-redo` passed **8 consecutive live runs** on
gemma-4-31b after the routing fix, plus this evidence capture (9 total); the
run *before* the fix's context-gate half failed turn 1 (see below). The
scenario pair (`background-set-color` + `background-shader-undo-redo`) passed
4 consecutive combined runs including this capture.

## Hand-read of the trajectories (what the model actually did)

Every `tj-*.json` in `run/trajectories/` was read by hand:

1. **set turn** — gemma Stage-1 *still* classifies "give me a slow lava-lamp
   style animated background" as a build request
   (`contexts:["code"], candidateActions:["GENERATE_CODE","CREATE_FILE"]` —
   varied per run: `CREATE_SVG_ANIMATION`, `CREATE_HTML_FILE`). Pre-fix this
   gated BACKGROUND off the planner surface entirely (its contextGate was
   `general|settings` only) and the planner created a "lava-lamp-background"
   APP. Post-fix BACKGROUND declares `code`/`media` contexts and its curated
   keyword entry ranks it 1.0, so tier-A = `[BACKGROUND, VIEWS]` and the
   planner picks `BACKGROUND {preset:"lava"}` every run.
2. **undo turn** — Stage-1 emits settings-flavored candidates
   (`UNDO_LAST_ACTION`, `RESET_SETTINGS`) or background-scoped ones
   (`SET_BACKGROUND`, `UNDO_BACKGROUND_CHANGE`). Both shapes now keep
   BACKGROUND in tier-A: the widened similes exact-match the background-scoped
   names, and the keyword stage (`"undo the background"`, `"background
   change"`, `"background"`) scores 1.0 ≥ the 0.97 retrieval-override keep for
   the settings-flavored narrow that previously demoted BACKGROUND to tier-C
   at 0.9675 (the committed misroute trajectory in
   `../10694-gemma4-live-scenarios/trajectory-variance-undo-misroute.json`).
3. **redo turn** — candidates like `SET_BACKGROUND`/`UPDATE_THEME`/
   `APPLY_THEME`; BACKGROUND ranks 1.0, planner emits `{op:"redo"}`.
4. **reset turn** — candidates `RESET_BACKGROUND`/`SET_BACKGROUND_DEFAULT`;
   `RESET_BACKGROUND` exact-matches a BACKGROUND simile, tier-A =
   `[BACKGROUND]` alone; planner emits `{op:"reset"}`.

Across the final three captured sessions (14 turn trajectories) **every turn's
tool stage is BACKGROUND** — zero misroutes.

## Honest notes

- Stage-1's *classification* of the animated-background ask as a coding task
  is unchanged (that is the model's judgement); the fix makes the action
  surface robust to it rather than pretending it away.
- `background-set-color`'s `selectedActionArguments` check previously required
  the curated `#0891b2` hex to appear in the MODEL's own tool-call arguments —
  it only passed when the model happened to emit the resolved hex itself. It
  now accepts the color reference the model actually controls
  (`/teal|#0891b2/i`); the exact `#0891b2` resolution stays pinned by the
  broadcast-ledger check (the handler contract).
