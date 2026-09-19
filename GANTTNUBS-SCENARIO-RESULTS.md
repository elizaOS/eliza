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
