# #10694 — BACKGROUND live + deterministic scenario coverage on gemma-4-31b

Date: 2026-07-02. Worktree `feat/cerebras-gemma-4-31b-cutover` (rebased on
develop). Model under test: **Cerebras-hosted `gemma-4-31b`** — selected
automatically by the live-provider path when only `CEREBRAS_API_KEY` is set
(`packages/core/src/testing/live-provider.ts`: openai def in Cerebras mode →
base `https://api.cerebras.ai/v1`, small/large model
`DEFAULT_CEREBRAS_TEXT_MODEL = "gemma-4-31b"`, `ELIZA_PROVIDER=cerebras`).
The run log confirms Cerebras mode (`[OpenAI] Not registering IMAGE: the
Cerebras endpoint does not serve it`, `provider: openai`). Key never written
to any artifact — this directory was swept for `csk-` (clean).

## What this covers

**New live-only scenario**
`packages/scenario-runner/test/scenarios/background-live.scenario.ts` —
natural chat phrasing through the FULL agent loop (Stage-1 message handler →
toolSearch → ACTION_PLANNER → tool execution), so a real model must route each
message to BACKGROUND itself:

| turn | message | asserted contract |
| --- | --- | --- |
| 1 | "Please make my background dark blue." | BACKGROUND `values.op=set`, `mode=shader`, `color` = normalized 6-digit hex |
| 2 | "Undo the background change." | BACKGROUND `values.op=undo` |
| 3 | "Actually, redo the background change." | BACKGROUND `values.op=redo` |
| 4 | "Reset the background to the default." | BACKGROUND `values.op=reset` |

Final checks: ≥4 successful BACKGROUND calls **and** an exact ordered
`background:apply` broadcast ledger — ops exactly `set,undo,redo,reset`, the
set payload shader-mode with a hex color, undo/redo/reset payloads exactly
`{"op":...}`. Assertions pin actions/params + emitted payloads, never reply
prose. The set-turn color is asserted as "a normalized hex", not one exact
value, because a live model may legitimately pass its own hex as the explicit
`color` option, which `inferBackgroundPlan` gives precedence by design (run 5's
redo turn shows gemma inventing `#00008B`).

**Deterministic (keyless) half** — already on develop:
`packages/scenario-runner/test/scenarios/deterministic-background-actions.scenario.ts`
(lane `pr-deterministic`) exercises the real handler for named-color set, hex
set, GLSL preset (text + explicit param), uniform tweak, undo, redo, reset with
an exact 8-entry broadcast ledger. Re-adding set/undo/redo steps to
`deterministic-app-control-actions.scenario.ts` would duplicate that coverage,
so it was not done.

**Coverage-test classification** —
`packages/scenario-runner/src/__tests__/deterministic-action-coverage.test.ts`
registers `background-live` in `PROSE_ONLY_LLM_SCENARIOS` (a live-only
real-LLM scenario cannot satisfy the deterministic fixture contract). 17/17
tests green.

## Commands

```bash
# keyless deterministic lane (must stay green)
cd packages/scenario-runner && bun run test:deterministic:e2e
# → Totals: 36 passed, 0 failed, 0 skipped of 36
#   (includes deterministic-background-actions ✓ and deterministic-app-control-actions ✓)

# live lane on gemma-4-31b
cd packages/scenario-runner && CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run test/scenarios --scenario background-live \
  --report-dir ../../reports/scenarios/gemma4-background \
  --run-dir ../../reports/scenarios/gemma4-background

# classification / coverage test
cd packages/scenario-runner && bunx vitest run \
  src/__tests__/deterministic-action-coverage.test.ts   # 17 passed
```

## Live results on gemma-4-31b (5 runs, all read by hand)

| run | undo phrasing | result | detail |
| --- | --- | --- | --- |
| 1 | "Undo that background change." | **FAILED** | undo turn routed `VIEWS {action:"show", view:"settings"}` (which itself failed); set/redo/reset all routed BACKGROUND with correct ops |
| 2 | "Undo the background change." | **PASSED** (8.3s) | all 4 turns routed BACKGROUND; exact ledger green |
| 3 | same | **PASSED** (8.0s) | all 4 turns green |
| 4 | same | **FAILED** | undo turn again routed VIEWS — Stage-1 emitted `candidateActions:["UPDATE_SETTINGS","RESET_SETTINGS"]`, toolSearch ranked VIEWS #1 (`exact` match) over BACKGROUND #2 (0.968, bm25-only), planner followed |
| 5 | same | **PASSED** (7.9s) | evidence run — `report.json` + `trajectories-passing/` are this run |

Pass rate with final phrasing: **3/4**. The scenario is `lane: "live-only"`
(credentialed lane, not PR-gating); the deterministic twin gates PRs keyless.

## What the passing trajectories show (run 5)

- **set** (`tj-a9843f30b9569e`): gemma called
  `BACKGROUND {op:"set", color:"darkblue", preset:"aurora", prompt:"dark blue background"}`;
  the handler's color-over-preset precedence (the #10694 fix) resolved the text
  "dark blue" → curated `#1e3a8a` and broadcast
  `{op:"set", mode:"shader", color:"#1e3a8a"}`.
- **undo** (`tj-a98c35f8553bb0`): routed `BACKGROUND {op:"undo"}` → broadcast
  `{op:"undo"}`.
- **redo** (`tj-a992868786d3d7`): first planner call stuffed
  `preset:"#00008B"` — **rejected by enum validation** ("not one of: aurora,
  lava, plasma, waves, nebula"), no broadcast leaked; gemma self-corrected on
  the retry (`{op:"redo", preset:"aurora", color:"#00008B"}`) and the handler's
  op-first branching broadcast exactly `{op:"redo"}`.
- **reset** (`tj-a99bb45090a7d7`): routed `BACKGROUND {op:"reset"}` → broadcast
  `{op:"reset"}`.

Ledger observed (run 5): `set(#1e3a8a shader) → undo → redo → reset`, one
broadcast per turn — the exact-ledger custom check passed.

## Honest residual (documented, not papered over)

gemma-4-31b's Stage-1 intermittently (~1 in 3–4 runs) conceptualizes the
background-undo request as a *settings* task and emits settings-flavored
candidate names; toolSearch's exact-match stage then ranks VIEWS above
BACKGROUND and the planner opens the settings view instead of undoing
(`trajectory-variance-undo-misroute.json`, run 4). This is a model
routing-quality signal — the same class documented for gpt-oss-120b in
`.github/issue-evidence/10694-background-scenarios/README.md` (which
REPLY-larped 3 of 4 turns; gemma-4-31b is strictly better: it always routes
*some* action and self-corrects invalid params). The scenario keeps asserting
the correct expectation; a red run isolates exactly this gap.

## Artifacts

- `report.json` — passing run 5: per-turn action calls with parameters,
  results, and both final-check verdicts. This IS the trajectory summary.
- `trajectories-passing/tj-*.json` — run 5 per-message trajectories (Stage-1,
  toolSearch scores, planner tool calls, token usage; ~3.2k prompt tokens/turn,
  3.2k cache-read).
- `trajectory-variance-undo-misroute.json` — run 4 undo turn: the misroute
  trajectory (Stage-1 candidates, toolSearch ranking, VIEWS call + failure).
- `live-run-passing.log` — full key-free CLI log of run 5 (server
  `[ClassName]` lines included).
- `deterministic-lane-summary.log` — keyless lane result lines
  (36/36, both app-control scenarios green).
- `matrix.json` — run matrix summary.
