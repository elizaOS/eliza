# Eliza consolidation status — September 20, 2026

**Combined text candidate verified in part; final acceptance remains open.**
Results and failures: [CONSOLIDATION-QA.md](CONSOLIDATION-QA.md).

## Exact checkpoints

- Current production candidate is `ef88e31918b`: acknowledgment, Calendar guest/follow-up, failure-reply and deferred completion corrections. Scoped checks and full root verification passed. Isolated UI5268/API31392 runs this code (API PID35418); readiness and deferred boot settled with zero plugin/service failures.
- Sources: saved Mac text candidate `a15525f30fb` plus develop `ba04de0e2c1`, then reviewed develop test maintenance `ec23d0f670c`.
- Reviewed remote checkpoint `89a476f3d75` is already an ancestor of the Mac candidate. Any newer remote work still needs its exact source and review.
- Published rollback tag: `codex/consolidation-checkpoint-20260920` at `a42679bf08f`.
- Isolated combined app: UI5268/API31392. Original UI5248 and UI5258 demos remain preserved.

## Verified

- Full repository verification passed after the Calendar fixes.
- Calendar target boundary: 29 scoped tests and package typecheck passed. Incomplete/foreign local IDs cannot fall through to another provider.
- Earlier broad suites: Calendar 1,088 passed/four skipped; Notes192 passed; core13,661 passed/two initial failures/three skipped. Both initial core failures were investigated and their affected suites passed after reconciliation, including70 wallet-grounding tests.
- Follow-up core443, personal-assistant Calendar60, agent recall57, prompt-package20, upstream A2A19 and real SQL vector6 checks passed in their scoped runs. Further package results are recorded in the QA evidence.
- Twenty-seven real text turns recorded. Greetings/navigation/recall, exact note create/edit, Calendar timing clarification/create/conflict/move exercised. Latest move3.873s/four calls; exact original-message recall0.915s/one call. These are observations, not latency guarantees.
- The captured premature Done acknowledgment is now withheld while work is pending. Deterministic runtime coverage confirms both progress callbacks withhold it and the final reply still arrives without an extra model call. The latest live note edit produced an appropriate pending acknowledgment in its trace and a receipt-grounded final reply; transient browser delivery was not captured. Deterministic coverage proves the captured premature Done case is withheld, not a universal natural-language guarantee.

Latest exact note edit: **3.321s, three model calls, 23,710 input tokens, 964 output tokens**. Provider-reported cache reads:4,096 input tokens. Routing/acknowledgment1.263s; planner0.839s; completion0.509s. Notes view after reload showed the exact requested body. This is one measured run, not a latency guarantee.

Latest Calendar follow-up exposed unresolved issues: weekly intent survived, but local recurrence is unsupported and its useful explanation was replaced by a generic error. Clarification took7.114s/seven calls; follow-up4.693s/five calls. A single Friday availability check was also described too broadly as weekly availability. No event was created. These are open defects, not accepted behavior.

Offline correction committed as `b18ff926bec`: both captured Calendar explanations now survive the connection-prerequisite guard, eliminating the extra synthesis in replay.297 relevant tests, Core typecheck and scoped lint passed. Full root verification passed. Live validation of b18ff926bec delivered the clear Calendar limitation; this run still needed recovery because its first model reply contained invalid control characters.4.144s/five calls; no Calendar write.

Earlier committed cleanup `3a50ad527d4` removes a text-only output instruction from structured completion input. Five reply-contract test files, Agent typecheck, lint and full root verification passed. That checkpoint passed clean pre-effect Stop; it has since been superseded by ef88e31918b below. No isolated speed improvement was established for that change.

Verified checkpoint `ef88e31918b` retains `modelReplyRequired` for deferred action presentation. Two regressions failed before the fix;183 focused and1173 planner/message tests plus the Agent handoff file passed. Full root verification completed successfully (session77087 exit0). Isolated UI5268/API31392 runs this code (API PID35418); readiness and deferred boot settled with zero failures.

Latest live availability check: **3.604s, three calls,27,299 input tokens;6,144 cached input tokens**. Handler1.465s, planner0.678s, completion0.698s. One availability preview returned three consecutive Sep25 slots; final wording stayed within those intervals and no event was created. No routing repair, history restoration or extra planner reply in this run. Different request/context from the older seven-call trace, so this is not a controlled before/after result. Under-three-second consistency and recurring-availability wording remain open.

Source follow-up: successful planner-owned memory mutations now use the shared
deferred-reply contract. Three regressions reproduced the missing required
completion reply; all153 memory-action tests passed after correction. This
source change is not yet live-tested; UI5268/API31392 remains on ef88e31918b.
Exact preference wording and PERSONALITY removal remain open.

## Remaining acceptance checklist

- [ ] Close the Calendar handler disposition and reconcile any newer remote work. All270 original source entries now have explicit review decisions:266 include,3 upstream-equivalent,1 Calendar handler review-required. Source inspection is complete; live acceptance is not.
- [x] Full visual rerun and flagged screenshot inspection: 230 checks passed; OCR212 verified/zero broken/12 expected fallback exceptions. All23 soft layout flags inspected. Family interview hover remains unverified for three controls across four viewports; native/remote fallback surfaces are not feature acceptance.
- [ ] Correct and verify Calendar failure explanation delivery, redundant clarification steps and recurring availability claims using the captured traces.
- [x] Clean pre-effect Stop: interrupted before any tool, note unchanged after reload. Earlier incident remains unexplained: post-restart request arrived after Stop; it eventually edited the QA note. A repeat made no second write. Seven real HTTP/Vite lifecycle tests and existing server disconnect suites pass, so a basic proxy cancellation defect is not reproduced.
- [ ] Exact preference text was paraphrased in live MEMORY_CREATE; targeted MEMORY_DELETE passed without a scope question. Live PERSONALITY rule removal remains unproven.
- [ ] Close remaining combined scenarios: cancellation, memory/preference correction and applicable recovery/persistence checks, using existing evidence before new paid tests.
- [ ] Record final candidate, source decisions, explicit release gates and handoff.

Native install/build acceptance remains separate: the dependency install encountered the Xcode/Metal prerequisite. No voice acceptance, deployment, source rewrite, or develop push occurred. Publication of this isolated branch was explicitly authorized by the user.
