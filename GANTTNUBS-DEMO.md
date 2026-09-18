# Text demo: short handoff

Candidate: `ganttnubs`. Current runtime repair: `21b137ececf`. Root verification passed; the final owning test suite is in progress; this is not merged develop or a release certificate.

## How it works

- Chat/navigation: usually one model call.
- Notes changes: route, plan/execute, final reply.
- Calendar writes: the same flow plus request-grounded field extraction and a fresh conflict check.
- Missing details: ask before writing. Missing context: retrieve it before proceeding.
- Final replies use actual action results. Extra recovery calls are conditional.

## Fresh observations

| Scenario | Calls | Seconds |
|---|---:|---:|
| Open Notes | 1 | 2.08 |
| Read current note | 1 | 1.47 |
| Ask for missing event time | 1 | 1.45 |
| Create after receiving time | 4 | 3.57 |
| Conflict plus checked alternative, repaired path | 4 | 6.85 |
| Explicit permission to choose a free time | 5 | 6.66 |

These are individual observations, not guarantees. Under three seconds is demonstrated for the direct cases, still open for multi-step work. The repaired conflict run overlapped local test/build activity.

## What changed in this follow-up

One Calendar tool description now retains its required search filter and distinguishes event search from availability. The replay used real availability checks, avoided the invalid search, and made no unwanted booking; one replay does not prove universal routing reliability. General system prompts, providers and storage behavior are unchanged.

## Demo scope

Show navigation, current note recall, a missing-time question, a calendar write and a conflict explanation. Prior saved evidence covers exact note create/edit and calendar move/restore. Temporary events from this rehearsal have been removed.

Voice, PRD, acknowledgments and combining with current develop are later work. See [the detailed plan](GANTTNUBS-PLAN.md) for evidence and remaining gates.
