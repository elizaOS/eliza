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
