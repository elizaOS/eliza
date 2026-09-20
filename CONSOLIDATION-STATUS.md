# Eliza consolidation status — September 20, 2026

**Combined text candidate verified in part; final acceptance remains open.**
Results and failures: [CONSOLIDATION-QA.md](CONSOLIDATION-QA.md).

## Exact checkpoints

- Current candidate includes the receipt-composition correction after `673a13f3537`; full root verification and124 focused checks passed. Latest runtime is UI5268/API31392 (restarted for this change).
- Sources: saved Mac text candidate `a15525f30fb` plus develop `ba04de0e2c1`, then reviewed develop test maintenance `ec23d0f670c`.
- Reviewed remote checkpoint `89a476f3d75` is already an ancestor of the Mac candidate. Any newer remote work still needs its exact source and review.
- Published rollback tag: `codex/consolidation-checkpoint-20260920` at `a42679bf08f`.
- Isolated combined app: UI5268/API31392. Original UI5248 and UI5258 demos remain preserved.

## Verified

- Full repository verification passed after the Calendar fixes.
- Calendar target boundary: 29 scoped tests and package typecheck passed. Incomplete/foreign local IDs cannot fall through to another provider.
- Earlier broad suites: Calendar 1,088 passed/four skipped; Notes192 passed; core13,661 passed/two initial failures/three skipped. Both initial core failures were investigated and their affected suites passed after reconciliation, including70 wallet-grounding tests.
- Follow-up core443, personal-assistant Calendar60, agent recall57, prompt-package20, upstream A2A19 and real SQL vector6 checks passed in their scoped runs. Further package results are recorded in the QA evidence.
- Seventeen real text turns recorded. Greetings/navigation/recall, exact note create/edit, Calendar timing clarification/create/conflict/move exercised. Latest move3.873s/four calls; exact original-message recall0.915s/one call. These are observations, not latency guarantees.
- Acknowledgment correction passed one earlier live edit, but the latest handler again generated premature Done with pending status. Keep acknowledgment correctness open; persisted note text and final receipt were correct.

## Remaining acceptance checklist

- [ ] Complete semantic source ledger and reconcile any newer remote work.
- [x] Full visual rerun and flagged screenshot inspection: 230 checks passed; OCR212 verified/zero broken/12 expected fallback exceptions. All23 soft layout flags inspected. Family interview hover remains unverified for three controls across four viewports; native/remote fallback surfaces are not feature acceptance.
- [ ] Investigate post-restart request arriving after Stop; it eventually edited the QA note. A repeat made no second write.
- [ ] Close remaining combined scenarios: cancellation, memory/preference correction and applicable recovery/persistence checks, using existing evidence before new paid tests.
- [ ] Record final candidate, source decisions, explicit release gates and handoff.

Native install/build acceptance remains separate: the dependency install encountered the Xcode/Metal prerequisite. No voice acceptance, deployment, source rewrite, or develop push occurred. Publication of this isolated branch was explicitly authorized by the user.
