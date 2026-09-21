> Recovery correction checkpoint:07178b7c036 covers Stop during history restoration, action setup and404 replay. All183 targeted tests pass. Final root verification is running against this exact code; the earlier tagged handoff remains the verified baseline.

# Eliza consolidation status — September 20, 2026

**The local consolidation checkpoint and handoff are ready for text rehearsal.
It is not a finished release.** Start with [CONSOLIDATION-HANDOFF.md](CONSOLIDATION-HANDOFF.md).
Full evidence and historical failures:
[CONSOLIDATION-QA.md](CONSOLIDATION-QA.md).

## Current checkpoint

- Backend candidate code: `3f46cd1362d`; UI Stop correction: `1e230d820a4`.
  Full repository verification passed again after the UI correction;
  Calendar1,092 tests plus the expanded29-test real-PGlite suite passed;
  Calendar typecheck, lint and declaration build passed.
- Isolated app: UI5268/API31392, API PID68142. Restart completed with35 plugins,
  95 services and zero failures; deferred boot settled.
- Original UI5248/UI5258 demos and their source branches remain preserved.
- Inputs: Mac `a15525f30fb`, develop `ba04de0e2c1` plus reviewed maintenance
  `ec23d0f670c`. Reviewed remote `89a476f3d75` is already an ancestor. A fresh
  remote inventory also found sync2 `d0d478fe7dd` and group-protocol
  `4e8feaac096`; their reviewed differences and holds are recorded below.
  Other unspecified hosts remain unconfirmed.
- Pushed rollback tag: `codex/consolidation-checkpoint-20260920` at `a42679bf08f`.
  The user authorized publishing this isolated branch; no develop push or
  deployment occurred.

## Latest live result

Exact preference save and natural follow-up removal now pass. The saved text
was preserved verbatim, survived an API restart, and only that QA fact was
removed. All nine baseline fact records match their original values. This
verifies MEMORY facts. PERSONALITY directive removal also passed live with a
durable receipt, preserved other slot fields, and no retry loop.
Thirty-four paid text QA turns have been recorded in total; no voice testing.

| Recorded scenario | Total time | Model calls | Input tokens | Cached input |
| --- | ---: | ---: | ---: | ---: |
| Clean post-reload Go home | 0.978s | 1 | 10,658 | 6,144 |
| Latest morning preview (backend only; UI hot-update delay) | 4.029s | 3 | 27,391 | 3,072 |
| Personal reply-rule removal | 3.537s | 3 | 27,413 | 9,216 |
| Exact preference save | 2.780s | 3 | 23,226 | 3,072 |
| Follow-up preference removal | 3.015s | 3 | 24,523 | 10,240 |
| Earlier availability preview | 3.604s | 3 | 27,299 | 6,144 |
| Earlier exact note edit | 3.321s | 3 | 23,710 | 4,096 |

These are individual observations across checkpoints, not a controlled latency
benchmark or a guarantee. The three-call path is routing/acknowledgment,
action planning, then grounded completion. The follow-up memory removal used one tool,
with no context-restoration call, target retry, or separate reply synthesis.
Its provider calls took1.112s,0.685s and0.445s; the remaining0.773s includes
application/tool/transport work not separately attributed here.

## Verified coverage

- Original source inventory:270 entries reviewed;267 include,3 upstream-equivalent.
  Calendar handler source disposition is closed after scoped corrections. Source review is separate from
  live acceptance.
- Existing broad scoped suites include Calendar1,088 passed/four skipped,
  Notes192, personal-assistant Calendar60, recall57 and core13,661 passed with
  two initial failures subsequently resolved in their affected suites. Detailed
  scope and subsequent results are in the QA document.
- Greetings/navigation, exact notes, original-message recall and Calendar
  clarification/create/conflict/move have live evidence. The latest memory
  fixes add exact saving, safe scoped deletion and restart persistence.
- Clean pre-effect Stop passed: no tool effect and unchanged note after reload.
  A separate Stop-during-conversation-creation race was reproduced and corrected;
  150 lifecycle tests pass. The older late-arriving request is not causally
  explained by this reproduction.
- Visual checks:230 passed;23 soft flags inspected. OCR212 verified, zero
  regressions,12 expected fallback exceptions. Three family-interview hover
  controls across four viewports remain unverified.

## Consolidation acceptance and remaining release gates

- [x] Check single-day morning availability wording against actual slot evidence.
  Latest preview returned three contiguous AM slots and no booking; reply persisted
  after reload. Local recurring events remain unsupported and are not accepted. Calendar
  source disposition is complete. Date-rewrite removal passes Calendar1,092 tests and29
  real-PGlite tests; root verification and runtime restart passed. Local Calendar recurrence is unsupported. Correct failure
  explanation was observed, but one recovered run still took five calls.
- [x] Verify PERSONALITY directive removal through the live model path. The
  temporary greenhouse rule was removed on4283ed4fd1e in three calls with a
  valid durable receipt. Add/remove deterministic coverage passes413 tests;
  live add completion on the corrected code was not separately retested.
- [x] Inventory and classify the identified remote work: read-only inventory checked44 registered worktrees,
  24 dirty/untracked. September heads d0d478fe7dd (sync2) and4e8feaac096
  (group protocol) are now fetched locally; all127 sync2 file dispositions are in
  [REMOTE-SOURCE-REVIEW.md](REMOTE-SOURCE-REVIEW.md). Saved Mac/merge remote heads are
  already ancestors. All sync2 file dispositions are explicit; group-channel/Discord
  integration remains a separate release gate. Unspecified other hosts remain unconfirmed.
- [x] Review recovery/persistence evidence and clean owned Calendar/Notes fixtures;
  retain the unexplained historical case as an explicit release gate. Owned Cedar note/event and the temporary QA memory
  and personality directive are now removed; cleanup evidence is saved. Setup-time
  Stop is corrected. Clean post-reload navigation passed in0.978s/one call; the
  preceding Calendar run encountered a development hot-update failure. Historical
  delayed arrival remains causally unproven, not silently marked fixed.
- [x] Produce [the final candidate handoff](CONSOLIDATION-HANDOFF.md) with source
  decisions and explicit release gates. Group/Discord integration is not complete;
  review and preservation must not be mistaken for integration acceptance.

Native installation remains gated on the Xcode/Metal prerequisite. Remote,
staging, device, voice and deployment acceptance have not been established.
Consistent sub-three-second completion is not yet proved.
