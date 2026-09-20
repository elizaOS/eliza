# Eliza consolidation status — September 20, 2026

**Combined text candidate verified in part; final acceptance remains open.**
Results and failures: [CONSOLIDATION-QA.md](CONSOLIDATION-QA.md).

## Exact checkpoints

- Current production candidate is `609048e9c1e`: pending-work acknowledgment guard plus Calendar guest clarification and selected-user follow-up evidence. Focused tests, Calendar typecheck and full root verification passed. Isolated UI5268/API31392 now runs b18ff926bec, including the later failure-reply correction (API PID21562 at restart).
- Sources: saved Mac text candidate `a15525f30fb` plus develop `ba04de0e2c1`, then reviewed develop test maintenance `ec23d0f670c`.
- Reviewed remote checkpoint `89a476f3d75` is already an ancestor of the Mac candidate. Any newer remote work still needs its exact source and review.
- Published rollback tag: `codex/consolidation-checkpoint-20260920` at `a42679bf08f`.
- Isolated combined app: UI5268/API31392. Original UI5248 and UI5258 demos remain preserved.

## Verified

- Full repository verification passed after the Calendar fixes.
- Calendar target boundary: 29 scoped tests and package typecheck passed. Incomplete/foreign local IDs cannot fall through to another provider.
- Earlier broad suites: Calendar 1,088 passed/four skipped; Notes192 passed; core13,661 passed/two initial failures/three skipped. Both initial core failures were investigated and their affected suites passed after reconciliation, including70 wallet-grounding tests.
- Follow-up core443, personal-assistant Calendar60, agent recall57, prompt-package20, upstream A2A19 and real SQL vector6 checks passed in their scoped runs. Further package results are recorded in the QA evidence.
- Twenty-one real text turns recorded. Greetings/navigation/recall, exact note create/edit, Calendar timing clarification/create/conflict/move exercised. Latest move3.873s/four calls; exact original-message recall0.915s/one call. These are observations, not latency guarantees.
- The captured premature Done acknowledgment is now withheld while work is pending. Deterministic runtime coverage confirms both progress callbacks withhold it and the final reply still arrives without an extra model call. The latest live note edit produced an appropriate pending acknowledgment in its trace and a receipt-grounded final reply; transient browser delivery was not captured. Deterministic coverage proves the captured premature Done case is withheld, not a universal natural-language guarantee.

Latest exact note edit: **3.321s, three model calls, 23,710 input tokens, 964 output tokens**. Provider-reported cache reads:4,096 input tokens. Routing/acknowledgment1.263s; planner0.839s; completion0.509s. Notes view after reload showed the exact requested body. This is one measured run, not a latency guarantee.

Latest Calendar follow-up exposed unresolved issues: weekly intent survived, but local recurrence is unsupported and its useful explanation was replaced by a generic error. Clarification took7.114s/seven calls; follow-up4.693s/five calls. A single Friday availability check was also described too broadly as weekly availability. No event was created. These are open defects, not accepted behavior.

Offline correction committed as `b18ff926bec`: both captured Calendar explanations now survive the connection-prerequisite guard, eliminating the extra synthesis in replay.297 relevant tests, Core typecheck and scoped lint passed. Full root verification passed. Live demo now uses b18ff926bec and delivered the clear Calendar limitation; this run still needed recovery because its first model reply contained invalid control characters.4.144s/five calls; no Calendar write.

Next committed cleanup `3a50ad527d4` removes a text-only output instruction from structured completion input. Five reply-contract test files, Agent typecheck, lint and full root verification passed. Runtime remainsb18ff926bec pending restart. No speed improvement claimed yet.

## Remaining acceptance checklist

- [ ] Complete semantic source ledger (149/270 entries explicitly reviewed; all implementation diffs inspected, Calendar recipient and follow-up fixes checked deterministically with live Calendar validation still open; review is not acceptance) and reconcile any newer remote work.
- [x] Full visual rerun and flagged screenshot inspection: 230 checks passed; OCR212 verified/zero broken/12 expected fallback exceptions. All23 soft layout flags inspected. Family interview hover remains unverified for three controls across four viewports; native/remote fallback surfaces are not feature acceptance.
- [ ] Correct and verify Calendar failure explanation delivery, redundant clarification steps and recurring availability claims using the captured traces.
- [ ] Investigate post-restart request arriving after Stop; it eventually edited the QA note. A repeat made no second write. Seven real HTTP/Vite lifecycle tests and existing server disconnect suites pass, so a basic proxy cancellation defect is not reproduced.
- [ ] Close remaining combined scenarios: cancellation, memory/preference correction and applicable recovery/persistence checks, using existing evidence before new paid tests.
- [ ] Record final candidate, source decisions, explicit release gates and handoff.

Native install/build acceptance remains separate: the dependency install encountered the Xcode/Metal prerequisite. No voice acceptance, deployment, source rewrite, or develop push occurred. Publication of this isolated branch was explicitly authorized by the user.
