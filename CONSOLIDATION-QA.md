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

## Calendar recipient clarification correction

Named guests with unverified model-proposed addresses now pause before creation instead of treating a display-name/mailbox match as address evidence. Exact user-supplied addresses remain supported. The handler reports awaiting user input with rejected acceptance; an unrelated invented guest remains excluded. This adds no model call or external lookup.

31 focused and real-PGlite handler tests passed, including an empty stored feed after the unresolved-guest request. Package typecheck passed. The first test attempt used an incorrect top-level receipt assertion; corrected to the existing nested failure.acceptance contract and reran successfully. Full root verification is running in `calendar-guest-root-verify.log`; do not treat it as passed yet. Live runtime remains on the preceding code. Prior-turn authorization and remaining acceptance scenarios stay open.

Full root verification for56340db491b completed with exit0 (`calendar-guest-root-verify.log`).

## Calendar follow-up source evidence

Guest and recurrence checks now reuse selected original user segments matching the current room and requester, with the current message last. This prevents a time-only clarification answer from discarding prior guest/cadence evidence. Assistant recaps, other authors/rooms and malformed source data are excluded. This does not add a model call or replace semantic interpretation of the current request.

57 focused checks passed across four files, including real-PGlite creation that preserves the prior requested guest after a time-only follow-up; tests also cover latest one-shot correction and excluded sources. Calendar typecheck passed. Full repository verification for this follow-up change remains pending; running demo still uses preceding code.

## Latest candidate restart and exact note edit

Full root `bun run verify` for609048e9c1e exited0 (`calendar-followup-root-verify.log`, session39924). Restarted only isolated API31392 after verification; old process exited0, new PID15168 reports ready, database healthy,35 plugins/95 services and settled boot. Preserved demos5248/5258 were untouched. Prior log archived as `runtime/server-before-calendar-followup-609048.log`.

Live turn18: `Change my Cedar rehearsal note to exactly "Bring the purple notebook."` completed in3.321s, three model calls,23,710 input/964 output tokens. Handler1.263s/10,778input generated a pending On it acknowledgment; planner0.839s/7,228input called NOTES_PATCH once; completion0.509s/5,704input used the applied receipt. Provider reported4,096 cached input tokens on the planner, zero on the other calls. Browser showed one final reply and Notes after full navigation showed exact saved text. Transient acknowledgment delivery was not captured by the two UI observations, so do not claim that independently verified. No retries or second mutation appear in the trace. Evidence: runtime/latest-note-edit-{trace,summary}.json. Cancellation and live Calendar follow-up remain open.

## Recurring Calendar follow-up: preserved intent, failed delivery

Live turns19–20 on609048: “Schedule a 15-minute Birch QA check every Friday morning on my local calendar.” then “9:30 AM, yes.” The follow-up retained weekly Friday recurrence and15-minute duration. Local Calendar rejected recurrence with ELIZA_CALENDAR_RECURRENCE_UNSUPPORTED. A fresh complete feed for September25 contains no event; no silent one-off downgrade occurred. This validates preservation through extraction and rejection, not successful recurring creation.

Clarification took7.114s/seven calls/67,847input tokens: handler1.281s emitted non_applied alongside pending work; handler repair1.258s; planner history restore0.648s; planner proposal0.729s; evaluator CONTINUE0.739s; planner REPLY0.895s; evaluator final0.415s. Only the next Friday was queried; the reply's claim that these were valid weekly slots exceeds that lookup.

Follow-up took4.693s/five calls/33,526input tokens: handler1.044s, planner0.947s, Calendar extraction0.677s, evaluator0.530s, forced failure synthesis0.880s. Both model failure explanations were discarded, and the UI showed the generic runtime-step failure. Source inspection identifies a likely cause: userSafeFailureReport rejects hasInFlightActionClaim; its conditional-offer recognition only allows a fixed set of input verbs, excluding the model's “reconnect Google Calendar and I'll…” offer. Reproduce this offline before changing the guard; do not simply disable it. No additional paid reruns are needed to diagnose these captured responses.

Evidence: runtime/birch-{clarification,followup}-{trace,summary}.json and runtime/birch-followup-friday-feed.json. Remaining defects: failure explanation rejection, redundant clarification steps, and single-day availability presented as recurring availability. Native local recurrence is unsupported by the existing service; implementing a recurrence engine is not justified as a latency fix.

## Calendar failure explanation replay correction

Captured evaluator and forced-synthesis replies both failed offline before the correction: the planner replaced them with its generic failed-step sentence. The existing in-flight claim guard now recognizes a user-owned connection prerequisite in the same clause as the offered future work. It does not allow an earlier sentence, quoted prerequisite or one conditional promise to authorize a later unconditional promise. No prompt, action routing, model call or external connection was added. This is a bounded prose classifier correction, not a complete natural-language proof.

Code commit b18ff926bec. Both captured replies now pass through unchanged, and the evaluator replay requires one planner call, one evaluation and one failed action, with no forced synthesis.55 focused tests and297 broader planner/failure tests passed; Core typecheck and Biome checks passed. Root verification is running in calendar-failure-root-verify.log, session99252. Current live runtime remains609048; do not attribute this correction to the demo until restart and live verification. Clarification overhead, recurring availability wording and other existing gates remain open.

## Failure-reply correction: root and live confirmation

Full root verification for b18ff926bec exited0 (session99252). Restarted isolated API31392 only; new PID21562,35 plugins/95 services, healthy database and settled boot. Runtime session68913. Previous log archived as runtime/server-before-failure-reply-b18ff926.log.

Live turn21 asked explicitly for the recurring Birch QA event. The UI delivered a clear explanation of unsupported local recurrence and offered connecting Google Calendar or a one-off event. Friday feed is complete and empty: no silent downgrade/write.4.144s/five calls,34,230 input/1,380 output; cache reads11,264input. The evaluator's first explanation contained two U+000B control characters in the time ranges. Offline invocation of the actual sanitizer returned invalid/reply-control-characters. This legitimately triggered recovery; the corrected connection-prerequisite guard allowed the recovery explanation to be delivered. Thus live reply correctness improved, but this run does not demonstrate fewer calls. Evidence: runtime/birch-failure-fixed-{trace,summary,feed}.json.

The separate clarification audit is at the local evidence root, CALENDAR-CLARIFICATION-CALL-AUDIT.md. Character duplication in deferred grounding is confirmed; removal still requires checking caller ownership and final context. No character or routing change was made in this verification turn.

## Deferred reply output-format correction

Code3a50ad527d4 removes the standalone “Return only the reply text” instruction only from planner-owned deferred LifeOps grounding. The completion evaluator owns the structured decision/reply format. Direct/standalone rendering retains its text-only format. Original user text, action facts, additional rules, character context and fallback grounding remain unchanged. This removes an observed conflicting instruction; it does not establish that the conflict caused the seven-call trace or guarantee fewer model calls.

The real executor/renderer/settlement/serialization test now checks that deferred model input preserves facts and receipts without the text-only format override; standalone calls retain the instruction. Five grounded-reply test files passed, including context preservation, negation, quotation and deferred ownership. Agent typecheck and scoped Biome checks passed. Root verification is running in deferred-reply-format-root-verify.log, session2595. Live runtime remainsb18ff926bec. No paid calls were made in this change.

Character duplication remains unmodified: the normal pipeline supplies its character context, but deleting the action copy based only on reply ownership is not yet justified for every custom caller. The cleanup must prove the final prompt remains complete.

Full root verification for3a50ad527d4 completed exit0 (session2595, deferred-reply-format-root-verify.log). Live runtime stillb18ff926bec; this completion does not claim new live latency evidence.

Source accounting now149/270:145 include decisions,3 exact upstream equivalents,1 review-required Calendar implementation. Latest six test reviews cover exact import repair, SSE/chat acknowledgment separation, retrieval completion timestamps and browser argument forwarding. Their mocked seams are recorded in the local ledger. Two additional files have no remaining diff against reviewed develop. Remaining121 entries are unreviewed; no blanket feature acceptance.

## Clean steady-state Stop check on verified reply-format candidate

Restarted only isolated31392 after root verification for3a50ad527d4. Runtime session53355/PID27428; health ready, database healthy,35 plugins/95 services, boot settled. Original demos preserved. No build ran during these two UI attempts. Previous log: runtime/server-before-deferred-format-3a50ad5.log.

Turn22 asked to change the QA note to orange. It completed in2.590s/three calls/23,712input tokens before the attempted Stop interaction, which failed because the control was gone. This is a normal successful edit, not cancellation evidence.

Turn23 asked for silver. Stop was successfully clicked at1789936727486 after a fresh UI observation in the same browser invocation. UI displayed Response interrupted. Trace step-1789936727260-nmsiy4 terminated at1789936727593, duration333ms, one interrupted model attempt and zero tool events. Its trace status is error rather than a distinct cancellation label. Prompt token count0 has no completed provider usage; do not infer zero billing. Stored note stayed orange at revision7; independent Notes reload confirmed it. No subsequent write was observed.

This passes clean pre-effect cancellation. It does not prove rollback after an already-committed action or explain the older build-time late-arrival incident. No speculative cancellation code change was made. Evidence: runtime/cancellation-{race-completed,clicked}-{trace,summary}.json, cancellation-before-state.json and cancellation-after-state.json.

## Personal preference create/remove through live chat

Turns24–25 on3a50ad527d4 used disposable QA-garden preference. Creation4.843s/five calls/37,389input tokens selected MEMORY_CREATE(kind=preference), not PERSONALITY. It saved record61402f5a-4cad-42f8-a93b-4b74a54010bc. User explicitly asked for exact text; the planner instead paraphrased it as “When discussing the user's QA garden, use metric units.” This is an exact-wording limitation, not a passed verbatim-write case. The source chat message retains the original wording.

Removal4.097s/five calls/42,158input tokens used MEMORY_SEARCH then MEMORY_DELETE with that exact record ID and an applied delete receipt. It asked no redundant scope question and made no broader mutation. A fresh facts browse returned8 rows, no test preference and hasMore=false. No pre-test full-store snapshot was captured, so do not use the final sentence alone to prove every unrelated preference byte-identical. Deterministic per-user/global preservation tests remain the stronger evidence for that invariant.

This passes targeted memory-record removal and cleans the fixture, but does not prove live PERSONALITY remove_directive routing or exact preference text preservation. Evidence runtime/preference-{create,remove}-{trace,summary}.json and runtime/preference-facts-observation.json. No additional paid reruns were made.

## Preference/history test review

Source ledger162/270:158 include,3 upstream-equivalent,1 Calendar review-required. Thirteen additional test diffs reviewed in full: preference provenance/removal/replay, dispatcher admission, connector-envelope addressing, recent-original continuity, retained-page rendering, initial REPLY presentation, direct-voice schema/history parity, optional context-read acknowledgments and provider schema-error classification. Voice entries are source-contract review only; no voice tests were run. Existing deterministic preference coverage does not prove the live model routes an arbitrary preference request through PERSONALITY rather than MEMORY. No production changes, new paid calls or additional test executions in this review batch.108 original ledger entries remain unreviewed.

Source ledger169/270 after provider/schema review:165 include,3 upstream-equivalent,1 review-required. Seven additional diffs cover lossless schema factoring, native/fallback HTTP wire formats, retry budgets across concrete model tiers, private-safe timing telemetry, SQL vector projection/scope filtering and wallet schema compatibility without execution. Mock/local-server boundaries and overlapping retry parameter coverage are noted in the local ledger. No code change or paid call in this batch;101 original entries remain unreviewed.

## Calendar and scheduling source review checkpoint

Fourteen additional complete test diffs reviewed against ec23d0f670c at candidate9c8522e5cac. Original inventory now183/270 reviewed (179 include,3 upstream-equivalent,1 Calendar handler review-required; no blanket acceptance).

The tests preserve user-grounded extraction rather than planner timestamp authority, explicit guest-address evidence, original-user follow-up context and current corrections, request-time date anchoring, timezone precedence, distinct proposed slots, and provider write/approval boundaries. Calendar final-response tests now assert model handoff with recorded facts instead of a hard-coded self-verified reply. Aggregate feed and individual ICS source observation timestamps remain distinct.

Limitations: extraction and fresh-source fixtures cannot establish real model accuracy or provider freshness. Recurrence scope tests use service doubles and do not establish local recurrence support. Seven-call clarification and overbroad weekly availability remain open from live evidence. No production edits, new paid calls or repeated test execution in this review batch. Corrected stale current-code wording in status.

## Deferred action presentation contract

The seven-call Calendar trace showed an evaluator CONTINUE with no reply after a successful availability read awaiting user input. Source inspection found the deferred action settlement helper deleting modelReplyRequired, preventing the existing evaluator schema from requesting a mandatory reply field. The CONTINUE itself came from the model, not runtime repair.

Changed the deferred settlement branch to set modelReplyRequired=true, preserving success/failure, awaiting-user-input state, full grounding and receipt metadata. This uses the existing completion contract; it does not force FINISH or treat a proposed time as an authorized write. Documented that contract at ActionResult.

Two new cases exercise real settlement, planner-result serialization and evaluator schema construction for successful and failed clarification outcomes. Both failed before the change, then passed. Focused tests183 passed; planner/message suites1173 passed; Agent executor/deferred-renderer handoff file passed (plus9 mobile workspace entry checks). Scoped Biome passed. Full root verification is running under session77087; log deferred-required-root-verify.log in the external evidence folder. No live restart or paid call yet; UI5268 still uses3a50ad527d4.

No claimed seven-call or latency resolution: the model can still CONTINUE with an empty reply, request needed context or fail output validation. Overbroad weekly availability, speculative history restoration and the Stage-1 routing repair remain separate open observations.

## Calendar test review complete

Six remaining original Calendar test diffs inspected in full against ec23d0f670c. Inventory now189/270 reviewed (185 include,3 upstream-equivalent,1 Calendar handler review-required). Real PGlite assertions check saved/unchanged event fields, guest boundaries, exact supplied description, targeted follow-up moves and local ID isolation. Deterministic handler tests cover write-time conflict checks, duration preservation, DST civil-day reads and typed preflight repair without repeated completion.

These tests use model doubles and do not establish general extraction accuracy, external invitation delivery, recurring availability or live latency. Historical test names referring to self-verification are stale; current assertions require model-owned replies and factual receipts. No tests rerun solely for this review and no paid calls.

## Notes test and scenario source review complete

Five complete original Notes test/scenario diffs reviewed against ec23d0f670c; inventory194/270 (190 include,3 upstream-equivalent,1 Calendar handler review-required). The deterministic action scenario now compares writes and reads with persisted JSON, checks exact multiline/double-space content, stable identity/creation timestamp and precise deletion. Action tests cover reopened-store persistence, exact IDs versus decoys, duplicate title clarification, role denial, date filters across DST and unchanged omitted fields. Provider tests verify fresh owner-scoped matching records with original Unicode and identity. Literal colon parsing no longer invents a title/body separator.

This is source review using previously recorded test results, not a fresh live run. The planner/evaluator doubles cannot prove natural-language routing or disambiguation accuracy. No paid calls.

Root verification for ef88e31918b completed exit0 (session77087). Preserved previous runtime log as runtime/server-before-deferred-required-ef88e31.log. Stopped only owned API PID27428, verified port31392 released, and started the same isolated launcher with current source (session6701, API PID35418). First health check ready/canRespond true, database healthy, zero plugin/service failures; deferred boot still pending. Original demo ports unchanged. Live follow-up is next.

## Live ef88e31918b verification: turns26–27

Runtime fully ready (35 plugins,95 services, zero failures, deferred boot settled).

26. “Schedule a 15-minute Spruce QA check every Friday morning on my local calendar.” Trace step-1789938063414-h9m90a,2.619s,one handler call (2.219s),10,722 input tokens,1,387 output tokens,6,144 reported cache reads. Responded from prior context that local recurrence is unsupported and offered a connected calendar or one-off alternative. No tool executed. This did not exercise deferred action presentation.

27. “Check what's free this Friday morning for 15 minutes. Don't book anything yet.” Trace step-1789938092268-qagg61,3.604s,three calls,27,299 input tokens,1,525 output tokens,6,144 cache reads. Handler1.465s/10,833 input;planner0.678s/7,762 input;completion0.698s/8,704 input. Remaining0.763s is other turn overhead. One CALENDAR_PROPOSE_TIMES preview with modelReplyRequired=true. No routing repair, RESTORE_CONTEXT or subsequent planner REPLY. Final evaluator FINISH delivered three slots at9:00,9:15,9:30; its9:00–9:45 statement is covered by those contiguous15-minute intervals. No weekly availability claim. No booking tool; explicit Sep25 feed read afterwards was complete/fresh/empty.

Raw traces, summaries and feed saved as runtime/spruce-recurring-capability-* and runtime/friday-deferred-reply-*. The follow-up differs from the original recurring request and has more prior context, so no causal claim that the one-line change alone reduced seven calls to three. Under3s target is not met in this run. No further paid tests in this batch.

## Runtime, provider and approval source review

24 additional original inventory diffs reviewed in full;218/270 now reviewed (214 include,3 upstream-equivalent,1 Calendar handler review-required). These cover unpublished-reply requirements, single final callback attribution, legacy diagnostic projection, trajectory stage labels, literal search distinctions, registered child dispatch, preserved partial effects, required reconciliation targets with SQL snapshots, timezone override precedence, inferred activity labeling, lossless keyless MCP parsing and TypeSafe probability validation. Recent-conversation manifests retain authorization without eager body reads or invented message counts. Historical peer plan is retained only as a labeled snapshot.

The review distinguishes intentional routing/terminal repair calls from performance proof. Finite phrase tests do not establish universal natural-language correctness; canned provider responses are protocol coverage, not live service acceptance. No production changes or paid calls.

## Planner, failure and recall source review

16 additional original inventory diffs reviewed in full;234/270 reviewed (230 include,3 upstream-equivalent,1 Calendar handler review-required). Evidence covers initial reply presentation, preparatory versus requested discovery, conflicting native decisions, one final publication, exact proposal whitespace, catalog/schema semantic preservation, failure handling without paid apologies, transcript resync timing, attested reply provenance and205-source real PGlite recall. Historical demo measurements remain explicitly historical.

No production edits, repeated tests or paid calls. Schema/canned-generation checks prove their specific boundaries, not general model accuracy or speed.

## Context and failure-contract source review — 240/270

Reviewed six complete changed-file comparisons against develop ec23d0f670c:

- `GANTTNUBS-ACCEPTANCE-SNAPSHOT.md`: Historical saved acceptance board retained behind explicit current-status banner. Older ports, acceptance and peer-integration state are historical evidence, not current completion claims.
- `packages/core/src/services/evaluator.test.ts`: Post-turn evaluator transport tests preserve complete extraction schema and source across native, JSON and plain retries, with explicit extraction system precedence over character fallback. Tests compare actual fallback payloads to native payloads.
- `packages/core/src/__tests__/message-routing-live-regression.test.ts`: Routing tests prevent incidental coding words from escalating a complete simple no-effect reply, while retaining escalation for selected actions, pending intents, progress-only replies, missing/applied effect status and non-simple context. Genuine selected coding work still routes to TASKS.
- `packages/core/src/runtime/__tests__/completion-context.test.ts`: Selection tests retain exact source events, distinguish reviewed-empty from absent/stale selections and preserve original context. Native restore schema rejects already-restored scopes while allowing still-deferred scopes; restoration executes no effects. Voice source-contract assertions do not establish voice acceptance.
- `packages/core/src/runtime/__tests__/planner-loop-terminal-finish-without-message.test.ts`: Terminal planner tests retain exact approved text including whitespace, prefer evaluator correction when supplied and finish without an extra terminal continuation. Four canned model responses validate orchestration, not live semantic judgment.
- `packages/core/src/services/message.runtime-failure-suppression.test.ts`: Transport failure tests emit one nonpersistent classified failure without a model apology for HTTP401/402/403. Failed action callbacks stay private through planner recovery until the final scoped explanation. Deterministic replies do not establish live preference scope interpretation.

Ledger now has240 explicit reviews:236 include,3 upstream-equivalent and1 Calendar handler review-required;30 remain unreviewed and no entries are blanket accepted. This checkpoint changes review/status documentation only. Existing ef88e31918b code/test/live evidence remains applicable; no new paid model calls. Corrected the stale status sentence that still described the superseded3a50ad527d4 runtime as current.

## Source identity and background work review — 245/270

- `plugins/plugin-scheduling/src/scheduled-task/runner.test.ts`: Real runner with in-memory store rejects invalid edits and unregistered escalation channels without changing stored tasks; valid edits recompute next-fire time. Captured upsert options prove scheduling intent, not a real timed delivery.
- `packages/ui/src/hooks/useRealtimeVoiceMint.test.tsx`: Hook tests retain late-gateway recovery and cancel retry admission on unmount; local and remote health probing needs no force flag, cloud does not probe. Fetch and timers are controlled. Source preservation only; no voice session or physical voice acceptance.
- `packages/core/src/services/message/source-selection-binding.test.ts`: Actual binding and source-selection functions retain stable native wire schema while binding each response to its dispatch source set. Cross-turn, cross-room, mutated, unknown, stale and incomplete selections reject; raw evidence and shared schema remain unchanged. Legacy JSON and unrelated read tools are not rebound.
- `packages/core/src/services/__tests__/history-quote-discovery.test.ts`: Recall tests accompany retrieved assistant recaps with complete exact earlier original sources without inflating literal match receipts. Later copies cannot establish earlier provenance; explicit current selection still works. User quotes, partial matches, stale sources and misses do not invent dependencies; duplicate originals and full restoration remain available.
- `packages/core/src/services/embedding-delivered-reply.test.ts`: Real runtime, in-memory store and background queue with fake embedding provider admit a persisted delivered reply once. Missing, transient, foreign and changed sources reject. Delivery does not await detached lookup; stop cancels admission and lookup failure is reported without failing delivery. This does not establish external embedding-provider acceptance.

245 explicit reviews:241 include,3 upstream-equivalent and1 Calendar handler review-required.25 entries remain; no blanket acceptance. This checkpoint has no production code change or paid model calls. Core guide comparisons were only partially read and remain unreviewed.

## Discovery and retained-context source review — 254/270

- `packages/core/src/actions/action-schema-union-siblings.test.ts`: Schema conversion and validation tests enforce common object/numeric constraints alongside anyOf and oneOf, preserve exact literal values and pure mixed-type unions, and prevent branch defaults from supplying explicitly required common fields. Common normalization/default behavior remains tested.
- `packages/core/src/__tests__/message-v5-widget-markers.test.ts`: Real callback wrapper and interaction parser preserve tool-owned choice/form controls and explanatory text without character rewriting. Explicit structured controls remain authoritative; plain or malformed intermediate prose stays withheld. Canned model replies test delivery orchestration rather than live interpretation.
- `plugins/plugin-app-control/src/evaluators/view-context-planning.test.ts`: Navigation tests extend direct navigation decisions to direct voice while retaining domain/question/group exclusions and role/context gates. Direct text uses a smaller destination notice with fresh capability discovery for unfamiliar interactions; legacy paths retain descriptions. No physical voice acceptance.
- `packages/agent/src/runtime/prompt-optimization.test.ts`: Trajectory tests preserve requested zero/nonzero/absent temperature in fallback capture and never overwrite provider-recorded temperature or model identity with configuration guesses. Controlled logger/storage tests establish enrichment rules, not provider latency.
- `packages/core/src/services/message/tool-discovery.test.ts`: Named fresh descriptions return complete parameter evidence without execution or enablement; revoked names reject after fresh authorization. Catalog-only and load receipts remain distinct. Explicit parent/child loads preserve develop canonical-family exposure and repeated loads do not duplicate tools.
- `packages/core/src/runtime/__tests__/provider-context-review.test.ts`: Provider review preserves exact selected bodies and access notices without original mutation. Missing, incomplete, stale, changed-owner/room/body/turn reviews retain full evidence. Freshly loaded originals require fresh review; duplicate IDs reject and repeated selected occurrences materialize exact original text.
- `packages/core/src/services/evaluator-background.test.ts`: Real background queue tests with canned extraction responses batch append-only retention within the continuity window without consuming deferred evidence or delaying other evaluators. Backfill, changed/deleted sources and remaining pages bypass cadence to avoid starvation. Direct voice indexing is source coverage only.
- `packages/core/src/services/message/history-retention-dependencies.test.ts`: Actual retention/retrieval functions preserve transitive original correction/cancellation dependency groups through deferral. Literal match receipts remain literal; malformed groups and changed/deleted/foreign-scoped sources reject. Linked visible sources expand without unrelated deferred bodies; legacy checkpoints remain valid. Model semantic judgment is not proven by supplied graphs.
- `packages/ui/src/components/developer/DeveloperReader.test.tsx`: Reader hook tests discover late background runs and refresh their recorded revisions, paginate exact message/room owners, pause hidden polling, avoid overlapping lookups, reject stale turn responses and stop 401/403 retries until explicit retry. Mock network tests do not establish real remote capture acceptance.

254 explicit reviews:250 include,3 upstream-equivalent and1 Calendar handler review-required.16 entries remain; no blanket acceptance. Documentation-only checkpoint; production code stays ef88e31918b. No paid model calls or test reruns for source inspection.

## Exact recall and final reply source review — 260/270

- `packages/core/src/services/message/egress-policy.combined-verified-reply.test.ts`: Receipt composition tests require exact canonical text and separately owned evaluator prose; missing, stale or protocol-failed evaluator proof cannot license appended completed-action claims. Pending acknowledgments reject captured premature Done variants while preserving progress and reported quotations. Finite phrase cases are not universal semantic proof.
- `packages/core/src/__tests__/planner-happy-path.test.ts`: Canned full runtime paths withhold intermediate action prose, retain typed coding failures for final publication and publish canonical settled or evaluated replies once. Settled actions still avoid redundant evaluator/rewrite calls; final sanitizer remains active. This removes prior callback-echo assumptions without treating failed effects as success.
- `packages/core/src/services/message/source-reply.test.ts`: Source-backed replies preserve exact original bytes, literal speaker prefixes and routing guards. Snapshot identity rejects altered turn/room/source/speaker and mismatched records; unavailable sources remain in recovery. Reviewed provider originals do not acquire local history identity. Malformed parts reject while ordinary marker-looking text stays literal.
- `packages/core/src/services/message/source-reply-references.test.ts`: Serialized reply references carry original source bindings through later authorized recall, including chained earlier quotations without speaker relabeling. Edited/deleted/foreign/later originals, rewritten replies, tampered hashes and user copies cannot supply dependency proof. Final text changes remove obsolete references.
- `packages/core/src/services/__tests__/history-search-receipts.test.ts`: Speaker-scoped literal searches preserve inline constraints and report exact match scope/count, not universal absence. Mixed and legacy syntax stay distinct. Bounded identity repair eligibility requires complete supplied originals; stale projections reject. Repeated-body encoding reconstructs exact bytes, roles, metadata distinctions and occurrences.
- `packages/core/src/runtime/__tests__/evaluator.test.ts`: Evaluator tests retain legacy thought parsing while removing required duplicated reasoning, require presentation for deferred model-owned outcomes, and keep context restoration effect-free. Clipboard schema follows host capability and unsupported outputs deliver no effects. Applied claims without committed receipt proof continue without publication. These deterministic tests include ef88 regression coverage, not a universal grounding guarantee.

260 explicit reviews:256 include,3 upstream-equivalent and1 Calendar handler review-required.10 entries remain; no blanket acceptance. Documentation-only checkpoint; no new production code, paid calls or test reruns.

## Calendar and pending-work source review — 264/270

- `plugins/plugin-personal-assistant/test/calendar-optional-tool-parameters.test.ts`: Promoted native Calendar schemas retain canonical create capabilities and explicit search query, complete availability interval, proposal window/duration and typed update/delete target requirements. Local validation rejects empty/invalid values not represented by strict provider grammars. Legacy umbrella compatibility remains separate; schema acceptance alone does not prove timing authority.
- `plugins/plugin-personal-assistant/test/calendar-action-effect-receipts.pglite.test.ts`: Registered action tests use real PGlite and Calendar service for full-duration conflict checks, distinct read receipts and invalid-window rejection before reads. Proposals preserve stored events and await selection; missing/duplicate targets do not receive guessed duration. Real deferred renderer and controlled extraction verify host plumbing, while explicit extraction output isolates approval replay. Not live model semantic acceptance.
- `packages/core/src/runtime/__tests__/planner-loop-pending-scope.test.ts`: Planner-loop tests keep unevaluated progress from becoming verified final text, bound empty/pending continuations and plan required reads before evaluation. Settled preparatory reads skip intermediate evaluation with read-only proof while keeping constraints and final evaluation. Corrected final writes stop regenerating obsolete preflight failures; unrelated unresolved failures remain distinct.
- `packages/agent/src/providers/relevant-conversations.test.ts`: Recall provider tests exclude current-room duplicate retrieval, preserve every readable unidentified record, and apply retention only to validated private source rooms with fresh scope. Hidden records remain excluded. Shared-prefix/repeated-body encodings reconstruct exact text and preserve occurrence/author identity; stale or incomplete review restores complete evidence. Mock access/search collaborators are not live cross-account permission acceptance.

264 explicit reviews:260 include,3 upstream-equivalent and1 Calendar handler review-required.6 entries remain; no blanket acceptance. Documentation-only checkpoint; existing ef88e31918b production evidence remains unchanged. No new tests or paid model calls.

## Guide and historical evidence review — 268/270

- `packages/core/CLAUDE.md`: Full changed guide inspected in two parts. Records fresh authorized discovery, lossless source recovery, direct-conversation source contracts, planner-first required-tool work, final reply ownership, exact personal-directive scope and dependency preservation. Source/model-judgment limits remain explicit; direct voice documentation does not establish voice acceptance.
- `packages/core/AGENTS.md`: Byte-identical to completely reviewed core CLAUDE.md (cmp passed). Same discovery, source identity, pending-work, reply ownership and personal-scope contracts; no separate acceptance claim.
- `GANTTNUBS-PLAN.md`: Complete historical plan inspected. Preserves original scope, rejected experiments, measured latency, paid-test discipline, acknowledgement evolution and prior checkpoint boundaries. Current-status banner supersedes old active-checklist language; prior passes are not combined candidate acceptance.
- `GANTTNUBS-SCENARIO-RESULTS.md`: Complete historical scenario ledger inspected. Retains failed date/scope/recovery runs, per-call timing and cache counts, corrected behavior and exact fixture-preservation boundaries. Historical source/runtime receipts are scoped rather than treated as current combined acceptance or latency guarantees; current-status banner remains authoritative.

268 explicit reviews:264 include,3 upstream-equivalent and1 Calendar handler review-required.2 larger test comparisons remain; no blanket acceptance. Documentation-only checkpoint; existing production code and live evidence remain unchanged.

## Source inventory review complete — 270/270

- `packages/agent/src/actions/memories.test.ts`: Complete 845-line changed comparison inspected in three parts. Invalid explicit scope IDs reject before reads rather than broadening search. Original requester corrections remain retrievable independently of assistant recaps. Real action/planner plumbing with controlled decisions covers pending read evaluation and matching pagination recovery without clearing unrelated failures. Lossless shared metadata preserves exact Unicode/body bytes, author counts, page scope and redaction; fresh aggregate counts distinguish unsearched categories. This does not close live preference paraphrase or PERSONALITY removal acceptance.
- `packages/core/src/__tests__/message-runtime-stage1.test.ts`: Complete 2070-line changed comparison inspected in four parts. End-to-end Stage-1 harness covers bound provider review through planner/completion, fresh/revoked context recomposition, exact native source replies and legacy formats, field activity refresh, invalid-checkpoint full fallback, source/label repair before dispatch, effect-free reads and cancellation. Progress labels remain stable and separate from final replies, premature completion is withheld, required-tool work plans before evaluation, unknown tool hints discover actual capabilities, and settled callback prose is returned once to outer delivery. Direct-voice fixtures cover source plumbing only. Canned model decisions do not prove universal relevance, grounded prose or live voice behavior.

All270 original inventory entries now have decisions:266 include,3 upstream-equivalent and1 Calendar handler review-required pending behavior gates. No entry is blanket accepted. Source inspection is complete; Calendar/preference live acceptance, remaining combined persistence/recovery and final handoff still require closure. Documentation-only checkpoint; no new model calls or test reruns.


## Memory mutation completion contract

The recorded preference-create run took4.843s/five model calls: handler,
planner, evaluator, then separate reply synthesis and grounding. Its successful
MEMORY result retained canonical `userFacingText` and `turnComplete:true`,
without `modelReplyRequired`. The evaluator therefore did not require
`messageToUser`. This is distinct from the Calendar deferred-result fix.

Planner-owned successful create/update/delete results now use the existing
`applyGroundedActionReply` deferred contract. Complete mutation facts and
receipts remain available; standalone callers, reads and failures keep their
existing path. No new model call, routing rule or system-prompt instruction is
added. Three real action-to-evaluator regressions failed before this change
because the completion schema did not require a reply; all153 tests in the
memory action file passed afterward. Agent typecheck and package lint passed
(existing15 warnings/two infos); root verification completed successfully
(session4904 exit0). Guide parity157 and changed-document link checks passed. The model and database are deterministic
fixtures, so these tests do not establish live latency or model compliance.

Evidence: external runtime files `memory-completion-before.log`,
`memory-completion-after.log`, `memory-completion-typecheck.log`,
`memory-completion-lint.log`, and `memory-completion-verify.log` under the
consolidation evidence directory. Live runtime remains on ef88e31918b; no new
paid calls or runtime restart accompanied this change. The separate exact-text
issue remains open: MEMORY create's parameter description currently requires
third-person rewriting and conflicts with an explicit verbatim-save request.


## Exact memory text preservation

Create/update trimmed supplied text before storage, independently of the
planner's rewriting instruction. Two storage/search round-trip tests failed
on leading/trailing whitespace before correction. Supplied nonblank text is
now stored intact; blank input still rejects. The tool parameter description
now honors explicit verbatim requests instead of unconditionally requiring
third-person rewriting. This replaces the conflicting instruction in the
existing tool schema, without a global prompt addition or another model call.

All156 memory-action tests, Agent typecheck and package lint passed. Evidence:
`runtime/memory-exact-before.log`, `memory-exact-after.log`,
`memory-exact-typecheck.log`, `memory-exact-lint.log` in the external evidence
directory. Full root verification of this follow-up passed (session16994 exit0;
`memory-exact-verify.log`). The subsequent live evidence follows below.

Remote recheck: `/home/milady/projects/eliza-wt-merge` remains clean at
89a476f3d750feb40d7f1aeac99ce2219479d8fd, already included. Its locally cached
tracking ref says behind one; no fetch or source modification was performed.
Full registered-worktree output is saved in
`remote-worktrees-recheck-20260920.txt`; this does not identify which other
remote checkout, if any, contains the user's latest unreviewed work.


## Live memory check on f210e2f1e3c

Isolated API31392 restarted cleanly on f210e2f1e3c (PID49649; launch session44552),
UI5268 reloaded. Readiness/deferred boot settled with35 plugins/95 services and
zero failures. Previous server log preserved as `runtime/server-before-memory-f210e2f.log`.
Original demo runtimes were not touched. Total live QA turns now29.

- **Exact save PASS:** “Remember this exact preference: \"For my QA garden, I use metric units.\" Keep my other preferences.” Trace `step-1789940203751-vubt26`,
  `memory-exact-live-create-*`:2.780s,3 calls,23,226 input/720 output tokens,
  3,072 cache-read input tokens. Handler1.048s/10,902 input; planner0.571s/6,458;
  completion0.427s/5,866. Exact text persisted as fact15c9e33d-6d6b-4b0d-bab9-d578128374f3.
  Snapshot comparison: one added record, zero removed/changed pre-existing
  records; no more result pages. No separate synthesis/grounding calls. This
  is an observed run, not a latency guarantee or controlled benchmark.
- **Natural follow-up removal FAIL, no unintended write:** “Forget only the
  QA garden preference I just saved. Keep my other preferences.” Trace
  `step-1789940235125-cqewxt`, `memory-exact-live-remove-*`:4.674s,6 calls,
  49,024 input/1,265 output tokens,12,288 cache-read input tokens. Handler0.989s;
  planner0.521s requested context restoration; planner0.520s omitted the target;
  evaluator0.475s continued; planner0.656s again omitted the target;
  evaluator0.473s honestly reported failure. Two executed MEMORY_DELETE results
  returned MEMORY_MISSING_ID; the restored-context batch made no write.
  User-visible reply unnecessarily asks for another nudge. The QA preference
  remains; all nine baseline fact records are unchanged.

The recorded native schema exposes query and memoryId but requires neither;
only confirm and turn scope are required. The handler correctly refuses to
invent a target. Next work is the mutation target-selection contract and its
planner retry behavior, preserving by-ID and by-query compatibility, scope and
confirmation. Do not fix by guessing a last-used record or deleting every
matching fact. No additional paid retry was sent.


## Required memory mutation target

The captured `{confirm:true}` delete passed the registered tool validator even
though the handler correctly rejected it. A regression against the registered
MEMORY_DELETE action failed before the correction. Registered MEMORY_UPDATE
and MEMORY_DELETE now require a single structured `target` with `kind`
(memoryId or query) and nonempty `value`. Existing nested-object schema support
is used; no framework/provider change, additional tool, or model call.

The native promoted-tool argument format deliberately changes. The MEMORY
umbrella retains flat memoryId/query callers, including their existing ID
precedence; mixing that legacy shape with target rejects. The handler never
chooses a recent record on the caller's behalf. Typed query targets stay
queries even if their text looks like a UUID. Exact target IDs still pass the
existing UUID checks; missing confirmation and ambiguous scope still refuse.

Both scoped Agent test files passed (memory actions and registered plugin
contracts), including real handler/validator checks for each target kind,
unrelated-record preservation and invalid/conflicting targets. Agent typecheck
and package lint passed. Root verification passed (session8685 exit0) in
`runtime/memory-target-verify.log`. Before/after evidence:
`memory-target-contract-before.log`, `memory-target-contract-after.log`;
package checks: `memory-target-typecheck.log`, `memory-target-lint.log`.

No new live call or restart yet. UI5268/API31392 remains on f210e2f1e3c, and
QA fact15c9e33d-6d6b-4b0d-bab9-d578128374f3 remains pending removal. Live QA
count remains29. The next live check should remove only that disposable
preference and compare the saved baseline, after verification settles.


## Live explicit-target deletion on04719e2706e

API31392 restarted cleanly on04719e2706e (PID56036; launch session58563),
UI5268 reloaded. Readiness and deferred boot settled with35 plugins/95 services,
zero failures. Previous log: `runtime/server-before-memory-target-04719e2.log`.
No original demo was restarted. Live QA count now30.

Repeated the exact failed natural request once: “Forget only the QA garden
preference I just saved. Keep my other preferences.” Trace
`step-1789941116895-x3r6d5` / `memory-target-live-remove-*`: **3.015s, three
model calls,24,523 input/1,214 output tokens,10,240 cache-read input tokens**.
Handler1.112s/10,921 input; planner0.685s/7,690; completion0.445s/5,912.
One successful MEMORY_DELETE selected query target “For my QA garden, I use
metric units.” No restore, missing-target retry, separate synthesis or grounding.
The final visible reply confirmed scoped removal. The committed deletion
receipt and fresh facts response agree: the QA fact is absent; all nine
pre-existing fact records equal the pre-create baseline, with no extra pages.
Snapshots: `memory-target-live-before-facts.json`,
`memory-target-live-after-facts.json`, baseline
`memory-exact-live-before-facts.json`. The saved fact surviving restart and
then being found/deleted also exercises persistence. PERSONALITY slot removal
is distinct and remains unproven live. These are individual QA observations;
the retry has additional conversation context, so do not infer a controlled
speedup or a universal three-call guarantee.


## Live personality directive failure and receipt correction

Turn31 on04719e2706e: “For me, add this reply rule: when I ask about the QA
greenhouse, end with GREENHOUSE CHECK. Keep my other preferences.” Trace
`step-1789941312567-s9fggw`, `runtime/personality-live-add-*` ended in error:
11.915s,17 model calls,120,879 input/4,374 output tokens,52,224 cached input.
No further paid call was sent after this failure.

The first tool call omitted directive text, which was optional on the promoted
schema. A corrected add persisted the rule to the requester slot (one directive;
traits and reply gate null). Its result had success/verifiedUserFacing but no
effectReceipts. Applied completion claims therefore failed the existing receipt
gate, causing repeated reply attempts and recovery. The final visible message
was “I couldn't verify my reply against the available results.” The rule IS
saved; the visible failure is not a rollback. The temporary directive text is
`when I ask about the QA greenhouse, end with GREENHOUSE CHECK` and must be
removed after validation. Original demo settings were not changed.

Source correction: promoted add/remove directive tools require directive text.
Successful durable add/remove results attach slot-change receipts and complete
before/after data. Planner-owned calls use shared deferred presentation and
suppress their standalone callback; other callers keep direct replies. The
receipt guard remains unchanged. No general personality reset, permission
change, scope inference or new model call was introduced.

Two action-to-real-evaluator tests failed before correction (CONTINUE instead
of FINISH) and now pass with one evaluation, alongside stored-rule preservation.
All413 personality tests across14 files, Core typecheck and package lint pass.
Evidence: `personality-receipt-before.log`, `personality-receipt-after.log`,
`personality-receipt-typecheck.log`, `personality-receipt-lint.log` under runtime.
Full root verification passed (session87319 exit0 / `personality-receipt-verify.log`).
No live acceptance of this correction yet; API still runs04719e2706e.
The change covers add/remove directives; do not generalize this result to
unexercised trait/profile operations.
