# Resident watchdog and restart policy

Alpha stages the pinned Eliza `ElizaAgentWatchdogPolicy.java` alongside
`ElizaAgentService.java` under
`packages/app/platforms/android/app/src/main/java/ai/elizaos/app`.
That policy supplies the crash budget and readiness decision for the
[resident lifecycle](./mobileResident.md). The producer distinguishes
a busy native process from an absent one and separates direct-child
exit, an authenticated protocol observation, and socket absence.
The model covers its policy decisions while platform timers and
process evidence arrive through authenticated host ports.

## Story: Recover a stalled agent without treating a slow call as process absence

### Independent health strikes and busy ticks trigger a bounded restart

A successful ready probe resets both counters. Busy preserves health
strikes and advances its own count. Dead preserves the busy count and
advances health strikes. Each threshold is three observations. A
terminal startup failure such as a prohibited destructive migration
or a PGlite manual-reset error enters stop instead of retry. These
operational decisions use the request and physical custody
rules in the resident owner.

```quint
type HealthProbe = ReadyProbe | BusyProbe | DeadProbe
type Watchdog = { healthStrikes: int, busyTicks: int, restartNeeded: bool }
pure val initial: Watchdog = { healthStrikes: 0, busyTicks: 0, restartNeeded: false }
pure def canRecordProbe(s: Watchdog): bool = not(s.restartNeeded)
pure def recordProbe(s: Watchdog, probeResult: HealthProbe): Watchdog =
  if (probeResult == ReadyProbe) initial
  else if (probeResult == BusyProbe) {
    if (s.busyTicks + 1 >= 3) { ...initial, restartNeeded: true }
    else { ...s, busyTicks: s.busyTicks + 1 }
  } else {
    if (s.healthStrikes + 1 >= 3) { ...initial, restartNeeded: true }
    else { ...s, healthStrikes: s.healthStrikes + 1 }
  }
pure def canRestartDispatched(s: Watchdog): bool = s.restartNeeded
pure def restartDispatched(s: Watchdog): Watchdog = initial
pure def alwaysStrikesBounded(s: Watchdog): bool =
  s.healthStrikes >= 0 and s.healthStrikes < 3 and s.busyTicks >= 0 and s.busyTicks < 3
pure def sometimesWatchdogRequestsRestart(s: Watchdog): bool = s.restartNeeded
```

### Budget reset and absence require separate qualified evidence

The pinned service permits five crash retries with backoff 1, 2, 4, 8
and 16 seconds. A healthy interval of at least 300 seconds resets
the budget. A healthy start followed by a short crash retains prior
attempts. A detached process is absent only after at least two
connection refusals and verification that its journaled child no
longer lives. A timeout or unready response confers no stop authority.

```quint
type RetryPermit = { allowed: bool, nextAttempts: int, delayMs: int }
pure def backoffMillis(attempts: int): int =
  if (attempts == 0) 1000 else if (attempts == 1) 2000 else if (attempts == 2) 4000 else if (attempts == 3) 8000 else 16000
pure def restartPermit(attempts: int, terminalFailure: bool): RetryPermit =
  if (terminalFailure or attempts < 0 or attempts >= 5) { allowed: false, nextAttempts: attempts, delayMs: 0 }
  else { allowed: true, nextAttempts: attempts + 1, delayMs: backoffMillis(attempts) }
pure def afterStableHealth(attempts: int, healthySince: int, observedAt: int): int =
  if (healthySince > 0 and observedAt - healthySince >= 300000) 0 else attempts
pure def confirmsDetachedAbsence(refusals: int, childJournaled: bool, childAlive: bool): bool =
  refusals >= 2 and childJournaled and not(childAlive)
pure val attemptsValues = Set(0, 1, 2, 3, 4, 5)
pure val healthySinceValues = Set(0, 1, 300000)
pure val observedAtValues = Set(0, 299999, 300000, 300001, 600001)
pure val refusalsValues = Set(0, 1, 2, 3)
pure def lawRestartPermitRespectsBudget(attempts: int, terminalFailure: bool): bool = {
  val permit = restartPermit(attempts, terminalFailure)
  permit.allowed implies attempts >= 0 and attempts < 5 and not(terminalFailure) and
    permit.nextAttempts == attempts + 1 and permit.delayMs >= 1000 and permit.delayMs <= 16000
}
pure def lawTransientHealthPreservesBudget(attempts: int, healthySince: int, observedAt: int): bool =
  healthySince <= 0 or observedAt - healthySince < 300000 implies afterStableHealth(attempts, healthySince, observedAt) == attempts
pure def lawAbsenceNeedsCurrentJournal(refusals: int, childJournaled: bool, childAlive: bool): bool =
  confirmsDetachedAbsence(refusals, childJournaled, childAlive) implies
    refusals >= 2 and childJournaled and not(childAlive)
```

### Only a qualified ready health body yields readiness

An empty or malformed body fails. A decoded body must report
`ready: true`. The optional runtime status must be absent or
`ok`; the optional agent state must be absent or `running`.
Socket connect success remains separate from this observation.

```quint
type ReadyBody = { parsed: bool, ready: bool, runtimeSupported: bool, agentStateSupported: bool }
pure def acceptsHealthBody(body: ReadyBody): bool =
  body.parsed and body.ready and body.runtimeSupported and body.agentStateSupported
pure val bodyValues = Set(
  {parsed: true, ready: true, runtimeSupported: true, agentStateSupported: true},
  {parsed: true, ready: false, runtimeSupported: true, agentStateSupported: true},
  {parsed: true, ready: true, runtimeSupported: false, agentStateSupported: true},
  {parsed: false, ready: false, runtimeSupported: false, agentStateSupported: false}
)
pure def lawReadinessNeedsQualifiedHealthBody(body: ReadyBody): bool =
  acceptsHealthBody(body) implies body.parsed and body.ready and body.runtimeSupported and body.agentStateSupported
```
