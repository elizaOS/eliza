# Combined text QA — September 20, 2026

Candidate: `a42679bf08f`; fresh isolated UI5268/API31392. Source demos unchanged.
Nine real text turns, using the existing Cerebras model. Single runs, not a latency SLA.

| Scenario | Trace seconds | Model calls | Input tokens | Cached input tokens |
| --- | ---: | ---: | ---: | ---: |
| greeting | 1.90 | 1 | 9,470 | 0 |
| open-notes | 1.45 | 1 | 10,122 | 0 |
| create-note | 3.04 | 3 | 21,679 | 6,144 |
| edit-note | 7.77 | 3 | 22,794 | 10,240 |
| go-home | 7.33 | 1 | 10,266 | 7,168 |
| read-note | 0.79 | 1 | 10,408 | 7,168 |
| calendar-clarify | 3.44 | 3 | 26,544 | 2,048 |
| calendar-create | 2.83 | 4 | 27,723 | 10,240 |
| calendar-conflict | 1.64 | 1 | 10,586 | 7,168 |

Call shape: greetings, navigation, recall, and this history-grounded conflict clarification each used one routing call. Notes writes used routing, planning, then completion evaluation. Calendar proposals used those three calls; Calendar creation added one domain extraction/validation call. Counts include foreground calls captured in each trajectory, not later background evaluators.

## Verified behavior

- Notes created exact supplied text, applied only the requested color-word edit, and recalled the edited text from Home.
- Calendar morning request paused and proposed actual 9:00/9:15/9:30 slots; no event written before the time choice.
- The time follow-up created one event at 9:15–9:30am PDT, September 21, without recurrence. Calendar UI readback showed that event.
- Planner invented weekly recurrence in its arguments; domain extraction discarded it. Preserve that validation call.
- A conflicting follow-up asked for a choice, used no tools, and did not create a second event. This demonstrates clarification from current conversation evidence; full domain conflict enforcement is separately covered by Calendar tests.
- Planning acknowledgment was recorded at 1.373 seconds during note creation. It is a transient status, not a stored final answer.

## Open findings

- Edit and Home traces were slow during concurrent local build/visual-audit work. Edit model calls totaled1.744 seconds; overall trace7.770 seconds. Timing spans show provider reads, embeddings and context assembly delays. Concurrent workload is a hypothesis, not proof; recheck economically with heavy jobs finished.
- The edit acknowledgment incorrectly said the change was already done despite its pending classification. Final storage was correct. Do not treat free-form progress as guaranteed semantic truth. Investigate a general contract-level correction rather than adding one phrase-specific exception.
- Calendar clarification added unsupported “around8:30am onward”; returned proposals started at9am. Slot suggestions were grounded, but the wider availability claim was not.
- Full visual capture:229 passed/1 failed; failure was an HTTP424 protected-view bundle diagnostic attributed to LifeOps during the run. Focused isolated rerun passed all four LifeOps viewports without a code change. Preserve both results; full visual acceptance is still open. OCR:212 verified,1 broken,11 needing inspection in the original224-view report.
- Final checkpoint root verification passed. Source-ledger semantic review and newer remote-source confirmation remain open.

No production deployment or voice testing. QA records remain local; this document publishes only synthetic scenarios and aggregate results.

## Follow-up checkpoint

Two targeted live rechecks exercised `dc97d77cc5f` without the earlier heavy jobs:

- Notes edit: 3.352 seconds, three calls, 23,836 input tokens. Final stored text was correct, but the initial acknowledgment still claimed completion prematurely. The ineffective reply-classification wording change was subsequently reverted.
- Calendar proposals: 3.002 seconds, three calls, 28,210 input tokens. Three valid Tuesday slots were offered and no event was moved. The added slot-evidence context prevented the earlier invented 8:30 boundary in this run; broad availability language still needs scrutiny.

A separate concrete contradiction was then removed: the shared prompt said only asynchronous work could acknowledge early, despite the synchronous planning acknowledgment path. This short deletion passed the 20 prompt-package checks but has not yet been live-verified. No additional routing step was introduced.

Latest reviewed develop addition `ec23d0f670c` only consolidates A2A tests and makes empty test selections fail. Its 19 tests passed, and an intentionally nonexistent selection correctly exited 1. It was merged at `cc375c20141`. Final revision verification and remaining acceptance items are still open.

## Latest acknowledgment recheck

At `0f4a733f7f3`, one additional exact Notes edit passed in 3.172 seconds with three calls: routing 1.556s, planning 0.540s, completion 0.386s. Input tokens: 23,829; cache-read: 4,096; output: 1,038. Transient acknowledgment arrived at 1.921s and correctly said “On it, swapping red to blue in the Cedar rehearsal note.” The durable note readback retained exact capitalization and punctuation. This supports the prompt deletion for this scenario; it does not prove all generated acknowledgments are semantically correct.

Real isolated PGlite vector-contract tests passed 6/6, covering ranking/threshold identity, room exclusions, and optional vector omission. Calendar mobile and desktop captures were visually inspected. Camera/Cockpit unavailable states are expected harness limitations, not native acceptance.

## Calendar move follow-up: open blocker

Full repository verification exited successfully before this follow-up. The live request “For the Cedar rehearsal event, Tuesday at 9 AM works. Keep it 15 minutes.” failed in 4.542 seconds across four calls (36,538 input tokens). The planner copied an incomplete internal event ID from the UI, and lookup fell through to disconnected Google Calendar. Only one tool ran; the event was not moved.

The final model received a generic 409 rather than the connection reason, incorrectly described a calendar conflict, and requested repetition. Calendar error facts now identify the disconnected account; three deterministic handler tests passed. Canonical event-target validation/recovery and a successful live move remain required. This failure is not covered by the earlier passing create/clarification scenarios.

## Calendar target boundary and recheck

At `c65e5d6bd1a`, incomplete or foreign internal event IDs are rejected before provider lookup. No automatic ID repair or target substitution was added. The 29 scoped tests and Calendar typecheck passed.

The next live move succeeded in 3.873 seconds with four calls (32,594 input, 1,186 output tokens). The planner used the title query, the handler resolved the existing event and validated the requested interval, and the same event was saved at Tuesday September 22, 9:00–9:15 AM PDT with version2. UI readback matched. This demonstrates the valid query path; deterministic tests demonstrate malformed-ID rejection.

After the restart and later corrections, exact recall of the first move request also passed in 0.915 seconds with one call (11,076 input,526 output tokens). Remaining gates include complete source review, visual acceptance and the remaining combined scenarios.

## Final full browser audit — c65e5d6bd1a

`audit:app` completed with exit0: 230 Playwright checks passed in6.2m. DOM224 captures: zero broken/needs-work,23 soft radius/divider flags visually inspected. OCR212 verified, zero broken/regressions,12 expected exceptions visually inspected: Camera/Cockpit unavailable and LifeOps registry fallback. The earlier LifeOps bundle failure did not recur.

Remaining limitation: Family interview hover probing timed out on Open month, Add private source, and Generate 2026-10 packet in all four viewports. Cause is not established by the truncated timeout diagnostics; screenshots are not interaction proof. Native/remote feature acceptance remains separate. No paid model calls or source changes were needed. Local evidence: `eliza-consolidation-20260919/VISUAL-FINAL-REVIEW.md` and `visual-final-recheck/`.

## Receipt composition correction and post-restart QA

Canonical-prefix matching previously allowed arbitrary appended prose to borrow a tool receipt. Composition now requires the exact original FINISH evaluator prose; any applied claim in that prose needs the evaluator's own valid receipt selection. Exact tool replies and fenced multiline combinations remain supported. No new model call or prompt. Six targeted cases, four existing recovery-envelope cases and114 planner/audience cases passed (124 total). Full root verification completed with exit0; see `egress-composition-root-verify.log`.

Live Notes edit after restart: exact body persisted as `Bring the green notebook.` (revision5); three calls,6.542s,25,020 input/795 output tokens. Handler2774ms, planner466ms, completion505ms. This exercised ordinary evaluator receipt binding, not the rare canonical-prefix combination; the latter is deterministic regression coverage.

The first browser attempt remained Thinking and was absent from saved messages/trajectories at an intermediate check. Stop was clicked, but the request later reached processing. After reload, a repeated edit took2.019s/two handler calls (23,247 input/1,124 output tokens), repaired an invalid source label, correctly answered already done, and made no second write. This is a late-arrival/cancellation concern, not a passed cancellation scenario. Repository verification was running during the first attempt, so it is not a clean steady-state latency sample. The handler again generated Done with pending status: the earlier single acknowledgment success is not a universal fix. No additional paid test loops were run. Raw traces are `runtime/egress-composition-{edit,repeat}-trace.json`; stored readback is `runtime/egress-composition-note-state.json`.

## Cancellation investigation — no paid calls

Added a real HTTP/Vite test that waits for the upstream POST body to arrive, aborts the browser request before any response headers, and verifies upstream destruction. All7 proxy lifecycle tests passed without production changes, including existing cancellation after SSE headers and quiet-stream preservation. Existing agent persistence-after-done and heartbeat-release suites passed in isolated batches. Thus the observed delayed request is not reproduced by a basic proxy disconnect; do not change proxy behavior on this evidence.

Acknowledgment diagnosis: invoking `evaluatePlannedReplyEgress` with the captured early sentence `Done. The Cedar rehearsal note now says "Bring the green notebook."` and zero action results returned allow. `stateSideEffectClaimHasLocalSubject` requires a saved-item noun in the same sentence as Done, so this two-sentence assertion is missed. A targeted pending-work delivery correction remains open; this is separate from final receipt-composition binding.

Evidence: `proxy-preheaders-cancel-tests.log`, `cancellation-boundaries-tests.log`. Production remains9896c239663.

## Pending-work acknowledgment delivery correction

The existing completion-claim guard now receives the runtime pending-work phase. It withholds a bare Done opener before work settles, including the captured two-sentence premature completion claim. Settled final navigation replies retain their existing sentence-local behavior. No extra prompt, model call, substitute acknowledgment, timer, or action-routing change was introduced.

Validation: 59 focused classifier/egress tests passed; 702 Stage1/claim tests passed, including a runtime fixture proving neither early callback receives the premature claim while the final reply remains delivered with the original two fixture calls. Full root `bun run verify` exited0. Evidence: `pending-ack-guard-tests.log`, `pending-ack-runtime-tests.log`, and `pending-ack-root-verify.log` in the local consolidation evidence folder. No new paid calls.

Runtime remains on9896c239663 until restart; live acceptance of this guard remains open. The delayed-request/Stop concern and other remaining checklist items are unchanged.

## Source review checkpoint after pending acknowledgment correction

100 of the 270 source-ledger entries now have explicit semantic inclusion decisions (previous published accounting was50). This is review coverage, not 100 accepted features. Reviewed additions preserve original-source identity, recent conversation continuity, transient acknowledgment delivery and import provenance; avoid redundant schema text, terminal-provider apology calls and irrelevant action-search metadata; and retain exact schema-only wallet corrections. No additional paid model calls, wallet transactions or voice tests were used.

Full root verification passed for566862405ae. Live runtime remains9896c239663 pending restart. Outstanding work remains the unreviewed source entries, remaining combined scenario checks, the delayed-request/Stop investigation, and final handoff with explicit release gates. Local accounting: `SOURCE-REVIEW-ACCOUNTING.md`, `ledger-revision.json`, and `file-ledger-20260920.json` in the consolidation evidence folder.

## Personal directive and history review checkpoint

71 tests passed across the existing personal directive action/store suites on current source (`personal-directive-acceptance-tests.log`). Coverage includes removing one exact legacy personal directive without clearing unrelated rules, rejecting paraphrase/global removal, checking inferred provenance under concurrent explicit writes, and honoring replay IDs. These use the actual action/store with a fake runtime; they are not live model routing or database integration proof.

Source review now covers114/270 entries. Remaining implementation diffs are the Calendar handler and personal-assistant Calendar action; remaining other entries are tests, documentation and a generated report. Newly reviewed history changes retain original-source hashes, authors, room boundaries and correction dependencies; memory search rejects malformed scope filters rather than broadening reads. Developer trajectory labels distinguish model routing slots from actual handler/planner stages. No production change or paid call was made in this review batch. Live acceptance and remaining release gates stay open.

## Calendar implementation review

Both remaining Calendar implementation diffs have been inspected. Keep missing-time clarification, exact-interval conflict checks, source-target validation, duration preservation and receipt-grounded conversational completion. Calendar acceptance remains open for recipient identity and follow-up authorization checks; source inspection is not blanket approval. The existing four attendee contract tests passed, but passing an existing behavior test does not establish that its acceptance rule is correct. No paid model call, invitation or external Calendar write was made.

The local ledger now has116 reviewed entries,115 include decisions and one review-required implementation. Remaining unreviewed entries are tests, documentation and a generated report.
