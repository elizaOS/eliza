# Eliza consolidation status — September 20, 2026

**The isolated text candidate is running and verified in part. It is not a
finished release.** Full evidence and historical failures:
[CONSOLIDATION-QA.md](CONSOLIDATION-QA.md).

## Current checkpoint

- Tested production code: `04719e2706e`. Full repository verification passed;
  scoped memory/registered-tool tests, Agent typecheck and lint passed.
- Isolated app: UI5268/API31392, API PID56036. Restart completed with35 plugins,
  95 services and zero failures; deferred boot settled.
- Original UI5248/UI5258 demos and their source branches remain preserved.
- Inputs: Mac `a15525f30fb`, develop `ba04de0e2c1` plus reviewed maintenance
  `ec23d0f670c`. Reviewed remote `89a476f3d75` is already an ancestor. A fresh
  remote check found that known checkout unchanged and clean; newer work in
  other locations is not established.
- Pushed rollback tag: `codex/consolidation-checkpoint-20260920` at `a42679bf08f`.
  The user authorized publishing this isolated branch; no develop push or
  deployment occurred.

## Latest live result

Exact preference save and natural follow-up removal now pass. The saved text
was preserved verbatim, survived an API restart, and only that QA fact was
removed. All nine baseline fact records match their original values. This
verifies MEMORY facts; PERSONALITY directives are a separate remaining check.
Thirty paid text QA turns have been recorded in total; no voice testing.

| Recorded scenario | Total time | Model calls | Input tokens | Cached input |
| --- | ---: | ---: | ---: | ---: |
| Exact preference save | 2.780s | 3 | 23,226 | 3,072 |
| Follow-up preference removal | 3.015s | 3 | 24,523 | 10,240 |
| Earlier availability preview | 3.604s | 3 | 27,299 | 6,144 |
| Earlier exact note edit | 3.321s | 3 | 23,710 | 4,096 |

These are individual observations across checkpoints, not a controlled latency
benchmark or a guarantee. The three-call path is routing/acknowledgment,
action planning, then grounded completion. The latest removal used one tool,
with no context-restoration call, target retry, or separate reply synthesis.
Its provider calls took1.112s,0.685s and0.445s; the remaining0.773s includes
application/tool/transport work not separately attributed here.

## Verified coverage

- Original source inventory:270 entries reviewed;266 include,3 upstream-equivalent,
  one Calendar handler disposition still open. Source review is separate from
  live acceptance.
- Existing broad scoped suites include Calendar1,088 passed/four skipped,
  Notes192, personal-assistant Calendar60, recall57 and core13,661 passed with
  two initial failures subsequently resolved in their affected suites. Detailed
  scope and subsequent results are in the QA document.
- Greetings/navigation, exact notes, original-message recall and Calendar
  clarification/create/conflict/move have live evidence. The latest memory
  fixes add exact saving, safe scoped deletion and restart persistence.
- Clean pre-effect Stop passed: no tool effect and unchanged note after reload.
  An older late-arriving request around restart remains unexplained.
- Visual checks:230 passed;23 soft flags inspected. OCR212 verified, zero
  regressions,12 expected fallback exceptions. Three family-interview hover
  controls across four viewports remain unverified.

## Remaining acceptance checklist

- [ ] Close Calendar handler disposition and remaining recurrence/availability
  wording coverage. Local Calendar recurrence is unsupported. Correct failure
  explanation was observed, but one recovered run still took five calls.
- [ ] Verify PERSONALITY directive removal through the live model path. Existing
  deterministic tests cover selective removal; fact deletion is not that test.
- [ ] Reconcile any newer remote work by exact checkout/commit and review scope.
- [ ] Finish applicable recovery/persistence review and clean remaining owned
  Calendar/Notes fixtures. The temporary QA memory has been removed.
- [ ] Produce the final candidate handoff with source decisions and explicit
  release gates.

Native installation remains gated on the Xcode/Metal prerequisite. Remote,
staging, device, voice and deployment acceptance have not been established.
Consistent sub-three-second completion is not yet proved.
