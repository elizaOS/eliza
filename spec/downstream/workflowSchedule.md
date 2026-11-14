# Reviewed workflow schedule occurrences

AlphaPhone consumes local-time authoring from
`packages/contracts/src/phone-workflow.ts` and run projections from
`workflow-client.ts`. Upstream admission is in
`plugins/plugin-workflow/src/services/phone-workflow-spec.ts` and
`embedded-workflow-service.ts`. AlphaPhone's `WorkflowScheduleTasks.qnt` and `WorkflowWakeups.qnt`
provide scheduler and wakeup cases. Its `WorkflowClockAdmission.qnt`
separately models a Clock handoff from the Workflows screen. An occurrence result is separate from
[manual reviewed admission](./workflow.md).

## Story: An automation runs at its reviewed local time or records why it skipped

### A fresh occurrence uses the current reviewed version and exact cron instant

A wakeup includes the arm version and scheduled epoch milliseconds.
The server rejects a version mismatch or an instant more than one second
ahead. The cron engine must compute that instant from the reviewed trigger
and zone. A forward clock gap that moves the scheduler wakeup away from
the selected wall minute is recorded as missed. An occurrence more than
thirty minutes late is also missed. An earlier unfinished run prevents
starting another. A prior execution with the same workflow, version and
instant supplies the existing result without admission twice. In the real
store that lookup and insert are in the definition transaction. Hosted
Digests have separate trigger/input rules.

```quint
type OccurrenceFacts = { armVersion: int, definitionVersion: int, clockNow: int, scheduledAt: int, cronMatches: bool, wallMinuteMatches: bool, active: bool, pendingRun: bool, hasPrior: bool }
type OccurrenceDecision = WrongOccurrence | ExistingOccurrence | InactiveSchedule | NotReviewedInstant | MissedWallTime | MissedWindow | OverlappingRun | QueueOccurrence
pure def decideOccurrence(facts: OccurrenceFacts): OccurrenceDecision =
  if (facts.armVersion != facts.definitionVersion or facts.scheduledAt > facts.clockNow + 1000) WrongOccurrence
  else if (facts.hasPrior) ExistingOccurrence
  else if (not(facts.active)) InactiveSchedule
  else if (not(facts.cronMatches)) NotReviewedInstant
  else if (not(facts.wallMinuteMatches)) MissedWallTime
  else if (facts.clockNow - facts.scheduledAt > 1800000) MissedWindow
  else if (facts.pendingRun) OverlappingRun
  else QueueOccurrence
pure val factsValues = Set(
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: true, pendingRun: false, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: false, active: true, pendingRun: false, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1801001, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: true, pendingRun: false, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: true, pendingRun: true, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: false, pendingRun: true, hasPrior: true })
pure def lawQueueRequiresReviewedInstant(facts: OccurrenceFacts): bool = decideOccurrence(facts) == QueueOccurrence implies (facts.armVersion == facts.definitionVersion and facts.scheduledAt <= facts.clockNow + 1000 and facts.clockNow - facts.scheduledAt <= 1800000 and facts.cronMatches and facts.wallMinuteMatches and facts.active and not(facts.pendingRun) and not(facts.hasPrior))
pure def lawSameAdmittedOccurrenceNeverQueuesAgain(facts: OccurrenceFacts): bool = facts.hasPrior implies decideOccurrence(facts) != QueueOccurrence
pure def lawSkippedLocalTimeNeverRuns(facts: OccurrenceFacts): bool = not(facts.wallMinuteMatches) implies decideOccurrence(facts) != QueueOccurrence
```
