# Post-call Notes/Calendar scenario evidence

Source candidate: `5c1510bd654` on `ganttnubs`. These are individual local runs,
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
