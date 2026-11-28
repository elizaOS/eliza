# Vision description backpressure

## Story: Pause scene description cleanly under memory pressure, concurrency limits, or repeated failures

> As a host running continuous vision analysis, I want scene description requests paused automatically when memory is critical, when the model arbiter denies capacity, when the concurrency ceiling is reached, or after consecutive failures open the circuit breaker, so OCR and capture stay responsive.

### Scene description admits work only when memory, arbiter, concurrency, and circuit state permit

```quint
type MemoryPressure = PressureNormal | PressureElevated | PressureCritical
type PauseReason = NoPause | PauseCriticalMemory | PauseArbiterDenied | PauseCircuitOpen | PauseConcurrencyLimit

type BackpressureState = {
  pressure: MemoryPressure,
  arbiterAllowed: bool,
  inFlight: int,
  maxConcurrent: int,
  consecutiveFailures: int,
  failureThreshold: int,
  circuitOpen: bool
}

pure val initial: BackpressureState = {
  pressure: PressureNormal,
  arbiterAllowed: true,
  inFlight: 0,
  maxConcurrent: 2,
  consecutiveFailures: 0,
  failureThreshold: 3,
  circuitOpen: false
}

pure def pauseReason(s: BackpressureState): PauseReason =
  if (s.pressure == PressureCritical) PauseCriticalMemory
  else if (not(s.arbiterAllowed)) PauseArbiterDenied
  else if (s.circuitOpen) PauseCircuitOpen
  else if (s.inFlight >= s.maxConcurrent) PauseConcurrencyLimit
  else NoPause

pure def canSetPressure(s: BackpressureState, nextPressure: MemoryPressure): bool =
  nextPressure != s.pressure

pure def setPressure(s: BackpressureState, nextPressure: MemoryPressure): BackpressureState =
  { ...s, pressure: nextPressure }

pure def canSetArbiter(s: BackpressureState, allowed: bool): bool =
  allowed != s.arbiterAllowed

pure def setArbiter(s: BackpressureState, allowed: bool): BackpressureState =
  { ...s, arbiterAllowed: allowed }

pure def canAcquireDescribe(s: BackpressureState): bool =
  pauseReason(s) == NoPause

pure def acquireDescribe(s: BackpressureState): BackpressureState =
  { ...s, inFlight: s.inFlight + 1 }

pure def canFinishSuccess(s: BackpressureState): bool =
  s.inFlight > 0

pure def finishSuccess(s: BackpressureState): BackpressureState =
  { ...s, inFlight: s.inFlight - 1, consecutiveFailures: 0, circuitOpen: false }

pure def canFinishFailure(s: BackpressureState): bool =
  s.inFlight > 0

pure def finishFailure(s: BackpressureState): BackpressureState =
  val nextFailures = if (s.consecutiveFailures < s.failureThreshold) s.consecutiveFailures + 1 else s.failureThreshold
  { ...s, inFlight: s.inFlight - 1, consecutiveFailures: nextFailures, circuitOpen: nextFailures >= s.failureThreshold }

pure def canResetCircuit(s: BackpressureState): bool =
  s.circuitOpen

pure def resetCircuit(s: BackpressureState): BackpressureState =
  { ...s, consecutiveFailures: 0, circuitOpen: false }

pure def alwaysBackpressureBounds(s: BackpressureState): bool =
  s.maxConcurrent == 2 and s.failureThreshold == 3 and
  s.inFlight >= 0 and s.inFlight <= s.maxConcurrent and
  s.consecutiveFailures >= 0 and s.consecutiveFailures <= s.failureThreshold and
  (s.circuitOpen implies s.consecutiveFailures >= s.failureThreshold)

pure def alwaysCriticalMemoryBlocksDescribe(s: BackpressureState): bool =
  s.pressure == PressureCritical implies not(canAcquireDescribe(s))

pure def alwaysCircuitOpenBlocksDescribe(s: BackpressureState): bool =
  s.circuitOpen implies not(canAcquireDescribe(s))

pure def stepInFlightChangesByAtMostOne(before: BackpressureState, via: str, after: BackpressureState): bool =
  after.inFlight >= before.inFlight - 1 and after.inFlight <= before.inFlight + 1

pure def sometimesDescribeInFlight(s: BackpressureState): bool =
  s.inFlight == 2

pure def sometimesCircuitOpened(s: BackpressureState): bool =
  s.circuitOpen

pure def sometimesPausedByMemory(s: BackpressureState): bool =
  pauseReason(s) == PauseCriticalMemory

pure val eval_witness_sometimesCircuitOpened = (
  ("acquireDescribe"),
  ("finishFailure"),
  ("acquireDescribe"),
  ("finishFailure"),
  ("acquireDescribe"),
  ("finishFailure")
)
```
