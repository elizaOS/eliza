# Native renderer ownership and turn timing

A device host binds the agent's native renderer to itself and publishes the
timing of the owner's turns to it. Host and turn identifiers are handles
here; a string ID never conveys authority. [Views](./views.md) own
installations and claims.

## Story: Show the native renderer only to its bound host

> As a device owner, my native renderer connects only through the host that
> bound it, and a host that already let go cannot disconnect its successor.

### A renderer connects only to a bound host that has not stopped

A host binds when none is bound. A renderer connects only while a host is
bound and the agent has not stopped. Unbinding names the host: a stale host
cannot unbind or disconnect the one that replaced it. Stopping disconnects
the renderer for good.

```quint
type NativeViews = { host: int, renderer: bool, stopped: bool, revision: int, latestTurn: int, capturedRevision: int, timingTurn: int, completed: Set[int] }
pure val initial: NativeViews = { host: 0, renderer: false, stopped: false, revision: 0, latestTurn: 0, capturedRevision: -1, timingTurn: 0, completed: Set() }
pure def canBindHost(n: NativeViews, host: int): bool = n.host == 0 and not(n.stopped) and host > 0
pure def bindHost(n: NativeViews, host: int): NativeViews = { ...n, host: host }
pure def canConnectRenderer(n: NativeViews): bool = n.host != 0 and not(n.stopped) and not(n.renderer)
pure def connectRenderer(n: NativeViews): NativeViews = { ...n, renderer: true }
pure def canUnbindHost(n: NativeViews, host: int): bool = host > 0
pure def unbindHost(n: NativeViews, host: int): NativeViews = if (n.host == host) { ...n, host: 0, renderer: false } else n
pure def stopNative(n: NativeViews): NativeViews = { ...n, stopped: true, renderer: false }
pure val hostValues = Set(0, 1, 2)
pure def alwaysRendererHasLiveHost(n: NativeViews): bool = n.renderer implies (n.host != 0 and not(n.stopped))
pure def stepStaleHostCannotUnbindSuccessor(before: NativeViews, via: str, after: NativeViews): bool =
  (via == "unbindHost" and after.host != 0) implies (after.host == before.host and after.renderer == before.renderer)
pure def sometimesSuccessorRendererConnected(n: NativeViews): bool = n.renderer and n.host == 2
```

## Story: Publish turn timing for the owner's latest turn only

> As a device owner, the timing shown is for my latest turn, never an
> older one and never one from before the owner changed.

### Only the latest captured turn of the unchanged owner publishes its timing

Each turn captures the owner revision when it starts, and a newer turn
supersedes older ones. A completing turn publishes timing only if it is the
latest turn and the owner revision is still the one it captured. An owner
change clears published timing.

```quint
pure def canCaptureTurn(n: NativeViews, turn: int): bool = turn > n.latestTurn
pure def captureTurn(n: NativeViews, turn: int): NativeViews = { ...n, latestTurn: turn, capturedRevision: n.revision, timingTurn: 0 }
pure def canCompleteTurn(n: NativeViews, turn: int): bool = turn > 0 and turn <= n.latestTurn and not(n.completed.contains(turn))
pure def completeTurn(n: NativeViews, turn: int): NativeViews =
  { ...n, completed: n.completed.union(Set(turn)), timingTurn: if (turn == n.latestTurn and n.capturedRevision == n.revision) turn else n.timingTurn }
pure def rotateOwner(n: NativeViews): NativeViews = { ...n, revision: n.revision + 1, timingTurn: 0 }
pure val turnValues = Set(0, 1, 2, 3)
pure def alwaysTimingIsLatestOwnerTurn(n: NativeViews): bool =
  n.timingTurn != 0 implies (n.timingTurn == n.latestTurn and n.capturedRevision == n.revision)
pure def sometimesTimingPublished(n: NativeViews): bool = n.timingTurn > 1
pure def sometimesOwnerChangeHidesTiming(n: NativeViews): bool = n.completed.contains(n.latestTurn) and n.latestTurn > 0 and n.timingTurn == 0
```
