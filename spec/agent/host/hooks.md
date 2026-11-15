# Hooks and the memory watchdog

Hooks are handlers the owner installs to run on host events. Each dispatch
takes a snapshot of the registered hooks and delivers to exactly those,
even if the registry is disabled while it runs; a disabled registry holds
no hooks. Separately, a watchdog samples the host's memory and asks for a
restart after sustained high use; the request is latched until it settles,
and once a restart is accepted nothing asks again. The research baseline is
`packages/agent/src/hooks/{registry,loader,discovery,eligibility}.ts`,
`runtime/memory-watchdog.ts` and the `runtime-hooks-watchdog` model.

## Story: Run the owner's hooks on host events

> As the owner, a hook I install runs once for each event it was
> registered for, and a hook I removed never runs on a later event.

### A disabled registry holds no hooks

Discovered in the research baseline: the disabled branch returned before
clearing the old handlers, which kept running.

```quint
type Restart = NoRestart | RestartPending | RestartAccepted
type Hooks = { registryOn: bool, hooks: int, snapshot: int, remaining: int, delivered: int, dispatching: bool, highSamples: int, restart: Restart, restartRequests: int }
pure val initial: Hooks = { registryOn: false, hooks: 0, snapshot: 0, remaining: 0, delivered: 0, dispatching: false, highSamples: 0, restart: NoRestart, restartRequests: 0 }
pure val countValues = Set(1, 2)
pure def canEnable(h: Hooks, count: int): bool = count > 0
pure def enable(h: Hooks, count: int): Hooks = { ...h, registryOn: true, hooks: count }
pure def canDisable(h: Hooks): bool = h.registryOn
pure def disable(h: Hooks): Hooks = { ...h, registryOn: false, hooks: 0 }
pure def alwaysDisabledRegistryIsEmpty(h: Hooks): bool = not(h.registryOn) implies h.hooks == 0
```

### A dispatch delivers to exactly the hooks registered when it began

```quint
pure def canDispatch(h: Hooks): bool = not(h.dispatching) and h.registryOn
pure def dispatch(h: Hooks): Hooks = { ...h, snapshot: h.hooks, remaining: h.hooks, delivered: 0, dispatching: true }
pure def canDeliver(h: Hooks): bool = h.dispatching and h.remaining > 0
pure def deliver(h: Hooks): Hooks = { ...h, remaining: h.remaining - 1, delivered: h.delivered + 1 }
pure def canDispatchDone(h: Hooks): bool = h.dispatching and h.remaining == 0
pure def dispatchDone(h: Hooks): Hooks = { ...h, dispatching: false }
pure def alwaysDeliveriesMatchSnapshot(h: Hooks): bool =
  h.remaining >= 0 and h.delivered + h.remaining == h.snapshot
pure def sometimesSnapshotDrainedAfterDisable(h: Hooks): bool = not(h.registryOn) and h.delivered > 0 and not(h.dispatching) and h.delivered == h.snapshot
```

## Story: Restart a host that keeps using too much memory

> As the owner, my agent restarts itself once when it keeps using too much
> memory, not on a single spike and not over and over.

### A restart is requested only after two consecutive high samples

```quint
pure val sustainedSamples = 2
pure def canHighSample(h: Hooks): bool = h.restart == NoRestart and h.highSamples < sustainedSamples
pure def highSample(h: Hooks): Hooks = { ...h, highSamples: h.highSamples + 1 }
pure def canLowSample(h: Hooks): bool = h.restart == NoRestart
pure def lowSample(h: Hooks): Hooks = { ...h, highSamples: 0 }
pure def canRequestRestart(h: Hooks): bool = h.restart == NoRestart and h.highSamples == sustainedSamples
pure def requestRestart(h: Hooks): Hooks = { ...h, restart: RestartPending, restartRequests: h.restartRequests + 1 }
pure def alwaysRestartFollowsSustainedUse(h: Hooks): bool =
  h.highSamples >= 0 and h.highSamples <= sustainedSamples and (h.restart != NoRestart implies h.highSamples == sustainedSamples)
```

### A failed restart request re-arms only after it settles, and an accepted one is final

```quint
pure def canRestartFailed(h: Hooks): bool = h.restart == RestartPending
pure def restartFailed(h: Hooks): Hooks = { ...h, restart: NoRestart }
pure def canRestartAccepted(h: Hooks): bool = h.restart == RestartPending
pure def restartAccepted(h: Hooks): Hooks = { ...h, restart: RestartAccepted }
pure def stepAcceptedRestartIsFinal(before: Hooks, after: Hooks): bool =
  before.restart == RestartAccepted implies after.restart == RestartAccepted and after.restartRequests == before.restartRequests
pure def sometimesAcceptedAfterARetry(h: Hooks): bool = h.restart == RestartAccepted and h.restartRequests == 2
```
