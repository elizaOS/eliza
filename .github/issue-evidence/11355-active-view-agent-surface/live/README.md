# Issue #11355 — LIVE-LLM trajectory for the agent-surface planner→id→interact loop

Spun off from #10722. The committed deterministic evidence one directory up
(`../report.json`, provider `deterministic-llm-proxy`) satisfied PR gating but
used the **LLM proxy**. Acceptance mandates a **live model**. This `live/`
directory holds a run against a **real** model (Cerebras `gpt-oss-120b`, served
through `@elizaos/plugin-openai` in first-class Cerebras mode).

## What this proves (acceptance criteria)

A real model, given the mounted active-view context, drives the loop
element-reporter → server store → active-view-awareness prompt transformation →
planner-picks-id → `agent-fill` → **domain side-effect**:

- `providerName: "openai"` (Cerebras first-class routing); native rows tagged
  `cerebras`. Not the proxy, not a mock.
- The planner model call carries the prompt transformation
  `active-view-awareness:scenario-active-ledger` — i.e. the Active-View
  addressable-element block (`ledger-title [textbox]`, `save-ledger [button]`,
  `agent-fill {id,value}` …) was injected into the model's prompt.
  (`run/trajectories/.../tj-*.json` stage `[2]`
  `model.providerOptions.eliza.promptOptimization.transformations`.)
- The model emitted the exact structured tool call (stage `[3]` `tool.input`):
  `VIEWS {action:interact, view:scenario-active-ledger, capability:agent-fill,
  params:{id:"ledger-title", value:"Close Issue 11355"}}` — it selected the
  correct **element id from the block**, not a guess.
- `finalChecks` assert the **outcome, not routing**: the `serverInteract`
  `custom` predicate requires `state.interactions` to record the agent-fill on
  `ledger-title` yielding `resultingTitle: "Close Issue 11355"`. The view's
  `serverInteract` throws on a wrong id/empty value, so a pass means the
  addressed control was actually mutated.

## Scenario

`packages/scenario-runner/test/scenarios/live-active-view-agent-surface.scenario.ts`
(`lane: "live-only"`). It is the live-tolerant sibling of the deterministic
scenario: identical view/route/active-view setup, but it does **not** assert the
model's free-form final chat text (a live model phrases the reply differently
every run) — it asserts the structured tool call + the domain side-effect. It is
narrowed to the **fill leg**, the reliable proof of planner→id→interact→outcome
(see REVIEW.md for the observed live variance and why the click leg was dropped).

## Reproduce

```bash
cd packages/scenario-runner
CEREBRAS_API_KEY=<csk-...> CEREBRAS_MODEL=gpt-oss-120b \
OPENAI_LARGE_MODEL=gpt-oss-120b OPENAI_SMALL_MODEL=gpt-oss-120b \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json src/cli.ts \
  run test/scenarios --scenario live-active-view-agent-surface \
  --report   ../../.github/issue-evidence/11355-active-view-agent-surface/live/report.json \
  --report-dir ../../.github/issue-evidence/11355-active-view-agent-surface/live/viewer \
  --run-dir  ../../.github/issue-evidence/11355-active-view-agent-surface/live/run \
  --export-native ../../.github/issue-evidence/11355-active-view-agent-surface/live/native.jsonl
```

(No `SCENARIO_USE_LLM_PROXY` — with `CEREBRAS_API_KEY` set the runner selects
first-class Cerebras and the openai plugin applies the Cerebras schema quirks.)

## Artifacts

- `report.json` — provider `openai`, scenario `passed`; per-turn trajectory.
- `native.jsonl` / `native.manifest.json` — 3 `eliza_native_v1` rows, Cerebras.
- `run/` — run viewer + trajectory files (the stage-by-stage proof above).
- `viewer/` — report bundle.
- `REVIEW.md` — hand-review notes + observed live variance.
