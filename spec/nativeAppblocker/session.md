# Native app block session

## Story: Track an active app block session from start through unblock or expiry

> As the owner, I want each app block session to activate only with valid grants and selection, and to clear cleanly when unblocked or expired so that stale sessions never block apps.

### An app block session tracks active state, blocked count, expiry, and monotonic generation

Starting an app block (`startAppBlockSession`) requires the session to be inactive, granted, with at least one selected app (`selectedCount > 0`) and a non-negative `deadlineMs` (`0` for indefinite or strictly after `nowMs`), incrementing `generation` and recording `blockedCount` and `deadlineMs`. Unblocking (`stopAppBlockSession`) clears any active session, while expiring (`expireAppBlockSession`) clears an active timed session once `nowMs >= deadlineMs`; an inactive session always reports zero blocked apps and zero deadline.

```quint
type AppBlockSessionState = {
  active: bool,
  blockedCount: int,
  deadlineMs: int,
  generation: int,
}

pure val initial: AppBlockSessionState = {
  active: false,
  blockedCount: 0,
  deadlineMs: 0,
  generation: 0,
}

pure def canStartAppBlockSession(s: AppBlockSessionState, granted: bool, selectedCount: int, nowMs: int, deadlineMs: int): bool =
  not(s.active) and granted and selectedCount > 0 and nowMs >= 0 and (deadlineMs == 0 or deadlineMs > nowMs)

pure def startAppBlockSession(s: AppBlockSessionState, granted: bool, selectedCount: int, nowMs: int, deadlineMs: int): AppBlockSessionState = {
  active: true,
  blockedCount: selectedCount,
  deadlineMs: deadlineMs,
  generation: s.generation + 1,
}

pure def canStopAppBlockSession(s: AppBlockSessionState): bool = s.active

pure def stopAppBlockSession(s: AppBlockSessionState): AppBlockSessionState = {
  active: false,
  blockedCount: 0,
  deadlineMs: 0,
  generation: s.generation,
}

pure def canExpireAppBlockSession(s: AppBlockSessionState, nowMs: int): bool =
  s.active and s.deadlineMs > 0 and nowMs >= s.deadlineMs

pure def expireAppBlockSession(s: AppBlockSessionState, nowMs: int): AppBlockSessionState = {
  active: false,
  blockedCount: 0,
  deadlineMs: 0,
  generation: s.generation,
}

pure def alwaysInactiveSessionHasZeroBlocks(s: AppBlockSessionState): bool =
  not(s.active) implies (s.blockedCount == 0 and s.deadlineMs == 0)

pure def alwaysActiveSessionHasPositiveBlocks(s: AppBlockSessionState): bool =
  s.active implies s.blockedCount > 0

pure def alwaysAppBlockGenerationNonnegative(s: AppBlockSessionState): bool =
  s.generation >= 0

pure def stepAppBlockGenerationMonotonic(before: AppBlockSessionState, after: AppBlockSessionState): bool =
  after.generation >= before.generation

pure def lawUngrantedAppBlockSessionRefused(s: AppBlockSessionState, selectedCount: int, nowMs: int, deadlineMs: int): bool =
  not(canStartAppBlockSession(s, false, selectedCount, nowMs, deadlineMs))

pure def sometimesAppBlockSessionActive(s: AppBlockSessionState): bool = s.active
pure def sometimesAppBlockSessionExpired(s: AppBlockSessionState): bool = not(s.active) and s.generation >= 1

pure val selectedCountValues = Set(0, 1, 3)
pure val nowMsValues = Set(0, 1000, 5000)
pure val deadlineMsValues = Set(0, 1000, 5000)
```
