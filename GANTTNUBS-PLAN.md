# ganttnubs: context, latency and scenario QA

Status: active follow-up to the saved local text cleanup. Owner: Nubs. Start: 2026-09-18.

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
| 1 | Pin branch, running source, app health and existing fixtures | Clean checkpoint, live health and saved fixture inventory | In progress |
| 2 | Explain every model round and input component in representative saved traces | Routing/planning/extraction/completion/recovery table; actual input/cache tokens and non-overlapping timings | Open |
| 3 | Identify avoidable context growth, unnecessary rounds and foreground overhead | Concrete source cause or an explicit no-change decision; local failing-before test for changes | Open |
| 4 | Fill meaningful scenario gaps and validate changed paths | Visible response/view plus stored outcome; no wrong target, duplicate effects or indefinite Thinking | Open |
| 5 | Run owning checks, final required repository gates and bounded rehearsal | Pinned source/runtime; separate correctness, performance and deferred status | Open |
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

Calendar restoration used routing 691 ms, planner 570 ms, field extraction 344 ms and completion 610 ms. The 1,047 ms outside those call timers is not yet fully attributed. First investigate measured spans before assigning it to the network or code. Cache-read tokens are included in input counts; they do not establish billing cost.

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
