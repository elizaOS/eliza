# ganttnubs: context, latency and scenario QA

Status: COMPLETE for the scoped Notes/Calendar text implementation, evidence audit and verified handoff at source `d502d12aad7`. The approximately-three-second performance target is NOT consistently met; current measured limits are disclosed, not certified away. Owner: Nubs. Updated: 2026-09-18.

The final acceptance at the end of GANTTNUBS-SCENARIO-RESULTS.md supersedes earlier checkpoint status notes below. No universal language, voice, external-provider, merge or release acceptance is claimed.

## Current finish checklist

The new call confirms Notes and Calendar correctness first, then acknowledgment design. This checklist extends the previous checkpoint rather than treating its selected examples as complete product acceptance. Private meeting transcripts and trajectories stay local.

- [x] Repair the Notes CRUD scenario to verify structured results and persisted content instead of obsolete response prose; run with no paid model calls. The real action/store round trip now passes create, topic lookup, field patch, readback and delete. Added the missing scenario-runner Notes development dependency. These direct-action checks do not prove language routing.
- [x] Audit Notes topic/date searches and exact edits. Typed creation/update bounds now filter in the store read, with exact boundary/DST/unchanged-store tests. Both explicit dates and “last week” used the filter in the browser; the latter took 3 calls / 2.741 seconds. Topic/patch behavior retains direct-action and earlier browser evidence.
- [x] Verify Calendar agenda/week/history/topic reads, duration editing and note-to-event behavior against stored records. Existing missing-time, move and conflict checks remain covered by the owning suite and earlier live receipts. A filtered search never proves availability. Final search returned all fixtures correctly; two known model-wording failures are recorded with their fixes and evidence.
- [x] Verify note-to-event transfer: missing date asked; saved description and source-note preservation verified. The repaired evaluator passed a saved-input replay and final live readback was exact. All 41 original notes remain unchanged; all three created Calendar fixtures were removed.
- [x] Capture bounded rehearsals and follow-up checks after demonstrated failures. Inspect visible replies and saved records, and record every routing/planning/domain-extraction/completion call plus input/cache/timing in GANTTNUBS-SCENARIO-RESULTS.md.
- [x] Identify demonstrated redundant calls or context. Keep safety extraction and full-context recovery unless an equivalent validated contract replaces them. Approximately three seconds remains a measured target, not a guarantee.
- [x] Review planner acknowledgment delivery last: avoid an extra model call, duplicate final replies, premature success, and extra planning on direct navigation.
- [x] Run owning checks and final-source repository verification (373/373), commit verified units and retain a code rollback checkpoint. The handoff separates this correctness pass from the still-active latency goal.

Voice, broad browser/attachments work, reminders/alarms, messaging integrations and develop consolidation remain separate. The call describes those future areas; they are not prerequisites for finishing this text cleanup.

### Evidence boundaries

Direct-action scenarios prove plugin/store behavior, not natural-language routing. Unit tests do not prove browser acceptance. Cached tokens are a subset of input tokens, not a measured bill. A successful replay does not by itself establish why a prior model choice failed. Network/provider delay and local overhead require separate measurements.

### Post-call findings

- Notes date read failed in the real app: routing selected NOTES_LIST, but the planner restored provider context twice instead. The second restore was invalid and triggered an error-reply call. Total: 4 model calls, 5.523 seconds, 74,700 input tokens; the error reply alone used 47,776 inputs. No Notes read or write executed.
- `548275ccf6a` makes the recovery schema offer only still-deferred scopes, including native tools, reply-only guidance and the local action grammar. A regression test failed for both scopes before the fix; all 455 focused context tests now pass. Invalid repeated requests still fail before effects.
- `f6e9bbb412e` gives NOTES_LIST its own read description and removes unrelated write instructions from its content parameter. Existing reads already return timestamps; no date parser, new provider, arbitrary note limit or storage change is needed to make those facts available. The initial 184 Notes tests passed. Subsequent date-filter/routing work brings this to 191; final live results are recorded below.
- `568cf6c41b3` advertises Calendar create's existing fresh conflict check and blocked-write result. This lets the planner use create directly for an authorized conditional booking. It does not skip field extraction, availability or approval checks. 103 focused Calendar checks pass; any call-count improvement still needs live evidence.
- `b10faf2caa2` fixes the real Notes scenario and its missing development dependency, plus a stale character-preset prose assertion. The CRUD scenario passes without model calls; the other scenario-runner unit files passed and the corrected preset file passed all 17 tests. Mock adapter suite: 19 passed.
- The first recovery-fix replay no longer aborted, but is NOT an acceptance pass: it still restored provider context before listing all notes, then the final reply changed the planner's September 7–13 interpretation to a trailing-seven-day window. Four calls, 5.497 seconds, 39,071 inputs. This exposed a missing bounded-date read contract rather than a reason to add more context restoration.
- `96d97dd5fd4` adds an explicit creation/update date filter to the existing Notes list action. Results preserve the applied inclusive/exclusive window and every matching complete record. Tests cover DST-offset boundaries, exact inclusion/exclusion, topic conjunction, creation versus update dates, invalid bounds, empty-window scope and unchanged persistence. All 191 Notes tests, owning type/lint checks and the 15-test provider check pass. Both live date replays now use the filter correctly. See the post-call scenario results; final-source verification passed 373/373 tasks.

### Latest post-call fixes and acceptance

- `3a272eb7cb8`: Calendar's scheduling extractor changed a supplied description. The create builder now preserves caller-supplied content while retaining authoritative timing extraction. A real-PGlite regression proves punctuation/newline/double-space preservation and timing override. Live creation now stores the exact note body and leaves the source note unchanged.
- `3b5c666fee0`: Notes date filters existed, but older routing guidance still recommended unfiltered recency reads. Aligning the existing hints produced actual filtered reads in both explicit-date and last-week browser checks. The latter was 3 calls, 2.741 seconds, 26,832 inputs, 19,456 cache reads.
- `7b21017daeb`: A day agenda requested September 19 for a September 20 question. Calendar now accepts a local date/timezone and computes day boundaries in code. Six new tests cover DST, invalid dates and conflicting bounds; the live replay queried the correct day and found the saved event.
- `daf6ab783a8`: Weekly queries used correct bounds but the reply named incorrect weekdays. Calendar now formats actual boundary dates and weekdays for reply evidence. The focused label regression and final live topic/date read pass; the final reply named Sunday September 20 correctly.
- `59aa7ef5589`: A new event was saved correctly but the evaluator repeated an earlier punctuation failure. Replaced a punctuation-specific example with a shorter current-record comparison rule. One saved-input model replay reported the correct stored description, without another write. This is not universal model acceptance.
- `0650a339e57`: The first routing model did not see create/update's built-in conflict-check capability, even after the planner description was fixed. Updated its existing candidate-action guidance so conditional writes need no separate availability candidate. Fifty field tests and 399 stage-one tests pass; the live conditional booking selected only create, preserved the fresh conflict check and made one correct event in 4 calls / 4.046 seconds.
- `5c1510bd654`: Calendar search accepted empty arguments at the native schema even though the handler required a content filter. The promoted search now requires canonical query text, while the legacy umbrella retains its aliases. Native-schema and local empty-input checks pass. The final replay had no empty-query repair; it used 4 calls / 4.149 seconds, including a semantic title-matching call. The full Personal Assistant suite passed 2,781 tests with six existing skips; types/lint passed.
- Calendar owning suite: 998 passed, 4 existing skips. Host Calendar boundary checks: 25 passed within the full Personal Assistant suite. Notes: 191 passed. Core planner/reply checks: 238 passed. Root verification passed 373/373 tasks on final source `5c1510bd654`. One prior attempt hit a compiler SIGSEGV with no source diagnostic and passed on retry.

[Post-call scenario/call-count ledger](GANTTNUBS-SCENARIO-RESULTS.md) records correctness separately from timing. Calendar's longer paths remain above the roughly three-second target. No voice, release, external-provider calendar or develop integration acceptance is claimed.

## Scope and sequence

Finish the existing context, response correctness, latency and scenario work before adding product features. PRD formalization and acknowledgment behavior are deferred until the last phase. A later develop integration is a separate reviewable phase, not part of the current demo checkpoint.

Start from `e3612278d4873bb3869be7d14abcce71075d2f37`, tagged `codex/calendar-followup-source-20260918`. The original `codex/core-latency-candidate-20260917` branch and checkpoint stay intact. This branch initially adds only this plan; it does not already contain current develop or later peer changes.

The previous local checklist passed its scoped text examples. This follow-up explicitly investigates remaining performance uncertainty and scenario gaps; do not retroactively describe every flow as fast or every possible request as correct.

## Working rules

- One writer. Keep commits small, explain each demonstrated defect and retain rollback tags.
- Saved trajectories and code first, local regression tests second, paid live calls only when necessary to validate a specific change or an uncovered acceptance case.
- No repeated broad prompt sweeps. A live failure should produce evidence and a local reproduction before another paid attempt.
- Retain full authorized history, current requests, standing constraints, pending work, privacy boundaries and effect receipts. No phrase-specific shortcuts or arbitrary prompt truncation.
- Preserve stored user data. Snapshot test targets, verify actual persisted effects and restore only fixtures changed by the run.
- No voice/microphone, model-provider changes, deployment, protected-branch updates or messages to others in this phase.
- Creating this GitHub branch does not approve a PR, merge, deployment or publication of private trajectories, meeting notes, local configuration, credentials or database snapshots.
- Target roughly three seconds for routine interactions; report observed times and recovery separately. Do not trade correctness for the target or certify normal-network performance from variable connectivity.

## Ordered work and gates

| Phase | Work | Exit evidence | Status |
|---|---|---|---|
| 1 | Pin branch, running source, app health and existing fixtures | Clean checkpoint, live health and saved fixture inventory | PASS: clean branch, ready API/UI, saved test-window baseline |
| 2 | Explain every model round and input component in representative saved traces | Routing/planning/extraction/completion/recovery table; actual input/cache tokens and non-overlapping timings | PASS for selected saved and fresh traces |
| 3 | Identify avoidable context growth, unnecessary rounds and foreground overhead | Concrete source cause or explicit keep decision; regression evidence appropriate to the changed contract | PASS for bounded audit: description repaired; other calls/checks retained with reasons |
| 4 | Fill meaningful scenario gaps and validate changed paths | Visible response/view plus stored outcome; no wrong target, duplicate effects or indefinite Thinking | PASS for selected rehearsal; not universal language coverage |
| 5 | Run owning checks, final required repository gates and bounded rehearsal | Pinned source/runtime; separate correctness, performance and deferred status | PASS for scoped text checkpoint; multi-step speed target OPEN |
| 6 | Formalize PRD and review acknowledgment behavior with the user | Agreed behavior/latency criteria; separate reviewed design before feature implementation | Deferred until last |
| Later | Compare candidate with current develop and prepare integration with Shaw | Pinned refs, semantic conflict map, isolated integration candidate and combined acceptance | Future phase; no merge now |

## Scenario matrix

Use valid existing evidence for unchanged behavior. Expand tests only for an actual coverage gap, source change or observed defect.

| Area | Cases | Observable pass condition |
|---|---|---|
| Direct interaction | Greeting, Home, Notes navigation | Correct reply/view; self-contained direct path has one model call without a redundant planner |
| Notes | Create, exact edit, recall; duplicate title; literal punctuation/whitespace; app instruction versus content | Correct record/body; ambiguity asks; unrelated records unchanged; normal correction remains available |
| Continuous context | Pronoun follow-up, original versus edited wording, standing preference, cancelled personal preference | Relevant context retained; current and historical facts distinguished; exact preference scope preserved |
| Calendar | Read, create, update, delete; missing clock; morning window; delegated choice; conflicts; duplicate title; source versus destination dates | Grounded timing/target; fresh availability; no unauthorized guess/write; one durable effect; explicit clarification or honest failure |
| Completion and recovery | Missing reply, model/provider failure, context restoration, duplicate tool call | One authoritative final outcome; no speculative success, lost pending work, repeated mutation or stuck Thinking |
| Inputs and speed | Direct, routine write and recovery paths | Per-stage input/cache/timing evidence; unexplained rounds investigated; network/provider and local work not conflated |

Creation/deletion combinations and broader recovery are not certified merely because the final Calendar move and restoration passed. Inspect existing coverage before selecting any new live case.

## Current measured baseline

These runs are different checkpoints/conditions, not a controlled benchmark or a guaranteed call budget.

| Scenario | Model calls | Whole turn | Input tokens | Cache-read inputs |
|---|---:|---:|---:|---:|
| Greeting, saved example | 1 | 2.311 s | 10,540 | 8,192 |
| Notes exact edit after reply fix | 3 | 17.315 s | 30,494 | 0 |
| Calendar follow-up before target fix | 9 | 14.975 s | 175,784 | 54,272 |
| Calendar follow-up after fix, with context recovery | 5 | 6.936 s | 78,115 | 11,264 |
| Calendar restoration without recovery | 4 | 3.262 s | 30,844 | 17,408 |

Calendar restoration used routing 691 ms, planner 570 ms, field extraction 344 ms and completion 610 ms. The 1,047 ms outside those call timers is partitioned below; source-level attribution remains open. Do not assign it all to the network or assume it is removable. Cache-read tokens are included in input counts; they do not establish billing cost.

Three architecture stages do not mean three model calls: a tool can invoke extraction, and context restoration or pending-work recovery can add rounds. Current Calendar extraction prevents demonstrated planner-time guesses; removing it requires an equivalent validated write contract, not merely one fewer call.

## Initial targeted investigations

1. Inspect the latest routine Calendar trace's non-model spans and the recovery run's full-context request. Identify missing observability versus demonstrated overhead.
2. Check why relevant-dialogue selection needed restoration in the follow-up; preserve legitimate uncertainty recovery. A single recovery request is not proof of a routing bug.
3. Audit scenario coverage for create/delete, delegated timing, duplicate targets and failure settlement. Select the smallest useful missing cases.
4. Check current app lifetime and startup evidence; distinguish a terminated development process from an application crash before changing code.
5. Publish concise evidence updates in this plan without committing private raw trajectories or personal data.

## Completion rules

Use PASS / FAIL / OPEN / DEFERRED with a stated consequence. Complete this phase only when identified actionable defects and unexplained avoidable rounds are resolved or supported by an explicit evidence-based keep decision; selected scenario gaps have adequate evidence; stable source passes required gates; and the user can explain the demonstrated paths.

Report text correctness, speed, voice, local versus merged/deployed status separately. Perfect interpretation of arbitrary language and a universally finished product are not measurable acceptance criteria.

## Later integration checklist

- Pin current develop and candidate commits at the time of integration; do not use stale remote-tracking refs.
- Compare final source trees and contracts, not just commit counts. Preserve both sides' useful behavior.
- Keep the runnable demo checkpoint intact; build an isolated integration branch/worktree.
- Resolve semantic overlaps in history/source binding, reply ownership, tool discovery, Calendar/Notes and preferences.
- Run combined owning tests and actual visible scenarios before recommending merge.
- Present the candidate and unresolved differences to the user; do not push to protected develop or contact Shaw automatically.

## First offline timing audit

Verified from the saved restoration trace without additional model calls. The following intervals are disjoint and total the recorded 3,262 ms turn:

| Interval | Duration |
|---|---:|
| Before response handler | 253 ms |
| Response handler, including 691 ms model call | 830 ms |
| Between handler and tool discovery | 298 ms |
| Tool discovery | 3 ms |
| Before planner | 8 ms |
| Planner, including 570 ms model call | 648 ms |
| Before tool | 2 ms |
| Calendar tool, including 344 ms extraction call | 442 ms |
| Before completion | 2 ms |
| Completion, including 610 ms model call | 687 ms |
| After completion | 89 ms |

The 1,047 ms outside model timers comprises 395 ms within stage envelopes and 652 ms between them. Provider preparation overlaps internally: its initial envelope is about 190 ms and its second envelope about 197 ms, already contained in the gaps above. Adding all provider durations would double-count concurrent work. Initial slow providers include first-run and relevant-conversation context; the second preparation is dominated by the lifeops provider. These observations identify where to inspect; they do not yet prove redundant work.

This run reports 17,408 cached input tokens out of 30,844 total inputs (56.4%). These are provider-reported cache reads, not local provider-cache hits, and do not by themselves establish a dollar saving. Model timer durations include the request/response boundary and cannot distinguish network from server inference without additional telemetry.

Decision: retain the tested runtime while inspecting these paths. No extraction removal, prompt clipping or speculative performance patch follows from this single trace.

## Time-boxed rehearsal and disposition

Current source repair: `21b137ececf` restores the content-filter and availability boundaries in the promoted Calendar search description. Its previous override omitted those distinctions. No global system-prompt change, new model call, provider switch, storage change, or new feature.

Fresh visible checks before this repair:

| Scenario | Calls | Whole turn | Input tokens | Cache-read inputs | Result |
|---|---:|---:|---:|---:|---|
| Open Notes | 1 | 2.082 s | 9,381 | 0 | Correct view and settled reply |
| Read current note exactly | 1 | 1.468 s | 9,608 | 7,168 | Correct current body, including double spaces |
| Create with missing clock time | 1 | 1.448 s | 9,486 | 6,144 | Asked; stored events unchanged |
| Supply the time | 4 | 3.570 s | 32,076 | 7,168 | Correct single event persisted |
| Conflicting create with alternative request | 5 | 5.203 s | 54,908 | 20,480 | No write; invalid search repaired, then reply overstated filtered-read coverage |
| Cancel request and delete temporary event | 4 | 5.428 s | 81,385 | 18,432 | Temporary event removed; test-window baseline restored |

After the description repair, one visible conflict replay used two successful CALENDAR_CHECK_AVAILABILITY calls: the original interval was blocked and the proposed alternative was independently checked. No invalid search or write occurred. Four model calls, 6.850 s, 54,218 inputs, 16,384 cache-read inputs. The replay selected availability tools upfront, so it does not isolate the description change as the cause or prove the search error cannot recur. This is correctness evidence, not a speed win: repository verification and package tests were running concurrently, and the trace also shows slower local context preparation. It does not isolate the cause of the timing difference.

The replay fixture was set up through the local API to avoid paying for another creation conversation, then removed by its exact event ID/version. Final stored events in the tested two-day window equal the saved baseline. The earlier create/delete acceptance itself used the actual chat UI. Private traces and fixture IDs stay outside the repository.

Targeted checks: Calendar 64 passed; core context/reply/failure contracts 95 passed; promoted Calendar schemas and real database receipts 47 passed. Broad owning and root gates passed; final receipts are below.

Context-recovery disposition: the older five-call move explicitly restored context after a prior failed target lookup. Retain that recovery. Removing it or skipping extraction to satisfy a call count would sacrifice an exercised correctness contract. The newest cancellation/deletion also took a recovery path; report it separately from routine deletion.

Provider-overhead disposition: independent LifeOps reads already run concurrently. First-run context performs owner-access and current setup-state checks. No safe redundant operation has been established by the timing samples, so retain those checks for this checkpoint. The three-second target remains OPEN for multi-step writes and recovery.

### Final coverage addition

Explicit delegated choice (choose any free start between 9 and 11) completed in 6.655 s with five model calls: routing, availability planning/read, create planning, request-grounded extraction, completion. The saved event was 9:00–9:15 in the requested timezone with no guests. The temporary record was removed by exact ID/version; the tested calendar window again matches its baseline. This complements the missing-clock no-write case; it does not certify every ambiguous scheduling phrase.

Root `bun run verify` exited zero on an isolated checkout with identical runtime source: 373/373 tasks, followed by all final audits. Calendar and core focused checks remain green. The personal-assistant suite exited zero: 309 files passed, 2,780 tests passed, six skipped. Documentation-only files differ between the runtime candidate and verifier; no source mismatch.

The model-request duration includes transport/provider work. Separate provider-context reads, tool execution and publication contribute to whole-turn duration. Cached input is a subset of total input, and these foreground trace totals are not an account-wide billing statement.

### Saved checkpoint and remaining work

Final Home navigation: one call, 2.889 s, 9,503 inputs and 7,168 cache-read inputs; correct Home view, final reply and idle composer inspected. API ready, database healthy, and local app left open. No more paid rehearsals were run after this check.

Validation: full personal-assistant 2,780 passed / six skipped; focused Calendar 64 passed; focused core 95 passed; host schema/database boundary 47 passed; root verify 373/373 tasks and final audits, exit zero. Guide parity, local document links and diff checks passed. Existing unchanged Notes create/edit, preference scope and Calendar move/restore evidence is reused, not presented as newly rerun.

The runtime code matches `21b137ececf`; later commits contain the plan and handoff. Local rollback tag: `codex/ganttnubs-text-demo-20260918`. The GitHub branch contains this candidate; develop has not been merged or modified.

OPEN: consistent sub-three-second multi-step writes, verified alternatives and context recovery. No additional safe shortcut was established within this checkpoint. The single prompt-routing repair and one replay do not guarantee perfect natural-language interpretation. These are explicit performance/reliability limits, not a hidden correctness PASS for every possible scenario.

DEFERRED: voice, PRD/acknowledgment design and isolated develop integration. The bounded goal is complete when this checkpoint and short handoff are delivered; broader product/release work remains separate.

## Post-call acknowledgment design review

Do not add a generic provider or require a terminal REPLY before every tool.
The current runtime treats the final reply as the authoritative outcome, and
its completion guard may synthesize a missing final answer after tools. A
“got it” REPLY can therefore end the plan, trigger recovery, or compete with
publication. Existing streaming suppression tests cover that distinction.

A future acknowledgment should be a separate progress event, authored in an
already-required routing/planning response, with no extra model call. It must
never claim a write succeeded, never replace the final response, and should
be omitted for direct navigation. Voice playback/caching remains a separate
acceptance task. This phase records the design and preserves current final
reply ownership; it does not ship the meeting's proposed acknowledgment UI.

## Performance audit disposition

The scoped audit is complete; consistent three-second Calendar performance is not established. The four follow-up investigations were resolved as follows:

1. Provider receipts attribute most routing gaps to concurrent initial context reads and newly selected Calendar context. Existing providers mostly hit the turn cache. No fixed sleep or safely removable provider was established.
2. Saved options and provider wire tests confirm low routing reasoning for original-history reconciliation and reasoning off for planning/extraction/completion. No model/provider policy was changed; aggregate timers do not identify Wi-Fi delay.
3. Duplicate semantic no-match grounding and invalid read recovery were reproduced and fixed. Valid semantic matching and original-context recovery remain; disabling them would weaken correctness. Whole-date reads now use code-derived date/endDate boundaries.
4. Arbitrary queued actions cannot be batched by skipping evaluation. That needs a separately validated effect/dependency contract; no speculative batching was shipped.

The final browser read uses four calls with correct full coverage and no recovery. Its 4.080 seconds exceeds the target, and more complex writes/recovery can take longer. The goal's measured-target requirement is reported honestly; it is not a promise that every request runs under three seconds.

Code rollback checkpoint for this pass: local tag
`codex/ganttnubs-shaw-text-20260918`. This preserves code, not a reset of the
continuous conversation or user database. The earlier pre-follow-up tag
`codex/ganttnubs-text-demo-20260918` also remains available.


### Follow-up audit disposition

Saved provider receipts account for most of the two roughly 300 ms routing gaps: concurrent initial context reads, then newly selected Calendar context. Most previously read providers already hit the turn cache. Preserve these reads pending a measured equivalent implementation; neither a fixed delay nor Wi-Fi is established as their cause. Routing uses low reasoning for original-history reconciliation while planner/extractor/completion use none. Seventy-seven existing provider shape/wire tests pass; no model policy was changed.

One proven redundant search path was fixed: an explicit no-match grounding result no longer triggers an identical grounding call. Both weak lexical matches and completely unmatched feeds have local regression coverage; the Calendar suite passes 1,000 tests with four existing skips. See the scenario ledger for attribution and evidence limits. Roughly-three-second performance remains a target, not an acceptance claim across multi-step Calendar workflows.


The single bounded browser follow-up confirms one semantic-grounding call and a correct no-match answer with no writes, but exposes an OPEN read-argument recovery issue: native planner supplied both date and a range, requiring rejection, replanning and reply recovery (7 calls / 6.294 s). Next work is the exclusive day/range schema and safe pre-read coaching classification; do not silently pick one conflicting scope. No broad paid sweep is needed.

Final gates for this duplicate-grounding patch: Calendar 1,000 passed / four existing skips; provider wire/shape 77 passed; repository verification 373/373 successful with final audits passing. The running local API loaded this source before the bounded browser check. No model settings or user records were changed.


### Read recovery and whole-date range follow-up

The proposed exclusive day/range schema was rejected after real-model checks: first JSON-string arguments, then a plausible reply after reading only one day. It was removed rather than retained as another compatibility path. The compact original object schema remains.

Kept changes: pre-read invalid/conflicting date errors retain their receipts and evaluation but no longer force failure synthesis after a correct retry; the existing evaluator explicitly checks read coverage; and whole-day ranges use date plus optional inclusive endDate, with code-derived next-midnight/DST boundaries. This avoids asking the planner to approximate a whole day with 23:59:59. No explicit timestamp is silently rounded and no mutation validation was removed. The original duplicate semantic-search fix remains saved at 97d0e360e2f.

Calendar tests: 1,008 passed, four existing skips. Core completion/pending/failure tests: 415 passed. Host Calendar schema contract: 20 passed. Final root and exact live date-range acceptance are the remaining gates for this patch. The full scoped evidence audit is in GANTTNUBS-SCENARIO-RESULTS.md; repeated historical checkpoint paragraphs above are evidence history, not current acceptance status.


### Final handoff

Source `d502d12aad7`: all required final gates and the exact full-date browser acceptance passed. The same read request now covers September 18–20 in America/New_York through September 21 midnight, with four model calls and no recovery. Final comparison proves all 41 notes and the three original events unchanged. The rejected schema-union experiment is absent from source. See GANTTNUBS-DEMO.md for the concise user handoff and GANTTNUBS-SCENARIO-RESULTS.md for the full requirement/evidence audit.
