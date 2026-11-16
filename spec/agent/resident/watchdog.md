# Resident watchdog and restart policy

The watchdog supplies the crash budget and readiness decision for the
[resident lifecycle](./lifecycle.md). It tells a busy agent from an absent
one, and keeps a child's exit, an authenticated health answer and a closed
socket as separate evidence.

## Story: Recover a stalled agent without treating a slow call as process absence

> As a device owner, an agent that is merely busy is not restarted, while
> one that really stopped responding is restarted within a bounded budget.

### Independent health strikes and busy ticks trigger a bounded restart

A probe is ready only when its answer is a qualified ready health body; a
refused connection is a dead probe, and an answer that is slow, does not
decode or is not ready is a busy one. A ready probe resets both counters.
A busy probe advances only the busy count and a dead probe only the
health strikes; three of either asks for a restart.

```quint
type HealthProbe = ReadyProbe | BusyProbe | DeadProbe
type ReadyBody = { parsed: bool, ready: bool, runtimeSupported: bool, agentStateSupported: bool }
type ProbeReply = { refused: bool, body: ReadyBody }
type Watchdog = { healthStrikes: int, busyTicks: int, restartNeeded: bool, ready: bool, lastReply: ProbeReply }
pure val noReply: ProbeReply = { refused: false, body: { parsed: false, ready: false, runtimeSupported: false, agentStateSupported: false } }
pure val initial: Watchdog = { healthStrikes: 0, busyTicks: 0, restartNeeded: false, ready: false, lastReply: noReply }
pure def acceptsHealthBody(body: ReadyBody): bool =
  body.parsed and body.ready and body.runtimeSupported and body.agentStateSupported
pure def classifyProbe(reply: ProbeReply): HealthProbe =
  if (reply.refused) DeadProbe else if (acceptsHealthBody(reply.body)) ReadyProbe else BusyProbe
pure def canRecordProbe(s: Watchdog, reply: ProbeReply): bool = not(s.restartNeeded)
pure def recordProbe(s: Watchdog, reply: ProbeReply): Watchdog = {
  val probeResult = classifyProbe(reply)
  val counted = { ...s, ready: false, lastReply: reply }
  if (probeResult == ReadyProbe) { ...initial, ready: true, lastReply: reply }
  else if (probeResult == BusyProbe) {
    if (s.busyTicks + 1 >= 3) { ...initial, restartNeeded: true, lastReply: reply }
    else { ...counted, busyTicks: s.busyTicks + 1 }
  } else {
    if (s.healthStrikes + 1 >= 3) { ...initial, restartNeeded: true, lastReply: reply }
    else { ...counted, healthStrikes: s.healthStrikes + 1 }
  }
}
pure val replyValues = Set(
  { refused: false, body: { parsed: true, ready: true, runtimeSupported: true, agentStateSupported: true } },
  { refused: false, body: { parsed: true, ready: true, runtimeSupported: false, agentStateSupported: true } },
  { refused: false, body: { parsed: false, ready: false, runtimeSupported: false, agentStateSupported: false } },
  { refused: true, body: { parsed: false, ready: false, runtimeSupported: false, agentStateSupported: false } }
)
pure def canRestartDispatched(s: Watchdog): bool = s.restartNeeded
pure def restartDispatched(s: Watchdog): Watchdog = initial
pure def alwaysStrikesBounded(s: Watchdog): bool =
  s.healthStrikes >= 0 and s.healthStrikes < 3 and s.busyTicks >= 0 and s.busyTicks < 3
pure def sometimesWatchdogRequestsRestart(s: Watchdog): bool = s.restartNeeded
pure def sometimesBusyAnswerIsNotDeath(s: Watchdog): bool = s.busyTicks > 0 and s.healthStrikes == 0 and not(s.lastReply.refused)
```

### Budget reset and absence require separate qualified evidence

Five crash retries are allowed, with a backoff of one to sixteen seconds,
and a terminal startup failure is never retried. Only five minutes of
continuous health resets the budget; a short healthy spell keeps the
attempts counted. A detached process is absent only after at least two
refused connections and proof that its journaled child no longer lives; a
timeout or an unready answer is not absence, and the resident's stop is
confirmed only on that proof.

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
pure def lawRestartPermitRespectsBudget(attempts: int, terminalFailure: bool): bool = {
  val permit = restartPermit(attempts, terminalFailure)
  permit.allowed implies attempts >= 0 and attempts < 5 and not(terminalFailure) and
    permit.nextAttempts == attempts + 1 and permit.delayMs >= 1000 and permit.delayMs <= 16000
}
pure def lawTransientHealthPreservesBudget(attempts: int, healthySince: int, observedAt: int): bool =
  healthySince <= 0 or observedAt - healthySince < 300000 implies afterStableHealth(attempts, healthySince, observedAt) == attempts
```

### Only a qualified ready health body yields readiness

The body must decode and report ready, with a runtime status, if any, of
ok and an agent state, if any, of running. A successful connection alone
is not readiness.

```quint
pure def alwaysReadyFromQualifiedBody(s: Watchdog): bool =
  s.ready implies not(s.lastReply.refused) and acceptsHealthBody(s.lastReply.body)
pure def sometimesQualifiedReady(s: Watchdog): bool = s.ready
```
