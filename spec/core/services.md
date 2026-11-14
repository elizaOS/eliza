# Service acquisition and retirement

A service class owns one startup and one resulting instance. Parallel classes use this protocol independently and the declaration list determines lookup order. Sources include [service-lifecycle.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/service-lifecycle.ts), [service.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/service.ts) and [ServiceLifecycle.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/ServiceLifecycle.qnt).

## Story: Acquire a declared service

As a plugin I share startup and receive a truthful instance or typed failure.

### Concurrent acquisition joins the original startup

Registration precedes startup. Joining never starts another instance. Direct acquisition may retry a failed start. The registry composes one lifecycle per class.

```quint
type ServicePhase = Missing | Pending | Starting | Running | StartFailed | Retiring | Retired
type ServiceState = { phase: ServicePhase, registered: bool, stopRequested: bool, startAttempts: int, startPending: bool, published: bool, joins: int, stopCalls: int, stopPending: bool, stopFailed: bool, observerFailed: bool }
pure val initial: ServiceState = { phase: Missing, registered: false, stopRequested: false, startAttempts: 0, startPending: false, published: false, joins: 0, stopCalls: 0, stopPending: false, stopFailed: false, observerFailed: false }
pure def canRegisterService(s: ServiceState): bool = s.phase == Missing and not(s.stopRequested)
pure def registerService(s: ServiceState): ServiceState = { ...s, phase: Pending, registered: true }
pure def canStartService(s: ServiceState): bool = (s.phase == Pending or s.phase == StartFailed) and s.registered and not(s.stopRequested)
pure def startService(s: ServiceState): ServiceState = { ...s, phase: Starting, startPending: true, startAttempts: s.startAttempts + 1 }
pure def canJoinStartup(s: ServiceState): bool = s.startPending
pure def joinStartup(s: ServiceState): ServiceState = { ...s, joins: s.joins + 1 }
pure def canFailStartup(s: ServiceState): bool = s.phase == Starting and s.startPending
pure def failStartup(s: ServiceState): ServiceState = { ...s, phase: if (s.stopRequested) Retired else StartFailed, startPending: false }
pure def canPublishService(s: ServiceState): bool = s.phase == Starting and s.startPending and s.registered and not(s.stopRequested)
pure def publishService(s: ServiceState): ServiceState = { ...s, phase: Running, startPending: false, published: true }
pure def alwaysPublishedIsOwned(s: ServiceState): bool = s.published implies (s.registered and s.phase == Running and not(s.stopRequested))
pure def alwaysStartupBounds(s: ServiceState): bool = s.startAttempts >= 0 and s.joins >= 0 and (s.startPending iff s.phase == Starting)
pure def sometimesJoinedStartup(s: ServiceState): bool = s.startPending and s.joins == 2
pure def sometimesStartupRetries(s: ServiceState): bool = s.phase == Running and s.startAttempts > 1
```

### An observer failure retains the running service

SERVICE_STARTED follows publication and an observer error is diagnostic.

```quint
pure def canFailObserver(s: ServiceState): bool = s.phase == Running
pure def failObserver(s: ServiceState): ServiceState = { ...s, observerFailed: true }
pure def sometimesObserverFailureKeepsInstance(s: ServiceState): bool = s.observerFailed and s.published
```

## Story: Stop a late or removed service once

As a host I retire every created instance, including one completing after unload or stop.

### Late startup enters retirement without publication

An in-flight start remains tracked after stop request or class removal.

```quint
pure def canRequestServiceStop(s: ServiceState): bool = not(s.stopRequested)
pure def requestServiceStop(s: ServiceState): ServiceState = { ...s, stopRequested: true, published: false, phase: if (s.phase == Running) Retiring else if (s.phase == Starting) Starting else if (s.phase == Retiring) Retiring else Retired, stopCalls: if (s.phase == Running) 1 else s.stopCalls, stopPending: s.stopPending or s.phase == Running }
pure def canRemoveClass(s: ServiceState): bool = s.registered
pure def removeClass(s: ServiceState): ServiceState = { ...s, registered: false, stopRequested: true, published: false, phase: if (s.phase == Running) Retiring else if (s.phase == Starting) Starting else if (s.phase == Retiring) Retiring else Retired, stopCalls: if (s.phase == Running) 1 else s.stopCalls, stopPending: s.stopPending or s.phase == Running }
pure def canRetireLateStartup(s: ServiceState): bool = s.phase == Starting and s.startPending and (s.stopRequested or not(s.registered))
pure def retireLateStartup(s: ServiceState): ServiceState = { ...s, phase: Retiring, startPending: false, stopCalls: 1, stopPending: true, published: false }
pure def canFinishServiceStop(s: ServiceState, ok: bool): bool = s.phase == Retiring and s.stopPending
pure def finishServiceStop(s: ServiceState, ok: bool): ServiceState = { ...s, phase: Retired, stopPending: false, stopFailed: not(ok) }
pure def alwaysStopAtMostOnce(s: ServiceState): bool = s.stopCalls >= 0 and s.stopCalls <= 1 and (s.stopPending implies s.stopCalls == 1)
pure def alwaysRetiredHasNoInstance(s: ServiceState): bool = s.phase == Retired implies (not(s.startPending) and not(s.stopPending) and not(s.published))
pure def sometimesLateInstanceStops(s: ServiceState): bool = s.phase == Retiring and s.startAttempts > 0 and not(s.registered)
pure def sometimesTeardownFailureIsRetained(s: ServiceState): bool = s.phase == Retired and s.stopFailed
```

### A requested service stop eventually retires under fair completion

The environment eventually settles the original start and stop promises. Fair retirement then reaches Retired.

```quint
pure val fair_failStartup = "weak"
pure val fair_retireLateStartup = "weak"
pure val fair_finishServiceStop = "weak"
pure def leadsToServiceRetired(s: ServiceState, later: ServiceState): bool = s.stopRequested implies later.phase == Retired
```

### Every original startup eventually settles under fair completion

A service start eventually yields an instance or a startup failure.

```quint
pure val fair_publishService = "weak"
pure def leadsToStartupSettled(s: ServiceState, later: ServiceState): bool = s.startPending implies not(later.startPending)
```

### Every pending service operation has an enabled completion step

Missing, pending registration, running, failed startup and retired service states are quiescent. A started operation can always settle through its original start or stop result.

```quint
pure def serviceQuiescent(s: ServiceState): bool = not(s.startPending) and not(s.stopPending)
pure def serviceProgressEnabled(s: ServiceState): bool = canFailStartup(s) or canPublishService(s) or canRetireLateStartup(s) or canFinishServiceStop(s, true)
pure def alwaysServiceDeadlockFree(s: ServiceState): bool = serviceQuiescent(s) or serviceProgressEnabled(s)
pure def alwaysPendingStopHasRetiringPhase(s: ServiceState): bool = s.stopPending implies s.phase == Retiring
```
