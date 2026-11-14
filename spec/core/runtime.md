# Agent runtime lifecycle

The host supplies persistence, model providers and assistant behavior. This model retains initialization, ingress, bounded shutdown, strict retirement and adapter-close boundaries. It projects the runtime lifecycle and service work owned by one runtime. Sources include [runtime.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime.ts), [retirement.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/retirement.ts) and [RuntimeLifecycle.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/RuntimeLifecycle.qnt).

## Story: Initialize an explicit host composition

As a host I start one agent with stable identity and observe initialization failure before admitting work.

### Initialization releases waiters on success and failure

Only a successful initialization opens ingress. A failed initialization also releases its waiters.

```quint
type InitPhase = Cold | Initializing | Ready | InitFailed
type StopPhase = Open | Stopping | Stopped | Closed
type Runtime = { initPhase: InitPhase, stopPhase: StopPhase, initWaitersReleased: bool, admissionOpen: bool, activeTurns: int, pendingDeliveries: int, pendingServices: int, pendingBeforeClose: int, fast: bool, prepareCalls: int, retirementFailed: bool, strictSuccess: bool, adapterClosed: bool }
pure val initial: Runtime = { initPhase: Cold, stopPhase: Open, initWaitersReleased: false, admissionOpen: false, activeTurns: 0, pendingDeliveries: 0, pendingServices: 0, pendingBeforeClose: 0, fast: false, prepareCalls: 0, retirementFailed: false, strictSuccess: false, adapterClosed: false }
pure def canBeginInitialization(s: Runtime): bool = s.initPhase == Cold and s.stopPhase == Open
pure def beginInitialization(s: Runtime): Runtime = { ...s, initPhase: Initializing }
pure def canCompleteInitialization(s: Runtime, ok: bool): bool = s.initPhase == Initializing
pure def completeInitialization(s: Runtime, ok: bool): Runtime = { ...s, initPhase: if (ok) Ready else InitFailed, initWaitersReleased: true, admissionOpen: ok and s.stopPhase == Open }
pure def alwaysInitializationHonest(s: Runtime): bool = ((s.initPhase == Ready or s.initPhase == InitFailed) implies s.initWaitersReleased) and (s.admissionOpen implies (s.initPhase == Ready and s.stopPhase == Open))
pure def sometimesInitializationFailed(s: Runtime): bool = s.initPhase == InitFailed and s.initWaitersReleased
pure def sometimesInitialized(s: Runtime): bool = s.initPhase == Ready and s.admissionOpen
```

### Only open ingress admits new turns

The runtime keeps every admitted turn until its durable outcome settles.

```quint
pure def canAdmitTurn(s: Runtime): bool = s.admissionOpen
pure def admitTurn(s: Runtime): Runtime = { ...s, activeTurns: s.activeTurns + 1 }
pure def canFinishTurn(s: Runtime, durableSettled: bool): bool = s.activeTurns > 0 and durableSettled
pure def finishTurn(s: Runtime, durableSettled: bool): Runtime = { ...s, activeTurns: s.activeTurns - 1 }
pure def canBeginDelivery(s: Runtime): bool = s.admissionOpen
pure def beginDelivery(s: Runtime): Runtime = { ...s, pendingDeliveries: s.pendingDeliveries + 1 }
pure def canFinishDelivery(s: Runtime): bool = s.pendingDeliveries > 0
pure def finishDelivery(s: Runtime): Runtime = { ...s, pendingDeliveries: s.pendingDeliveries - 1 }
pure def canBeginServiceWork(s: Runtime): bool = s.admissionOpen
pure def beginServiceWork(s: Runtime): Runtime = { ...s, pendingServices: s.pendingServices + 1 }
pure def canFinishServiceWork(s: Runtime): bool = s.pendingServices > 0
pure def finishServiceWork(s: Runtime): Runtime = { ...s, pendingServices: s.pendingServices - 1 }
pure def alwaysWorkCounts(s: Runtime): bool = s.activeTurns >= 0 and s.pendingDeliveries >= 0 and s.pendingServices >= 0 and s.pendingBeforeClose >= 0
```

## Story: Retire every owned operation

As a host I stop ingress once and distinguish a bounded stop from successful strict retirement.

### Stop closes admissions and prepares services once

A repeated stop joins the existing operation and cannot reopen ingress.

```quint
pure def canRequestStop(s: Runtime, fast: bool): bool = s.stopPhase == Open
pure def requestStop(s: Runtime, fast: bool): Runtime = { ...s, stopPhase: Stopping, admissionOpen: false, fast: fast, prepareCalls: 1 }
pure def canFinishStop(s: Runtime): bool = s.stopPhase == Stopping and s.activeTurns == 0 and (s.fast or (s.pendingDeliveries == 0 and s.pendingServices == 0))
pure def finishStop(s: Runtime): Runtime = { ...s, stopPhase: Stopped }
pure def alwaysStopPreparesOnce(s: Runtime): bool = s.prepareCalls >= 0 and s.prepareCalls <= 1 and (s.stopPhase != Open implies (s.prepareCalls == 1 and not(s.admissionOpen)))
pure def stepIngressNeverReopens(before: Runtime, after: Runtime): bool = before.stopPhase != Open implies not(after.admissionOpen)
pure def sometimesFastStopRetainsWork(s: Runtime): bool = s.fast and s.stopPhase == Stopped and s.pendingServices > 0
```

### Strict retirement succeeds only when original work is drained

A retirement failure persists and prevents a success claim.

Discovered by the proof: strict retirement success also requires the stopped or
closed phase. Without this fact the invariant admitted an impossible state with
open ingress and a prior success, allowing new work after that success.

```quint
pure def canBeginBeforeClose(s: Runtime): bool = s.admissionOpen
pure def beginBeforeClose(s: Runtime): Runtime = { ...s, pendingBeforeClose: s.pendingBeforeClose + 1 }
pure def canFinishBeforeClose(s: Runtime): bool = s.pendingBeforeClose > 0
pure def finishBeforeClose(s: Runtime): Runtime = { ...s, pendingBeforeClose: s.pendingBeforeClose - 1 }
pure def canRecordRetirementFailure(s: Runtime): bool = not(s.strictSuccess) and s.stopPhase != Closed
pure def recordRetirementFailure(s: Runtime): Runtime = { ...s, retirementFailed: true }
pure def canConfirmQuiescence(s: Runtime): bool = s.stopPhase == Stopped and s.activeTurns == 0 and s.pendingDeliveries == 0 and s.pendingServices == 0 and s.pendingBeforeClose == 0 and not(s.retirementFailed)
pure def confirmQuiescence(s: Runtime): Runtime = { ...s, strictSuccess: true }
pure def canCloseAdapter(s: Runtime): bool = s.stopPhase == Stopped and s.pendingBeforeClose == 0 and s.activeTurns == 0 and not(s.retirementFailed)
pure def closeAdapter(s: Runtime): Runtime = { ...s, stopPhase: Closed, adapterClosed: true }
pure def alwaysStrictSuccessHasNoPendingWork(s: Runtime): bool = s.strictSuccess implies ((s.stopPhase == Stopped or s.stopPhase == Closed) and s.activeTurns == 0 and s.pendingDeliveries == 0 and s.pendingServices == 0 and s.pendingBeforeClose == 0 and not(s.retirementFailed))
pure def alwaysCloseRespectsWork(s: Runtime): bool = s.adapterClosed implies (s.stopPhase == Closed and s.pendingBeforeClose == 0 and s.activeTurns == 0 and not(s.retirementFailed))
pure def stepRetirementFailuresPersist(before: Runtime, after: Runtime): bool = before.retirementFailed implies after.retirementFailed
pure def sometimesStrictRetirementSucceeds(s: Runtime): bool = s.strictSuccess
pure def sometimesCloseIsRefusedForPendingWork(s: Runtime): bool = s.stopPhase == Stopped and s.pendingBeforeClose > 0 and not(canCloseAdapter(s))
```

### Owned runtime work eventually drains under fair settlement

The environment eventually settles each admitted operation. Fair scheduling then reaches stopped state.

```quint
pure val fair_finishTurn = "weak"
pure val fair_finishDelivery = "weak"
pure val fair_finishServiceWork = "weak"
pure val fair_finishBeforeClose = "weak"
pure val fair_finishStop = "weak"
pure def leadsToStopped(s: Runtime, later: Runtime): bool = s.stopPhase == Stopping implies (later.stopPhase == Stopped or later.stopPhase == Closed)
```

### Every pending runtime phase has an enabled completion step

An open idle runtime and a stopped runtime without remaining work are quiescent. Initialization, admitted work, shutdown and before-close drains each retain an enabled completion boundary.

```quint
pure def runtimeQuiescent(s: Runtime): bool = s.initPhase != Initializing and s.activeTurns == 0 and s.pendingDeliveries == 0 and s.pendingServices == 0 and s.pendingBeforeClose == 0 and s.stopPhase != Stopping
pure def runtimeProgressEnabled(s: Runtime): bool = canCompleteInitialization(s, false) or canFinishTurn(s, true) or canFinishDelivery(s) or canFinishServiceWork(s) or canFinishBeforeClose(s) or canFinishStop(s)
pure def alwaysRuntimeDeadlockFree(s: Runtime): bool = runtimeQuiescent(s) or runtimeProgressEnabled(s)
```
