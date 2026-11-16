# Reviewed workflow schedule occurrences

The owner authors an automation's local time; the workflow package admits
each occurrence. An occurrence result is separate from [manual reviewed
admission](./admission.md); [execution](./execution.md) owns the wakeups.

## Story: An automation runs at its reviewed local time or records why it skipped

> As the owner, I want an automation to run at the local time and version I
> reviewed, and to record why when it does not run.

### A fresh occurrence uses the current reviewed version and exact cron instant

A wakeup includes the arm version and scheduled epoch milliseconds.
The server rejects a version mismatch or an instant more than one second
ahead. The cron engine must compute that instant from the reviewed trigger
and zone. A forward clock gap that moves the scheduler wakeup away from
the selected wall minute is recorded as missed. An occurrence more than
thirty minutes late is also missed. An earlier unfinished run prevents
starting another. A prior execution with the same workflow, version and
instant supplies the existing result without admission twice. [Hosted
digests](./hostedDigest.md) use the same miss window.

```quint
type OccurrenceFacts = { armVersion: int, definitionVersion: int, clockNow: int, scheduledAt: int, cronMatches: bool, wallMinuteMatches: bool, active: bool, pendingRun: bool, hasPrior: bool }
type OccurrenceDecision = WrongOccurrence | ExistingOccurrence | InactiveSchedule | NotReviewedInstant | MissedWallTime | MissedWindow | OverlappingRun | QueueOccurrence
pure val missedWindowMs: int = 1800000
pure val clockSkewMs: int = 1000
pure def missedOccurrence(scheduledAt: int, now: int): bool = now - scheduledAt > missedWindowMs
pure def decideOccurrence(facts: OccurrenceFacts): OccurrenceDecision =
  if (facts.armVersion != facts.definitionVersion or facts.scheduledAt > facts.clockNow + clockSkewMs) WrongOccurrence
  else if (facts.hasPrior) ExistingOccurrence
  else if (not(facts.active)) InactiveSchedule
  else if (not(facts.cronMatches)) NotReviewedInstant
  else if (not(facts.wallMinuteMatches)) MissedWallTime
  else if (missedOccurrence(facts.scheduledAt, facts.clockNow)) MissedWindow
  else if (facts.pendingRun) OverlappingRun
  else QueueOccurrence
pure val factsValues = Set(
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: true, pendingRun: false, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: false, active: true, pendingRun: false, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1801001, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: true, pendingRun: false, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: true, pendingRun: true, hasPrior: false },
  { armVersion: 1, definitionVersion: 1, clockNow: 1000, scheduledAt: 1000, cronMatches: true, wallMinuteMatches: true, active: false, pendingRun: true, hasPrior: true })
pure def lawQueueRequiresReviewedInstant(facts: OccurrenceFacts): bool = decideOccurrence(facts) == QueueOccurrence implies (facts.armVersion == facts.definitionVersion and facts.scheduledAt <= facts.clockNow + clockSkewMs and not(missedOccurrence(facts.scheduledAt, facts.clockNow)) and facts.cronMatches and facts.wallMinuteMatches and facts.active and not(facts.pendingRun) and not(facts.hasPrior))
pure def lawSameAdmittedOccurrenceNeverQueuesAgain(facts: OccurrenceFacts): bool = facts.hasPrior implies decideOccurrence(facts) != QueueOccurrence
pure def lawSkippedLocalTimeNeverRuns(facts: OccurrenceFacts): bool = not(facts.wallMinuteMatches) implies decideOccurrence(facts) != QueueOccurrence
```

### An inactive schedule never queues an occurrence

The off switch wins over a wakeup that was already armed: once the owner
deactivates the definition ([admission](./admission.md)), a late wakeup for
it records an inactive schedule and starts nothing.

```quint
pure def lawInactiveScheduleNeverQueues(facts: OccurrenceFacts): bool = not(facts.active) implies decideOccurrence(facts) != QueueOccurrence
```
