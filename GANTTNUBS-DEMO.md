# Text demo: short handoff

Latest focused latency follow-up: Calendar now selected its day-feed directly
in the browser: **3 calls, 3.36 seconds to final reply**, down from the observed
seven-call 9.18-second detour. Notes was 2.89 seconds; Open Notes was 1.44 seconds.
These are individual runs, not a universal speed guarantee. The Calendar run
had no cached inputs. All 41 notes and three audit-window events are unchanged.
The recovery error now names the exact feed tool and correct date arguments;
full discovery, history recovery and all write safeguards remain available.
Verification: Calendar 1,008 tests, core 738 focused tests, root 373/373 tasks
and final audits passed. Local rollback tag:
`codex/ganttnubs-calendar-latency-20260918`. Nothing was pushed or deployed.

Baseline: `ganttnubs`, source `d502d12aad7`. Post-call fixes are committed;
bounded browser checks, fixture cleanup and final-source repository verification passed. The scoped text cleanup and audit are complete; the three-second target remains unmet for some flows.
This is not merged develop or a release certificate.

## Text acknowledgment checkpoint

Planned text tasks now show a model-written acknowledgment while work continues.
No extra model call is added; only the final answer is saved in the conversation.
Saved tag: `codex/ganttnubs-text-acknowledgments-20260918`. All 373 repository
tasks and 627 focused regression tests passed.
A live Notes check showed feedback at 1.15 seconds and its final answer at 2.63
seconds, with the usual three calls. Open Notes remained one call, 1.34 seconds.
A Calendar recovery took 9.18 seconds despite feedback at 1.44 seconds; actual
completion latency is not universally solved. Voice remains deferred.

## What is fixed

- Notes date searches now use a real creation/update-date filter; ordinary
  topic lookup, exact edits and stored-note preservation retain their checks.
- Repeated context restoration cannot request a scope already restored.
- Calendar keeps supplied descriptions while separately validating time.
- One-day agenda reads take a date/timezone; code computes the day boundaries.
- Calendar supplies actual date/weekday evidence, and the evaluator compares
  current saved fields instead of repeating an old failure.
- Calendar search requires a query and does not repeat a settled no-match lookup.
- Whole-date reads compute exact timezone/DST boundaries from date/endDate.
- Completion checks read coverage; corrected pre-read errors no longer force an extra failure reply.
- Conditional booking is routed to Calendar's existing conflict-safe create;
  its fresh availability check still runs before writing.

## What each request does

| Request | Model path |
|---|---|
| Greeting / open Notes / go Home | Usually routing only: one call |
| Notes read or change | Route → planner/tool → final answer |
| Calendar create/update | Same, plus scheduling-field extraction |
| Missing details | Ask before writing |
| Missing context | Restore original context, then resume |
| Several queued reads | May evaluate between reads before the final answer |

A service/tool check is not necessarily a model call. Three architectural
stages do not guarantee exactly three calls.

## Measured performance

| Scenario | Calls | Seconds | Status |
|---|---:|---:|---|
| Open Notes (earlier unchanged path) | 1 | 2.08 | Correct view |
| Go Home (earlier unchanged path) | 1 | 2.89 | Correct view |
| Notes last-week filter | 3 | 2.74 | Correct bounded read |
| Calendar day agenda after repair | 3 | 4.48 | Correct saved event |
| Duration extension | 5 | 6.55 | Correct write; unnecessary history restore |
| Conditional booking, final path | 4 | 4.05 | One create, built-in conflict check, correct saved event |
| Calendar topic/date search | 4 | 4.15 | Correct descriptions/weekday; one semantic matching call |
| Whole-date search, final source | 4 | 4.08 | Exact three-day coverage; no retries or extra reply call |

**Multi-step Calendar is still above the roughly three-second target.** These
are individual runs, not guarantees. Cache reads are included in input token
counts. The traces do not isolate airplane Wi-Fi delay.

[Scenario evidence and per-call inputs/cache/timing](GANTTNUBS-SCENARIO-RESULTS.md)
provides the detail. [The plan](GANTTNUBS-PLAN.md) lists remaining gates.

## Meeting alignment

This phase covers Notes/Calendar reads, writes, follow-ups, conflicts, duration,
note-to-event transfer and their model paths. Acknowledgments were reviewed:
use a separate progress event from an existing model response, not a terminal
REPLY or an extra model call. The later acknowledgment checkpoint above implements this text behavior.

Voice, broad browser/attachment work, reminders/alarms, messaging integrations,
full PRD work and combining with current develop remain deferred.

Final owning checks: Calendar 1,008 passed / 4 existing skips; host Calendar schema 20 passed; core completion/pending/failure 415 passed. Unchanged earlier evidence: Notes 191 passed;
Personal Assistant 2,781 passed / 6 existing skips; core planner/reply 238 passed; routing fields 50
passed and stage-one 399 passed. Final root verification passed 373/373 tasks.
All three temporary Calendar fixtures were removed; all 41 original notes are unchanged.
Rollback before this follow-up: `codex/ganttnubs-text-demo-20260918`.

Saved code checkpoint: local tag `codex/ganttnubs-shaw-text-20260918`.


The app is left running at http://127.0.0.1:5248/chat. All 41 notes and the three existing events in the latest read window are unchanged. Rollback tags preserve code, not a reset of conversation/database state. This is suitable for a text rehearsal with the measured latency limits above; it is not a claim that every scenario is perfect or under three seconds.


Acknowledgment rollback baseline: `codex/ganttnubs-text-acceptance-20260918`
(`e3bd1efaad3`). The acknowledgment follow-up has its own verification section in
GANTTNUBS-SCENARIO-RESULTS.md; the older counts and tags above describe prior phases.
