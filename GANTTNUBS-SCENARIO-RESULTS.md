# Post-call Notes/Calendar scenario evidence

Final source candidate: `d502d12aad7` on `ganttnubs`. Earlier tables identify historical runs; the final acceptance receipt is below. These are individual local runs,
not latency percentiles, full release acceptance, or a comparison against an
exact August 7 demo build. Voice remains deferred. Final-source repository
verification passed 373/373 tasks; final browser checks and fixture cleanup are complete.

## Actual model calls and speed

Inputs are summed across calls: they are not all unique context. Cache reads
are a subset of inputs, not additional tokens or a measured bill. Provider-call
timers include transport, provider work and generation; these receipts cannot
attribute delay specifically to airplane Wi-Fi. Do not add overlapping spans.

| Scenario | Calls | Total seconds | Input tokens | Cached input tokens | Outcome |
|---|---:|---:|---:|---:|---|
| Notes: explicit date window | 3 | 3.427 | 26,700 | 11,264 | PASS: bounded query, correct empty result |
| Notes: last week | 3 | 2.741 | 26,832 | 19,456 | PASS: prior Monday-to-Monday window |
| Calendar: extend duration | 5 | 6.551 | 83,577 | 14,336 | PASS: start preserved, 15 → 45 minutes, description exact |
| Calendar: day agenda before repair | 3 | 2.843 | 26,143 | 12,288 | FAIL: planner queried the preceding day |
| Calendar: day agenda after repair | 3 | 4.481 | 26,612 | 12,288 | PASS: date argument, correct saved event |
| Calendar: past and future weeks | 4 | 3.994 | 34,273 | 20,480 | Read dates/counts PASS; weekday wording failed, label fix tested and final date/topic read correct |
| Note → event after storage repair | 6 | 6.738 | 63,541 | 17,408 | Saved fields/source-note PASS; stale failure claim repaired, evaluator replay and final readback passed |

### Final conditional-booking check

The first routing call selected only CALENDAR_CREATE_EVENT and one conditional
create intent. The planner called create directly; the action checked fresh
availability internally and persisted exactly one 15-minute local event with
no guests. No separate availability action or context restore occurred.

| Stage | Model seconds | Inputs | Cached inputs |
|---|---:|---:|---:|
| Route | 1.311 | 11,288 | 5,120 |
| Plan create | 0.654 | 10,158 | 3,072 |
| Validate scheduling fields | 0.367 | 1,885 | 1,024 |
| Final answer | 0.553 | 7,782 | 1,024 |

Total: **4 calls / 4.046 seconds / 31,113 inputs / 10,240 cache reads**.
The semantic stages were message handling 1.455s, tool discovery 0.004s,
planning 0.747s, tool execution 0.476s (including its 0.367s extraction),
and evaluation 0.643s. About 0.721s lay before/between/after these stages.
These are distinct from raw model timers and must not be added to them.
The changed routing path is demonstrated, but this is not a matched latency
benchmark against the earlier, more complex note-copy request.

The final topic/date read correctly returned all three fixtures, their exact
descriptions and Sunday September 20. It took 5 calls / 4.544s because the
planner first sent an empty search request. The subsequent schema fix makes
query required on the native tool. The final replay returned all three records correctly without empty-query recovery: **4 calls / 4.149 seconds / 33,033 inputs / 9,216 cache reads**. Its fourth call performed semantic matching of “Shaw QA” against the event titles; it was not a planner recovery.

## Why three stages can become more calls

- Direct chat/navigation can finish in routing: one call, no planner.
- A read usually routes, plans a tool read, then generates the final reply: three calls.
- Calendar writes also extract/validate scheduling fields inside the action.
  This protects missing times, timezone interpretation and requested changes.
  Fresh availability is a service check, not inherently another model call.
- Restoring deferred history/providers adds another planner call. Restored
  originals remain in later inputs, so the cost can persist across calls.
- Two queued reads currently run an evaluator between them. The weekly read
  used route → plan → advance queued read → final reply: four calls.
- Separate availability and creation, context restoration, or replanning add
  rounds. No successful action is made faster by pretending those rounds did
  not happen.

### Last-week Notes: three calls

| Stage | Model seconds | Inputs | Cached inputs |
|---|---:|---:|---:|
| Route/select context | 1.296 | 10,704 | 8,192 |
| Plan filtered Notes read | 0.409 | 8,790 | 6,144 |
| Final answer | 0.381 | 7,338 | 5,120 |

### Duration edit: five calls

The extra history restore sought an event ID/time even though the mutation
can resolve a unique title and reads the current event itself. Duplicate
identical update calls were deduplicated: one persisted update extended the
fixture by 30 minutes, not twice.

| Stage | Model seconds | Inputs | Cached inputs |
|---|---:|---:|---:|
| Route | 1.274 | 10,499 | 8,192 |
| Planner requests history | 0.783 | 10,674 | 0 |
| Planner chooses update | 1.326 | 30,991 | 4,096 |
| Calendar field extraction | 0.309 | 2,360 | 0 |
| Final answer | 1.311 | 29,053 | 2,048 |

## Kept changes and boundaries

- Notes scenario assertions now verify saved records, not obsolete response prose.
- Context restoration offers only scopes still deferred; invalid repeats still fail before effects.
- Notes reads have explicit creation/update date filters, with matching routing guidance.
- Calendar preserves supplied descriptions while scheduling extraction remains authoritative for time.
- One-day Calendar reads accept a date/timezone; code derives DST-correct boundaries.
- Agenda evidence names the actual read window and computed weekdays.
- Evaluator field checks use current records; the punctuation-specific failure example was removed.
- No new generic provider, phrase shortcut, arbitrary context limit, model switch,
  second store, or blanket rollback to August was introduced.

## Remaining performance work

Multi-step Calendar requests are not consistently under three seconds.
Unnecessary context restores and separate pre-check plans still occur despite
correct action capabilities. Removing context recovery outright would lose
constraints/corrections. Safely batching independent reads needs explicit
read/effect/dependency contracts; do not skip evaluation across arbitrary
mutations. These are separate measured optimization candidates, not solved
by the current correctness patches or by an acknowledgment bubble.

The proposed acknowledgment should be a separate progress event from an
already-required model response, never a terminal REPLY or another model call.
Its UI/voice implementation is not shipped here.

## Saved state and release boundary

All three temporary Calendar events were deleted through versioned owner API
mutations after comparing their IDs, fields and versions with the saved test
snapshot. The originally empty test day is empty again. Every one of the 41
original Notes records equals its pre-test snapshot. Chat test messages and
normal audit receipts remain in the continuous conversation.

Voice, external calendar-provider acceptance, acknowledgments UI, broad PRD
features, develop integration and release/deployment are not accepted here.


## Follow-up latency attribution (saved trace, no paid sweep)

The `shaw-conditional-booking-final` 4.046-second turn has two provider-composition phases. These are measured local work, not evidence of a fixed sleep or network delay:

- Before routing: provider calls span +69 to +274 ms from turn start. The slowest overlapping providers are firstRun (205 ms) and relevant-conversations (204 ms). Routing begins at +301 ms. Provider durations overlap and must not be added together.
- After routing ends at +1,756 ms: provider calls span +1,804 to +1,997 ms, with lifeops taking 193 ms and newly selected calendarSources 58 ms. Tool search begins at +2,058 ms. Existing context providers mostly report zero-time cache hits; this is not a full second fetch of all history.
- The lifeops provider already runs independent reads concurrently and caches per turn. Its overview refresh has a real dependency before completed-occurrence reads. No provider was removed, no history was clipped, and no cross-turn cache was introduced on this evidence.
- Routing requested thinking=on / reasoningEffort=low; planner and completion requested off / none; scheduling extraction used none. Source enables initial routing reasoning when original-history sources are visible. This is an intentional context-reconciliation policy, not accidental reasoning on every call. Saved provider options plus 77 passing wire/shape tests establish configured serialization, not packet capture or a measured counterfactual speed benefit from turning it off.
- Search's extra model call is semantic grounding when lexical evidence is weak (such as separated query terms across a title). Keep this correctness step; the sample alone does not justify replacing semantic matching with a term shortcut.

A separate concrete defect was reproduced locally: a grounded empty search could invoke semantic grounding twice with the same candidates. The regression failed with two model calls where one was required. The handler now uses the unranked-feed fallback only when ranked grounding has not already run. Explicit empty results remain final; unmatched feeds still get one semantic lookup. Calendar owning tests: 1,000 passed, four existing skips. This isolated call-count proof does not claim a new browser latency number or explain the earlier successful search's four calls.


### Bounded browser no-match replay

`shaw-search-empty-final`: “Find any local calendar events about QA astronomy from September 18 through September 20, 2026, in America/New_York. Only read; do not create or change anything.” Correct final no-match answer; one semantic-grounding call (226 ms), no mutation receipts, same three original Calendar records present afterwards. The duplicate grounding defect is fixed in the real runtime.

Whole turn: **7 calls, 6.294 seconds, 49,081 input tokens, 21,504 cache-read inputs**. This is a performance failure, not a clean four-call search pass. First planner supplied both `details.date` and `timeMin/timeMax`, correctly rejected as CALENDAR_READ_DATE_CONFLICT. The evaluator continued, the replanner supplied a valid range, grounding returned no matches, and reply recovery added another call. Next investigation: express exclusive day-versus-range choice at the native schema boundary and classify safe pre-read argument errors consistently, without silently discarding conflicting arguments or weakening write guards. This remaining issue is OPEN.

Timing caveat: the bounded no-match browser run overlapped repository verification/build/typecheck work on this Mac. Its total duration is not an idle-machine benchmark; the seven observed model calls and invalid-argument recovery are independently recorded in the trajectory.


## Read-window recovery and coverage repair

The proposed exclusive day/range native schema was tested and then **removed**, not shipped. Its bare union passed local validation but the live model emitted JSON-string details and failed before reading. Adding an explicit object declaration repaired the shape in a saved-input replay; the subsequent browser run still read only one day and claimed the whole requested range. That run is a failed coverage check, despite its plausible final answer. The larger schema added thousands of characters without proving reliable scope selection, so the original read schema remains.

The independently verified recovery fix stays: invalid/conflicting local dates fail before any read, retain their failed receipts and evaluation, and carry the existing coaching marker so a corrected successful read can finish without another failure-synthesis call. Real outages and access errors remain authoritative; write errors were not reclassified. Failing-before integration tests reproduce both erroneous final failure replies. Calendar suite: 1,002 passed, four existing skips.

The completion prompt now explicitly compares requested read ranges/filters/sources with returned scope/coverage. It must continue when a partial read cannot establish the requested complete or empty result. This is part of the existing evaluator, not a new model stage. A saved-input replay of the false-completion case changed FINISH to CONTINUE (662 ms, 7,300 inputs, no actions), with reasoning off. This replay proves that one case only; it is not universal scope-selection acceptance. Final browser evidence follows below.

## Scoped requirement evidence audit

These rows distinguish source/store coverage from natural-language browser evidence. Earlier traces are reused only for paths unchanged by the final read-schema/recovery patch. Full original dialogue remains available; no new context limit or model switch was introduced.

| Requirement | Evidence checked | Disposition |
|---|---|---|
| Greeting, Notes/Home navigation | acceptance-greeting; ganttnubs-notes-navigation; ganttnubs-home trajectories: one call; correct view receipts | Covered; no planner added to navigation |
| Notes create/list/topic lookup/patch/read/delete | Real-store Notes CRUD scenario matrix and 191 owning tests; final-browser-note-create-1928; evaluator-reply-field-note-edit; ganttnubs-note-recall | Covered; exact stored text and record identity checked; keyless CRUD is not language-routing proof |
| Notes date searches | Explicit-date and last-week browser traces; bounded date-filter/store/DST tests | Covered for requested windows; not a guarantee of every generated explanatory sentence |
| Calendar create and missing-time follow-up | ganttnubs-create-clarification, ganttnubs-calendar-create; conditional-booking trace and persisted record | Covered; no invented clock time permitted |
| Calendar update/move/duration/delete | source-followup-move/restore; shaw-duration-edit; ganttnubs-calendar-delete; real database regression tests | Covered; saved start/duration/description and unchanged records checked |
| Conflict, alternatives, delegated choice | Earlier conflict fixture/read receipts; ganttnubs-calendar-conflict-fixed; ganttnubs-calendar-delegated; current write-availability tests | Covered locally; alternatives do not authorize writes; external calendar/guest acceptance separate |
| Calendar day/week/history/topic reads | Agenda, two-week and topic/date traces; date-boundary/weekday tests; read-coverage evaluator replay | Covered with recorded wording failures and fixes; final whole-date browser replay passed below |
| Note-to-event transfer | Missing-day clarification, saved exact description, source-note comparison, evaluator replay and final live readback | Covered with separate storage/reply evidence; not a universal language guarantee |
| Context/follow-ups/preferences | Earlier source-follow-up/duplicate-target/personal-preference evidence and core context tests; current restored-scope contract | Retained; original constraints/history and write authority not weakened |
| Model calls/inputs/cache/local overhead | Recorded per-call tables and provider spans; shape/wire tests | Audited; three stages can contain more than three calls; provider timing does not isolate Wi-Fi |
| Remove proven redundant work | Empty-query schema, repeated restore schema, direct conditional-create routing, duplicate semantic search, invalid read recovery | Implemented with local regressions and bounded live validation; keep valid extraction, semantic grounding and original-context recovery |
| Acknowledgment review | Current reply ownership/streaming tests and plan design review | Reviewed last; implementation is separate, no new provider or extra model call added |
| Rollback, gates, data and handoff | Small commits/tags; owning/root logs; fixture cleanup and original-note equality; plan/demo/ledger | Final source/root/browser/data check passed below |

Performance remains measured rather than promised: reads and writes above three seconds are disclosed. Speculative batching across arbitrary tools and disabling history reconciliation are not accepted optimizations. Voice, broader browser/attachment features, reminder/alarm PRD work, develop integration, release and external communications remain separate as requested.


### Coverage replay and civil-date range follow-up

After removing the schema union and retaining the recovery/coverage changes, `shaw-read-coverage-final` used 4 calls / 3.395 seconds / 28,718 inputs / 13,312 cache reads. Route 974 ms (9,550 inputs), plan 499 ms (8,567), semantic matching 268 ms (3,144), completion 507 ms (7,457). There was one successful search and no retry, but the exclusive timestamp end was 23:59:59 rather than next midnight. The result happened to be empty in the actual full window too; this does not make its incomplete boundary correct.

The final implementation adds optional inclusive `endDate` beside the existing first `date`, for whole-day reads only. Calendar computes the exclusive next-midnight bound using the existing timezone/DST helpers. Partial-day timestamp ranges keep their existing exact semantics; no input is silently rounded. Tests reproduce the missing-end-date behavior before the fix and cover regular ranges, both DST changes, reversed/invalid bounds and endDate without date. Native read hints and host metadata describe the same contract. This is a small read-argument addition, not a provider, classifier, new model stage or permissive JSON-string parser.


## Final acceptance: d502d12aad7

`shaw-civil-range-final` used the same natural-language search request and actually called `CALENDAR_SEARCH_EVENTS` with date=2026-09-18, endDate=2026-09-20 and America/New_York. The returned complete feed covered **2026-09-18T04:00:00Z through 2026-09-21T04:00:00Z**, exactly all three requested local dates. One semantic lookup returned no matches; the visible final reply was correct and the composer returned to idle. No schema error, context restore, retry, or extra reply call occurred.

| Stage | Model ms | Input tokens | Cache-read inputs |
|---|---:|---:|---:|
| Routing | 1,230 | 9,466 | 7,168 |
| Planner | 690 | 8,547 | 0 |
| Semantic event matching | 322 | 3,095 | 0 |
| Completion/reply | 681 | 7,289 | 3,072 |

Whole turn: **4 calls / 4.080 seconds / 28,397 inputs / 10,240 cache reads**. No repository checks overlapped this run. This closes the demonstrated range/recovery defects; it does not meet a universal three-second target. Earlier 6.294-second recovery and intervening failed experiments remain recorded, not relabeled as passes.

The final source passed Calendar 1,008 tests (four existing skips), host Calendar schema 20 tests, core completion/pending/failure 415 tests, and root verification 373/373 tasks plus audits. Earlier unchanged Notes and full Personal Assistant evidence remains labeled above. Final-state comparison against the before snapshot proves all 41 notes and the three existing events in the read window unchanged. No test fixtures were added in this follow-up. API/database healthy, deferred startup complete, no failed plugins/services. Runtime loaded the exact final source before this browser check.

Scoped implementation, scenario reconciliation, context/call/cache audit, acknowledgment design review and verified handoff are complete. Performance beyond these measured runs remains unguaranteed: multi-step Calendar often exceeds three seconds, original-context recovery and semantic matching can add calls, and ambiguous language/generated explanatory prose can still need correction. These are disclosed limits, not universal product acceptance. No further broad paid sweep is justified by this evidence. Voice, broad PRD features, external provider acceptance and develop integration stay separate.


## Text acknowledgment follow-up — September 18

Acknowledgments reuse the initial routing call's model-authored pending-work text.
They travel as a transient chat status label before planner preparation, never as
a persisted answer or completion verdict. The label remains stable through tool
phases and disappears when the independently generated final answer settles.
No character/provider prompt, extra inference stage or phrase-specific router
was added. Direct navigation remains receipt-gated and skips this acknowledgment.

The first live read exposed a second status deduplication boundary which ignored
label changes within the same phase. The conversation SSE route now includes the
label in that comparison; its route-level regression test verifies the actual
status frame precedes reply tokens and only one final reply is persisted.
Cancellation now checks the signal before progress and additional planning.

| Live text scenario | Acknowledgment emitted | Final reply visible | Calls | Input / cached input |
|---|---:|---:|---:|---:|
| Calendar read, before transport correction | 1.734 s, dropped downstream | 3.438 s | 3 | 25,054 / 8,192 |
| Calendar read, corrected transport | 1.441 s, visibly confirmed | 9.179 s | 7 | 122,710 / 24,576 |
| Notes creation-date read | 1.146 s, visibly confirmed | 2.631 s | 3 | 26,122 / 10,240 |
| Open Notes | Omitted, as intended | 1.335 s | 1 | 9,625 / 7,168 |

Timings are server request marks, not screenshot observation times. Whole-request
finalization was 9.186 s, 2.638 s and 1.341 s in the final three checks. Cached
inputs are part of input tokens. These are individual observations, not latency
percentiles or guarantees. No acknowledgment-only model call appears.

The slow Calendar run selected CALENDAR_SEARCH_EVENTS with the invalid generic
query `event`, then described the full Calendar family before loading CALENDAR_FEED.
The base context stayed unchanged; no RESTORE_CONTEXT call occurred.
It reached the correct empty-day result without writes, but did not meet the
three-second target. Acknowledgments improve early feedback; this selection and
recovery variability remains an actual completion-latency limitation.

Browser inspection showed the generated progress label while work was pending,
then one final answer; navigation displayed the actual Notes view. Complete
before/after record comparisons found all 41 notes and the three original events
in the September 18–20 audit window unchanged. Continuous chat/history was not
reset. Voice was not exercised or enabled.

Deterministic checks: 403 Stage-1 tests; 100 planner/delivery/audience tests;
42 host usage/status tests; 82 conversation SSE contract tests. These cover
progress/final separation, no extra call, success/failure delivery, claim
suppression, greetings/clarifications, cancellation, deduplication and terminal
persistence. Final repository verification passed 373/373 tasks and final audits
(ack-accepted-verify.log). The initially narrow SSE test fixture type was corrected
to use the canonical message-service contract before this passing gate.
Private evidence remains outside Git: ack-calendar-initial, ack-calendar-final,
ack-notes-final, ack-navigation-final traces, acknowledgment timing snapshots,
and latency-audit/ack-preservation.json.


## Focused Calendar latency continuation — September 18

Starting checkpoint: `c76e22f5eb51db1c400974061c33530651377adf`, clean
`ganttnubs` in the existing isolated checkout. This section supersedes the
older attribution of the seven-call Calendar run to context restoration.

| Demonstrated cause | Focused correction or keep decision |
|---|---|
| Routing chose search for an unfiltered day and invented `query: "event"`. | Replace the existing candidate guidance with the explicit day/range lookup versus user-supplied content-filter distinction. No request-text router or additional classifier. |
| Preflight coaching named umbrella `feed` and timestamp bounds rather than the promoted operation and civil-date contract. | Name CALENDAR_FEED, preserve date/range/timezone, and identify its direct schema-load operation. Keep rejection, failed receipt, evaluator and permission admission. |
| `describe CALENDAR` returned 95,049 characters of complete family schemas; the next three calls retained them. | Avoid this unnecessary read when the required operation is known. Full descriptions remain available for actual schema questions; no returned result is removed or truncated. |
| Suspected full-history recovery caused the input spike. | Disproved: the earlier message prefix is exactly unchanged, with three new discovery messages appended. There are zero RESTORE_CONTEXT calls. Keep source selection and restoration unchanged. |

The saved failure used seven calls, 122,710 inputs and 24,576 cache reads.
Its model timers sum to 7,308 ms; request finalization was 9,186 ms. The
1,878 ms remainder is outside those model timers, not a measured Wi-Fi delay.
The original summary tool-event projection omits schema bodies; the actual
wire tool message establishes the 95,049-character result size.

Existing deterministic Calendar tests already reproduce rejection of `event`,
`events`, `calendar` and missing queries before reads/inference, and successful
repair without stale-failure delivery. These tests are reused rather than
adding assertions that merely repeat the new prose.

One bounded saved-input Cerebras replay changed only the error's coaching facts.
It chose `DISCOVER_TOOLS mode=load names=["CALENDAR_FEED"]` directly, omitting
family description. 710 ms request time, 8,970 input tokens, zero cached inputs.
No tool executed in that replay. This proves the selected recovery step, not an
end-to-end recovery latency or a universal routing guarantee.

### Fresh browser acceptance

Same continuous chat and database, same qwen-3.8-27b provider configuration.
The candidate API was restarted from the patched checkout before these checks.
No repository verification overlapped the measured turns. No write fixtures,
history resets, voice actions or additional paid sweeps were used.

| Scenario | Calls | Final reply mark | Request total | Trajectory total | Input / cached input | Outcome |
|---|---:|---:|---:|---:|---:|---|
| Sunday September 20 local agenda | 3 | 3.363 s | 3.370 s | 3.403 s | 24,410 / 0 | CALENDAR_FEED with exact date/timezone; correct empty day, no discovery/recovery |
| Notes created September 18 Pacific | 3 | 2.886 s | 2.903 s | 2.940 s | 25,214 / 10,240 | Exact createdAt local-day filter, zero matches among 41 notes |
| Open Notes | 1 | 1.435 s | 1.442 s | 1.482 s | 9,338 / 7,168 | Actual Notes view, one final reply, idle composer |

| Scenario / stage | Model ms | Input tokens | Cached inputs |
|---|---:|---:|---:|
| Calendar routing | 995 | 9,333 | 0 |
| Calendar plan/feed | 572 | 8,139 | 0 |
| Calendar completion | 549 | 6,938 | 0 |
| Notes routing | 1,117 | 9,349 | 7,168 |
| Notes plan/list | 591 | 8,643 | 0 |
| Notes completion | 464 | 7,222 | 3,072 |
| Navigation routing | 934 | 9,338 | 7,168 |

Calendar model time totals 2,116 ms; 1,254 ms of its 3,370 ms request lies
outside those timers. Semantic stages cover routing 1,281 ms, tool search 4 ms,
planning 665 ms, feed 73 ms and evaluation 630 ms (2,653 ms total); the remaining
717 ms is before/between/after stages. These stage envelopes overlap the model
timers and must not be added to them. Provider work overlaps internally.
No evidence justifies removing required provider or durable-history work.

Acknowledgment emission marks: Calendar 1,677 ms, Notes 1,495 ms; navigation
omits it. The bounded UI observations inspected the pending state and final
responses but did not capture those transient labels; earlier unchanged SSE
and visible-acknowledgment acceptance remains the display evidence. All final
answers and the idle composer were inspected in the browser. Full before/after
comparisons preserve all 41 notes and all three events in the Sep18–20 window.

The seven-call detour was absent in this run. Calendar is near the roughly
three-second target but still above three seconds; these are individual
observations, not percentiles or a controlled cache-matched speedup. Genuine
history recovery, semantic search and write extraction may still add calls.

Private evidence: continuation-cause-audit.json, continuation-recovery-replay*,
continuation-calendar-final, continuation-notes-final,
continuation-navigation-final, continuation-final-timing.json and
continuation-before/after-* under the existing candidate-runtime directory.
Final owning/repository verification is recorded with the saved checkpoint below.


Final gates: Calendar **1,008 passed / 4 existing skips**; core routing,
discovery, source binding, completion and pending-scope checks **738 passed**
(95 + 643). Root `bun run verify` passed **373/373 tasks** plus final audits,
exit zero. The first attempt rejected quote formatting; formatting was corrected
and an exact decoded-string comparison proved no runtime-text change from the
accepted browser/replay source. The final log is continuation-verify-final.log.
Changed-document file links and git diff whitespace checks passed.

Saved rollback tag: `codex/ganttnubs-calendar-latency-20260918` (local only).
The earlier acknowledgment tag remains intact. Code tags do not reset database
or continuous chat state. No push, PR, merge, deployment or voice acceptance.

## Original-task follow-up: Calendar contracts, September 18

This section supersedes earlier broad completion wording. The original task independently rehearsed ten browser requests at `484d1e9eec1`, then repaired the observed deletion selector failure. Work remains local on `ganttnubs`; peer `e59818bf174` has not been integrated, and voice/develop/deployment remain outside this acceptance.

### Changes and rejected experiment

- Promoted Calendar deletion now uses the explicit `targetKind`/`target` contract already used by updates. Query targets resolve current records. Contradictory selectors reject before any Calendar read or write; a bad ID is never silently dropped in favor of another record.
- Calendar create extraction/date correction and mutation fact verification use the message timestamp consistently for relative dates. The broad suite found processing-clock dependence that could shift a delayed Friday request by a week.
- Existing-event time proposals set `awaitingUserInput: true` while retaining successful preview receipts. Reading openings has not selected the new time or moved the event. This uses an existing result contract; the final evaluator, pending-scope enforcement and write guards remain. Generic availability reads and new-meeting slot observations are unchanged.
- A planner-scope wording experiment failed live and was removed. No planner-loop or planner-template change remains in this patch. The later first-stage candidate hint alignment is described below. The failure is evidence, not a performance pass.

### Intermediate browser results

The existing app on 5248 / API 31372 was restarted onto the candidate. Builds/tests were idle during measurements. These are individual trajectory times, not guaranteed percentiles; summed cache reads are included in summed input tokens.

| Request | Calls | Time | Input / cache read | Result |
|---|---:|---:|---:|---|
| Create temporary note and local event together | 4 | 4.889s | 37,826 / 7,168 | Exact note, correct event time/duration, no guests, current view preserved |
| Move that event to Saturday morning, before the result-contract fix | 7 | 6.146s | 80,034 / 40,960 | Correct options and no mutation; failed latency experiment |
| Cancel move and delete both fixtures | 3 | 3.528s | 36,761 / 9,216 | Correct query selector, both removed, all original records unchanged |

Creation's model calls: handler 1,376 ms / 9,646 inputs; planner 974 ms / 15,547; Calendar extraction 269 ms / 1,933; final evaluator 747 ms / 10,700. Deletion: handler 862 ms / 9,862; planner 913 ms / 15,944; evaluator 695 ms / 10,955. The failed proposal made one handler call, three planner calls and three evaluator calls for one successful domain preview. These totals do not count ordinary tool/database operations as model calls.

The first cleanup restored the exact original 41 Notes records and 3 Calendar records in the inspected September 18–20 window. A separate final proposal fixture was prepared through the local Calendar API to avoid paying for another setup-model turn. Final proposal acceptance and cleanup are pending below.

### Verification

- Full Calendar suite: 1,012 passed, 4 existing skips, including 22 real-PGlite cases.
- Promoted target schema: 22 passed; destructive-operation checks: 27 passed.
- Core planner/pending-scope checks: 398 passed during the experiment; core production changes were subsequently removed.
- Root verification on the final production changes: 373/373 tasks plus all audits passed.
- Personal Assistant full initial run: 2,783 passed, 6 existing skips. The new deferred-proposal test initially used a standalone-only renderer stub; corrected to invoke the real renderer for that path. Its complete real-PGlite file now passes 29 cases. The full follow-up run completed with 2,783 passes, six existing skips and that one harness failure; the corrected file then passed all 29 cases using the real deferred renderer. Together these cover all 2,784 cases on the final domain changes. The source typecheck also passed; the failed command remains in the evidence log.

### Integration boundary

Peer e59818bf174 shares base 16e4d711b3c but overlaps 20 changed paths. Its reported history/context work is useful, with an extra-call tradeoff for exact quotation. Keep this checkpoint isolated; assess source ownership, source recovery and planner/evaluator overlap in a separate integration checkout. No blanket August rollback and no tip-only cherry-pick is justified.

A fresh-title proposal replay then exposed stale first-stage candidate guidance: it selected SEARCH_EVENTS and incorrectly applied the destination date to the current-event search. That run took 4 calls/5.309s and did not reach PROPOSE_TIMES or change the fixture. The existing candidate hint is now aligned with the proposal tool's own event/duration lookup capability; final live acceptance is pending.


### Final boundary repairs and retained failures

Further live checks exposed real boundaries, rather than proving the first patch complete:
- 3 calls / 3.838s: direct proposal routing worked, but the reply converted the existing event to the wrong local clock. Proposal results now include code-formatted existing-event labels.
- 4 calls / 7.432s: a typed search borrowed the destination date from the entire message; a malformed Unicode-minus proposal timestamp silently broadened to seven days. Typed search now takes date bounds from its own arguments, and invalid supplied proposal bounds reject before reading.
- 3 calls / 4.145s: the current event displayed correctly, but the model supplied a valid UTC range representing the wrong local morning. Proposal arguments now request local ISO clocks plus IANA timezone; Calendar uses its existing timezone converter. Legacy offset-bearing inputs remain accepted. Invalid local dates and nonexistent DST clocks reject.
- 7 calls / 8.572s: local conversion worked, but proposal target matching reused the destination date in the surrounding request and missed the current event. Matching now scopes source constraints to existingEventQuery; ambiguity still pauses and eventual writes independently validate the target. This run also logged a transient Cerebras connection retry. It ended with a correct availability reply and no mutation, but is a failed latency/path acceptance.

These failures are retained in local owner-*-trace.json files. No planner-loop bypass, per-phrase response, provider switch, history truncation, or extra model call was added. Final acceptance is recorded below.

### Final browser acceptance, 22:38–22:40 PDT

| Request | Calls | Trajectory time | Input tokens | Cache-read tokens | Observed result |
|---|---:|---:|---:|---:|---|
| Recheck Saturday availability | 3 | 3.780s | 27,549 | 10,240 | Complete window read; no conflicts and no write |
| Move to morning without choosing a clock | 1 | 1.570s | 9,838 | 6,144 | Used preceding availability; asked for selection; no write or tool call |
| Fresh Monday proposal, preserve existing duration | 3 | 3.162s | 28,981 | 13,312 | Direct PROPOSE_TIMES; local clocks converted correctly; three verified 15-minute slots; awaiting selection; no mutation |
| Cancel QA request and delete temporary event | 3 | 3.413s | 29,746 | 10,240 | Direct DELETE_EVENT with query target; only fixture removed |
| Open Notes | 1 | 1.334s | 9,612 | 7,168 | Actual browser navigated to /notes, 41 notes visible |

Fresh proposal stages: handler 873ms / 9,921 inputs / 6,144 cache; planner 534ms / 8,342 / 4,096; final evaluator 642ms / 10,718 / 3,072. Cleanup: handler 1,205ms / 10,044 / 8,192; planner 649ms / 11,172 / 0; final evaluator 539ms / 8,530 / 2,048. Navigation: handler 749ms / 9,612 / 7,168. Remaining trajectory time is outside these model-call durations; these are not pure provider-inference or browser-wall percentiles. Cache reads are part of input totals, not additional inputs.

Persistence comparison after cleanup matched all 41 original Notes records and all 3 original Calendar records in the September 18–20 inspected window exactly. The final fixture is gone. Existing prior test records were preserved. No paid broad sweep followed these bounded checks.

Latest owning coverage: complete Calendar suite 1,014 passed / 4 existing skips; final Personal Assistant Calendar PGlite + native schema files 57 passed, including local/DST/date validation; core routing checks 457 passed. The earlier full Personal Assistant suite and corrected-file split coverage are described above; a later whole-suite command was not rerun after these scoped changes. Root verification on the final source is running; final result follows.

Verdict: scoped local text-path acceptance, not universal three-second latency, voice, external Calendar provider, release, deployment, or peer-merge acceptance. Legacy offset proposal inputs remain supported; arbitrary natural-language interpretation and provider latency are not made infallible by this patch.


Final-source root `bun run verify` exited zero: **373/373 tasks and all audits passed**, 5m0s for the task graph. The first final command stopped on formatting in one changed test; that test was formatted and the full command passed. Production source hashes still match the accepted browser run. Evidence: `candidate-runtime/latency-audit/owner-accepted-final-verify.log` (local external artifact directory).

Saved local rollback checkpoint: `codex/ganttnubs-calendar-contracts-20260918`. Working source is accepted for this bounded text repair pass. No push, peer/develop merge, deployment or voice acceptance. Remaining limits: variable model/provider latency, no universal under-three-second guarantee, and separately reviewed peer context/history integration. Code tags do not reset application data.
