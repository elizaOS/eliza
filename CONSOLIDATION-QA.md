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
