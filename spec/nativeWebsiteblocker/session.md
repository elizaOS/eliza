# Native website block session

## Story: Track an active website block session from install through removal or expiry

> As the owner, I want each website block session to activate only with valid permission and normalized domains, and to deactivate cleanly when stopped or expired so that stale sessions never block websites.

### A website block session tracks active state, domain count, expiry, and monotonic generation

Starting a website block (`startWebsiteSession`) requires the session to be inactive, granted, with at least one domain (`domainCount > 0`) and a non-negative `deadlineMs` (`0` for manual or strictly after `nowMs`), incrementing `generation` and recording `domainCount` and `deadlineMs`. Stopping (`stopWebsiteSession`) clears any active session, while expiring (`expireWebsiteSession`) clears an active timed session once `nowMs >= deadlineMs`; an inactive session always reports zero domains and zero deadline.

```quint
type WebsiteBlockSessionState = {
  active: bool,
  domainCount: int,
  deadlineMs: int,
  generation: int,
}

pure val initial: WebsiteBlockSessionState = {
  active: false,
  domainCount: 0,
  deadlineMs: 0,
  generation: 0,
}

pure def canStartWebsiteSession(s: WebsiteBlockSessionState, granted: bool, domainCount: int, nowMs: int, deadlineMs: int): bool =
  not(s.active) and granted and domainCount > 0 and nowMs >= 0 and (deadlineMs == 0 or deadlineMs > nowMs)

pure def startWebsiteSession(s: WebsiteBlockSessionState, granted: bool, domainCount: int, nowMs: int, deadlineMs: int): WebsiteBlockSessionState = {
  active: true,
  domainCount: domainCount,
  deadlineMs: deadlineMs,
  generation: s.generation + 1,
}

pure def canStopWebsiteSession(s: WebsiteBlockSessionState): bool = s.active

pure def stopWebsiteSession(s: WebsiteBlockSessionState): WebsiteBlockSessionState = {
  active: false,
  domainCount: 0,
  deadlineMs: 0,
  generation: s.generation,
}

pure def canExpireWebsiteSession(s: WebsiteBlockSessionState, nowMs: int): bool =
  s.active and s.deadlineMs > 0 and nowMs >= s.deadlineMs

pure def expireWebsiteSession(s: WebsiteBlockSessionState, nowMs: int): WebsiteBlockSessionState = {
  active: false,
  domainCount: 0,
  deadlineMs: 0,
  generation: s.generation,
}

pure def alwaysInactiveWebsiteSessionEmpty(s: WebsiteBlockSessionState): bool =
  not(s.active) implies (s.domainCount == 0 and s.deadlineMs == 0)

pure def alwaysActiveWebsiteSessionNonEmpty(s: WebsiteBlockSessionState): bool =
  s.active implies s.domainCount > 0

pure def alwaysWebsiteGenerationNonnegative(s: WebsiteBlockSessionState): bool =
  s.generation >= 0

pure def stepWebsiteGenerationMonotonic(before: WebsiteBlockSessionState, after: WebsiteBlockSessionState): bool =
  after.generation >= before.generation

pure def lawUngrantedWebsiteSessionRefused(s: WebsiteBlockSessionState, domainCount: int, nowMs: int, deadlineMs: int): bool =
  not(canStartWebsiteSession(s, false, domainCount, nowMs, deadlineMs))

pure def sometimesWebsiteSessionActive(s: WebsiteBlockSessionState): bool = s.active
pure def sometimesWebsiteSessionEnded(s: WebsiteBlockSessionState): bool = not(s.active) and s.generation >= 1

pure val domainCountValues = Set(0, 1, 4)
pure val nowMsValues = Set(0, 1000, 5000)
pure val deadlineMsValues = Set(0, 1000, 5000)
```
