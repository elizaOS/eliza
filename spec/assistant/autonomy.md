# Assistant autonomy and global pause

## Story: Run autonomous thinking cycles only when enabled, unpaused, and within error limits

> As the device owner, I want autonomous background thinking to run only when explicitly enabled, pause immediately whenever global pause is engaged or consecutive failures open the error breaker, keep the cycle interval within safe bounds, and track total completed cycles monotonically.

### Autonomy respects enablement, global pause, interval bounds, and error ceilings

An assistant starts with autonomy disabled, not running, not thinking, and unpaused at a `30000` ms interval (`[5000, 3600000]`) and error ceiling `maxErrors == 3`. Enabling autonomy sets `enabled` and `running`; disabling autonomy stops running and thinking immediately. Engaging `globalPaused` prevents `startThink` and forces `thinking == false`, reaching `maxErrors` consecutive failures blocks further `startThink` until reset by `enableAutonomy` or a successful cycle, and `totalCycles` never decreases across any transition.

```quint
type AutonomyState = {
  enabled: bool,
  running: bool,
  thinking: bool,
  globalPaused: bool,
  intervalMs: int,
  consecutiveErrors: int,
  maxErrors: int,
  totalCycles: int
}

pure val initial: AutonomyState = {
  enabled: false,
  running: false,
  thinking: false,
  globalPaused: false,
  intervalMs: 30000,
  consecutiveErrors: 0,
  maxErrors: 3,
  totalCycles: 0
}

pure def canEnableAutonomy(s: AutonomyState): bool =
  not(s.enabled) or s.consecutiveErrors >= s.maxErrors

pure def enableAutonomy(s: AutonomyState): AutonomyState =
  { ...s, enabled: true, running: not(s.globalPaused), consecutiveErrors: 0 }

pure def canDisableAutonomy(s: AutonomyState): bool =
  s.enabled or s.running or s.thinking

pure def disableAutonomy(s: AutonomyState): AutonomyState =
  { ...s, enabled: false, running: false, thinking: false }

pure def canSetGlobalPause(s: AutonomyState, paused: bool): bool =
  paused != s.globalPaused

pure def setGlobalPause(s: AutonomyState, paused: bool): AutonomyState =
  {
    ...s,
    globalPaused: paused,
    running: if (paused) false else s.enabled,
    thinking: if (paused) false else s.thinking
  }

pure def canSetIntervalMs(s: AutonomyState, nextMs: int): bool =
  nextMs >= 5000 and nextMs <= 3600000 and nextMs != s.intervalMs

pure def setIntervalMs(s: AutonomyState, nextMs: int): AutonomyState =
  { ...s, intervalMs: nextMs }

pure def canStartThink(s: AutonomyState): bool =
  s.enabled and s.running and not(s.globalPaused) and not(s.thinking) and s.consecutiveErrors < s.maxErrors

pure def startThink(s: AutonomyState): AutonomyState =
  { ...s, thinking: true }

pure def canFinishThinkSuccess(s: AutonomyState): bool =
  s.thinking

pure def finishThinkSuccess(s: AutonomyState): AutonomyState =
  { ...s, thinking: false, consecutiveErrors: 0, totalCycles: s.totalCycles + 1 }

pure def canFinishThinkFailure(s: AutonomyState): bool =
  s.thinking

pure def finishThinkFailure(s: AutonomyState): AutonomyState =
  val nextErrors = if (s.consecutiveErrors < s.maxErrors) s.consecutiveErrors + 1 else s.maxErrors
  { ...s, thinking: false, consecutiveErrors: nextErrors }

pure def alwaysAutonomySafety(s: AutonomyState): bool =
  s.maxErrors == 3 and
  s.intervalMs >= 5000 and s.intervalMs <= 3600000 and
  s.consecutiveErrors >= 0 and s.consecutiveErrors <= s.maxErrors and
  s.totalCycles >= 0 and
  (s.globalPaused implies not(s.running) and not(s.thinking)) and
  (not(s.enabled) implies not(s.running) and not(s.thinking)) and
  (s.thinking implies s.enabled and s.running and not(s.globalPaused) and s.consecutiveErrors < s.maxErrors)

pure def stepTotalCyclesNeverRewinds(before: AutonomyState, via: str, after: AutonomyState): bool =
  after.totalCycles >= before.totalCycles

pure val nextMsValues = Set(1000, 5000, 30000, 60000, 4000000)

pure def sometimesThinkCompleted(s: AutonomyState): bool =
  s.totalCycles >= 1 and s.enabled

pure def sometimesPausedByGlobalPause(s: AutonomyState): bool =
  s.enabled and s.globalPaused and not(s.running)

pure def sometimesErrorBreakerReached(s: AutonomyState): bool =
  s.consecutiveErrors == s.maxErrors and not(canStartThink(s))

pure val eval_witness_sometimesErrorBreakerReached = (
  ("enableAutonomy"),
  ("startThink"),
  ("finishThinkFailure"),
  ("startThink"),
  ("finishThinkFailure"),
  ("startThink"),
  ("finishThinkFailure")
)
```
