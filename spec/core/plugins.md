# Plugin registration and ownership

Plugin ownership is bound to runtime identity and object identity. Register, rollback, unload, reload and successor connector ownership retain separate transition boundaries. Sources include [plugin-lifecycle.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/plugin-lifecycle.ts), [plugin.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/plugin.ts) and [PluginLifecycle.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/PluginLifecycle.qnt).

## Story: Load and roll back a plugin

As a plugin author I receive one shared registration result, and partial contributions remain owned until cleanup finishes.

### Duplicate callers share the registration outcome

Pending registration is published before init and duplicate registration joins it.

Discovered by the proof: rollback already carries the failed shared registration result, and a claimed service stop cannot coexist with a live published owned instance. These facts connect cleanup to the result and ownership transitions that preceded it.

```quint
type PluginPhase = Absent | Registering | Loaded | RollingBack | Unloading | Unloaded | RegistrationFailed
type ConnectorOwner = NoOwner | ThisPlugin | Successor
type PluginState = { phase: PluginPhase, callers: int, outcomeKnown: bool, outcomeSuccess: bool, contributions: int, hasAdapter: bool, disposeCalls: int, disposePending: bool, cleanupFailed: bool, connectorOwner: ConnectorOwner, servicePending: bool, serviceLive: bool, serviceStopCalls: int, serviceStopPending: bool }
pure val initial: PluginState = { phase: Absent, callers: 0, outcomeKnown: false, outcomeSuccess: false, contributions: 0, hasAdapter: false, disposeCalls: 0, disposePending: false, cleanupFailed: false, connectorOwner: NoOwner, servicePending: false, serviceLive: false, serviceStopCalls: 0, serviceStopPending: false }
pure def canBeginRegistration(s: PluginState, adapter: bool): bool = s.phase == Absent
pure def beginRegistration(s: PluginState, adapter: bool): PluginState = { ...s, phase: Registering, callers: 1, hasAdapter: adapter }
pure def canJoinRegistration(s: PluginState): bool = s.phase == Registering
pure def joinRegistration(s: PluginState): PluginState = { ...s, callers: s.callers + 1 }
pure def canContribute(s: PluginState): bool = s.phase == Registering
pure def contribute(s: PluginState): PluginState = { ...s, contributions: s.contributions + 1 }
pure def canCommitRegistration(s: PluginState): bool = s.phase == Registering
pure def commitRegistration(s: PluginState): PluginState = { ...s, phase: Loaded, outcomeKnown: true, outcomeSuccess: true }
pure def canFailRegistration(s: PluginState): bool = s.phase == Registering
pure def failRegistration(s: PluginState): PluginState = { ...s, phase: RollingBack, outcomeKnown: true, outcomeSuccess: false, disposeCalls: 1, disposePending: true }
pure def alwaysRegistrationOutcomeAgrees(s: PluginState): bool = (s.phase == Loaded implies (s.outcomeKnown and s.outcomeSuccess)) and ((s.phase == RollingBack or s.phase == RegistrationFailed) implies (s.outcomeKnown and not(s.outcomeSuccess)))
pure def alwaysOneDispose(s: PluginState): bool = s.disposeCalls >= 0 and s.disposeCalls <= 1 and (s.disposePending implies s.disposeCalls == 1)
pure def sometimesCallersShareFailure(s: PluginState): bool = s.phase == RegistrationFailed and s.callers == 3
```

### Cleanup removes only owned contributions

A successor registration survives predecessor cleanup, and adapter ownership prevents hot unload.

```quint
pure def canOwnConnector(s: PluginState): bool = s.phase == Registering or s.phase == Loaded
pure def ownConnector(s: PluginState): PluginState = { ...s, connectorOwner: ThisPlugin }
pure def canReplaceConnector(s: PluginState): bool = s.connectorOwner == ThisPlugin
pure def replaceConnector(s: PluginState): PluginState = { ...s, connectorOwner: Successor }
pure def canBeginUnload(s: PluginState): bool = s.phase == Loaded and not(s.hasAdapter)
pure def beginUnload(s: PluginState): PluginState = { ...s, phase: Unloading, disposeCalls: 1, disposePending: true }
pure def canFinishDispose(s: PluginState, ok: bool): bool = s.disposePending
pure def finishDispose(s: PluginState, ok: bool): PluginState = { ...s, disposePending: false, cleanupFailed: not(ok) }
pure def canFinishCleanup(s: PluginState): bool = (s.phase == RollingBack or s.phase == Unloading) and not(s.disposePending) and not(s.servicePending) and not(s.serviceLive) and not(s.serviceStopPending)
pure def finishCleanup(s: PluginState): PluginState = { ...s, phase: if (s.phase == RollingBack) RegistrationFailed else Unloaded, contributions: 0, connectorOwner: if (s.connectorOwner == ThisPlugin) NoOwner else s.connectorOwner }
pure def alwaysCleanedHasNoContributions(s: PluginState): bool = (s.phase == Unloaded or s.phase == RegistrationFailed) implies (s.contributions == 0 and s.connectorOwner != ThisPlugin and not(s.serviceLive))
pure def stepSuccessorKeepsOwnership(before: PluginState, via: str, after: PluginState): bool = before.connectorOwner == Successor and via == "finishCleanup" implies after.connectorOwner == Successor
pure def sometimesAdapterHotUnloadRejected(s: PluginState): bool = s.phase == Loaded and s.hasAdapter and not(canBeginUnload(s))
pure def sometimesSuccessorSurvivesUnload(s: PluginState): bool = s.phase == Unloaded and s.connectorOwner == Successor
```

### Service start remains owned across rollback and unload

An instance completing during cleanup must be stopped before cleanup completes.

```quint
pure def canStartOwnedService(s: PluginState): bool = (s.phase == Registering or s.phase == Loaded) and not(s.servicePending) and not(s.serviceLive) and s.serviceStopCalls == 0
pure def startOwnedService(s: PluginState): PluginState = { ...s, servicePending: true }
pure def canFinishOwnedService(s: PluginState): bool = s.servicePending
pure def finishOwnedService(s: PluginState): PluginState = { ...s, servicePending: false, serviceLive: s.phase == Loaded or s.phase == Registering, serviceStopCalls: if (s.phase == RollingBack or s.phase == Unloading) 1 else s.serviceStopCalls, serviceStopPending: s.phase == RollingBack or s.phase == Unloading }
pure def canStopOwnedService(s: PluginState): bool = (s.phase == RollingBack or s.phase == Unloading) and s.serviceLive and s.serviceStopCalls == 0
pure def stopOwnedService(s: PluginState): PluginState = { ...s, serviceLive: false, serviceStopCalls: 1, serviceStopPending: true }
pure def canFinishOwnedServiceStop(s: PluginState): bool = s.serviceStopPending
pure def finishOwnedServiceStop(s: PluginState): PluginState = { ...s, serviceStopPending: false }
pure def alwaysServiceStopsOnce(s: PluginState): bool = s.serviceStopCalls >= 0 and s.serviceStopCalls <= 1 and (s.serviceStopPending implies s.serviceStopCalls == 1) and (s.serviceStopCalls > 0 implies not(s.serviceLive)) and (s.servicePending implies (s.serviceStopCalls == 0 and not(s.serviceLive)))
pure def sometimesLateServiceRetired(s: PluginState): bool = s.phase == Unloaded and s.serviceStopCalls == 1
```

### Cleanup eventually finishes under fair service and disposal completion

The environment settles dispose and original service starts and stops. Cleanup then removes the owned contributions.

```quint
pure val fair_finishDispose = "weak"
pure val fair_finishOwnedService = "weak"
pure val fair_stopOwnedService = "weak"
pure val fair_finishOwnedServiceStop = "weak"
pure val fair_finishCleanup = "weak"
pure def leadsToPluginCleaned(s: PluginState, later: PluginState): bool = s.phase == RollingBack or s.phase == Unloading implies later.phase == RegistrationFailed or later.phase == Unloaded
```

### Every pending plugin operation has an enabled owner step

Absent, loaded, unloaded and failed-registration states are quiescent. Registration and teardown retain a commit, failure, disposal, service settlement or cleanup transition.

```quint
pure def pluginQuiescent(s: PluginState): bool = s.phase == Absent or s.phase == Loaded or s.phase == Unloaded or s.phase == RegistrationFailed
pure def pluginProgressEnabled(s: PluginState): bool = canCommitRegistration(s) or canFailRegistration(s) or canFinishDispose(s, true) or canFinishOwnedService(s) or canStopOwnedService(s) or canFinishOwnedServiceStop(s) or canFinishCleanup(s)
pure def alwaysPluginDeadlockFree(s: PluginState): bool = pluginQuiescent(s) or pluginProgressEnabled(s)
```
