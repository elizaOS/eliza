# Memory watchdog

A watchdog samples the host's memory and asks for a restart after
sustained high use; the request is latched until it settles, and once a
restart is accepted nothing asks again. The owner's event hooks are
[event hooks](./eventHooks.md).

## Story: Restart a host that keeps using too much memory

> As the owner, my agent restarts itself once when it keeps using too much
> memory, not on a single spike and not over and over.

### A restart is requested only after two consecutive high samples

```quint
type Restart = NoRestart | RestartPending | RestartAccepted
type Watchdog = { highSamples: int, restart: Restart, restartRequests: int }
pure val initial: Watchdog = { highSamples: 0, restart: NoRestart, restartRequests: 0 }
pure val sustainedSamples = 2
pure def canHighSample(h: Watchdog): bool = h.restart == NoRestart and h.highSamples < sustainedSamples
pure def highSample(h: Watchdog): Watchdog = { ...h, highSamples: h.highSamples + 1 }
pure def canLowSample(h: Watchdog): bool = h.restart == NoRestart
pure def lowSample(h: Watchdog): Watchdog = { ...h, highSamples: 0 }
pure def canRequestRestart(h: Watchdog): bool = h.restart == NoRestart and h.highSamples == sustainedSamples
pure def requestRestart(h: Watchdog): Watchdog = { ...h, restart: RestartPending, restartRequests: h.restartRequests + 1 }
pure def alwaysRestartFollowsSustainedUse(h: Watchdog): bool =
  h.highSamples >= 0 and h.highSamples <= sustainedSamples and (h.restart != NoRestart implies h.highSamples == sustainedSamples)
```

### A failed restart request re-arms only after it settles, and an accepted one is final

```quint
pure def canRestartFailed(h: Watchdog): bool = h.restart == RestartPending
pure def restartFailed(h: Watchdog): Watchdog = { ...h, restart: NoRestart }
pure def canRestartAccepted(h: Watchdog): bool = h.restart == RestartPending
pure def restartAccepted(h: Watchdog): Watchdog = { ...h, restart: RestartAccepted }
pure def stepAcceptedRestartIsFinal(before: Watchdog, after: Watchdog): bool =
  before.restart == RestartAccepted implies after.restart == RestartAccepted and after.restartRequests == before.restartRequests
pure def sometimesAcceptedAfterARetry(h: Watchdog): bool = h.restart == RestartAccepted and h.restartRequests == 2
```
