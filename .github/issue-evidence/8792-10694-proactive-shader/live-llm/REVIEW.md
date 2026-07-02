# Hand-review — live-background-actions (Cerebras gpt-oss-120b, 2026-07-02)

Run `396c5cb1-5ef5-4d7a-a1cf-920fb18a4506`, scenario **passed** in 12.3s
(`live-background-actions-report.json`). Reviewed by opening the report, the
native jsonl rows, and the backend log by hand — not just the green summary.

## Turn-by-turn (real model tool-calls, from the native jsonl)

1. **"Please make the app background teal."**
   Model tool-call: `BACKGROUND {"op":"set","color":"teal"}` (finishReason
   `tool-calls`, 6002 prompt tokens — the full real provider context is in the
   request row). Handler result `values {op:set, mode:shader, color:#0891b2}`;
   backend log `[plugin-app-control] BACKGROUND op=set mode=shader`; loopback
   broadcast `background:apply {op:set, mode:shader, color:#0891b2}`.
   Reply: "The app background has been set to teal." Judge 1.0.
2. **"Now switch the background to the animated lava shader."**
   Model tool-call: `BACKGROUND {"op":"set","preset":"lava"}` → handler
   `values {op:set, mode:glsl, presetId:lava}`; broadcast
   `background:apply {op:set, mode:glsl, presetId:lava}` — the same payload the
   SwiftShader e2e renders for real in `../background-e2e/`. Judge 1.0.
3. **"Actually, undo that last background change."**
   Model tool-call: `BACKGROUND {"op":"undo"}` → broadcast
   `background:apply {op:undo}`. Reply: "Reverted the background to the
   previous one." Judge 1.0.

Final checks: `actionCalled BACKGROUND ×3 success` passed; custom broadcast
check (≥2 set incl. ≥1 glsl, ≥1 undo) passed against the recorded loopback
ledger.

## Kept failure — real routing gap (attempt 1)

`attempt1-oblique-phrasing-report.json` / `attempt1-run-log.txt`: with the
oblique phrasing "Now give me one of the animated shader backgrounds instead —
something like a lava lamp." (no preset named), the live planner selected
REPLY ("I'm not sure how to answer that.") instead of BACKGROUND — turns 1 and
3 still routed correctly. The deterministic lane cannot catch this (its GLSL
turns use `kind:"action"`, bypassing live routing; the text-mapper unit tests
cover `inferBackgroundPlan` only after the action is selected). This is a
genuine live model-routing gap for shader requests that don't name a preset —
left on the record for #10694 rather than silently tuned away.

## Judge-prompt live sample (#8792)

The suggestions e2e scripts its judge output by design (the governor and UI
are the subjects there). `live-judge-wallet-sample.json` is the live
counterpart: the REAL `buildProactiveJudgePrompt({viewId:"wallet",…})` prompt
sent to live Cerebras `gpt-oss-120b`, raw model output
`{"comment":"Want me to pull your latest balances for you?","delivery":"chat",
"confidence":0.96,"urgency":"medium","title":null}`, parsed by the REAL
`parseProactiveJudgeDecisionOutput` into
`{text:"Want me to pull your latest balances for you?", delivery:"chat"}` —
live model in AND out on the exact #8792 judge path. (The scenario's
`responseJudge` scores above are additionally real Cerebras judge calls.)
