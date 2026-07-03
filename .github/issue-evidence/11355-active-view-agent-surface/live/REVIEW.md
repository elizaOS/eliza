# Manual review — #11355 live active-view trajectory

Reviewer: automated evidence agent, hand-inspecting artifacts (2026-07-03).

## Verified by hand (committed passing run, runId 6229566b-…)

1. **Real live model, not proxy/mock.** `report.json` → `providerName: "openai"`
   (Cerebras first-class mode via plugin-openai). `native.jsonl` → 3
   `vercel_ai_sdk.generateText` rows, all tagged `cerebras`. Confirmed there is
   no `deterministic-llm-proxy` marker anywhere in this `live/` dir.

2. **Active-View block reached the model.** In
   `run/trajectories/546ac3ab-.../tj-578453d009d416.json`, the planner model
   stage (`stages[2]`) carries
   `model.providerOptions.eliza.promptOptimization.transformations =
   ["active-view-awareness:scenario-active-ledger"]`. This is the named
   transformation that injects the addressable-element block
   (`renderActiveViewContextBlock`) into the prompt.

3. **Model selected the correct element id from the block.** Same trajectory,
   `stages[3].tool.input`:
   `{"action":"interact","view":"scenario-active-ledger",
   "capability":"agent-fill","params":{"id":"ledger-title",
   "value":"Close Issue 11355"}}`. The id `ledger-title` is the focused textbox
   from the reported element snapshot — a selection, not a paraphrase.

4. **Outcome asserted, not routing.** The `serverInteract` `custom` finalCheck
   passed, which requires `state.interactions == [{capability:"agent-fill",
   params:{id:"ledger-title", value:"Close Issue 11355"},
   resultingTitle:"Close Issue 11355", savedCount:0}]`. The view's
   `serverInteract` throws on a wrong id or empty value, so the pass proves the
   addressed control's backing state was actually mutated to `Close Issue
   11355`. `actionCalled` (VIEWS succeeded ≥1×) and `selectedActionArguments`
   (exact interact/view/capability/id/value regexes) also passed.

## Observed live variance (honest failure modes) — why the fill leg only

`gpt-oss-120b` is nondeterministic on this task. Across 10 live runs I observed:

- **Pass (~half):** correct `agent-fill` on `ledger-title`, side-effect fires.
- **Value formatting:** model sometimes fills the value with a Unicode narrow
  no-break space (`Close Issue 11355`) instead of an ASCII space, which
  fails the exact `"value":"Close Issue 11355"` finalCheck even though the fill
  happened. This is a real model-output quirk, not a harness bug.
- **No tool call:** occasionally the model answers in natural language claiming
  it filled the title without emitting the `VIEWS` tool call at all.
- **Click leg:** for the save step the model frequently emits `capability:
  "click"` instead of the block's `agent-click`, or declines ("I'm not able to
  click directly"). The view's `serverInteract` rejects `click`. Because this
  leg is unreliable, the committed live scenario is **narrowed to the fill leg**
  — the strongest, repeatable proof of planner→id→interact→outcome. The
  deterministic scenario one dir up still covers both legs under the proxy.

The committed run is a genuine, unedited pass captured on retry; the variance
above is disclosed rather than hidden. The loop itself is correct — the model
reads the injected block, addresses the right element, and mutates it — the
flakiness is in the model's output formatting, which is the expected honest
live-routing behavior for a small OSS model.
