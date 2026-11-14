# Connector dispatch

Send transports and connector metadata retain separate ownership. Sources include [connector-registry.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/connector-registry.ts), [connector-registration.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/connector-registration.ts) and [ConnectorDispatch.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/ConnectorDispatch.qnt).

## Story: Dispatch through a selected connector account

As a caller I use the account-specific capability when available and receive explicit missing or unsupported outcomes.

### Send routing and hook routing have distinct fallback rules

Send uses an exact transport then the default transport. A present exact hook descriptor shadows the default even when its method is unavailable. Post uses the exact descriptor.

```quint
type DispatchMode = Send | Hook | Post
type ConnectorPhase = Cold | Idle | Voice | Snapshot | Handler | Done
type ConnectorResult = PendingResult | MissingResult | UnsupportedResult | SuccessResult | FailureResult
type ConnectorEntry = { source: str, account: str, handler: int }
type ConnectorState = { mode: DispatchMode, phase: ConnectorPhase, targetSource: str, targetAccount: str, descriptors: List[ConnectorEntry], transports: List[ConnectorEntry], selectedAccount: str, selectedOwner: int, invokedOwner: int, result: ConnectorResult }
pure val initial: ConnectorState = { mode: Send, phase: Cold, targetSource: "", targetAccount: "", descriptors: List(), transports: List(), selectedAccount: "", selectedOwner: 0, invokedOwner: 0, result: PendingResult }
pure val sourceValues = Set("chat", "mail")
pure val accountValues = Set("", "personal", "work")
pure val handlerValues = Set(0, 1, 2)
pure def canConfigureConnector(s: ConnectorState, mode: DispatchMode, source: str, account: str): bool = s.phase == Cold and source != ""
pure def configureConnector(s: ConnectorState, mode: DispatchMode, source: str, account: str): ConnectorState = { ...s, mode: mode, phase: Idle, targetSource: source, targetAccount: account }
pure def canRegisterConnector(s: ConnectorState, source: str, account: str, handler: int): bool = source != "" and handler >= 0
pure def registerConnector(s: ConnectorState, source: str, account: str, handler: int): ConnectorState = { ...s, descriptors: s.descriptors.select(d => d.source != source or d.account != account).append({source: source, account: account, handler: handler}), transports: if (s.mode == Send and handler > 0) s.transports.select(d => d.source != source or d.account != account).append({source: source, account: account, handler: handler}) else s.transports }
pure def canRegisterTransport(s: ConnectorState, source: str, account: str, handler: int): bool = source != "" and handler > 0 and s.mode == Send
pure def registerTransport(s: ConnectorState, source: str, account: str, handler: int): ConnectorState = { ...s, transports: s.transports.select(d => d.source != source or d.account != account).append({source: source, account: account, handler: handler}) }
pure def selectedEntries(s: ConnectorState): List[ConnectorEntry] = {
  val pool = if (s.mode == Send) s.transports else s.descriptors
  val exact = pool.select(d => d.source == s.targetSource and d.account == s.targetAccount)
  if (exact.length() > 0 or s.mode == Post) exact else pool.select(d => d.source == s.targetSource and d.account == "")
}
pure def canDispatchConnector(s: ConnectorState): bool = s.phase == Idle
pure def dispatchConnector(s: ConnectorState): ConnectorState = {
  val entries = selectedEntries(s)
  val selected = entries.nthOr(0, {source: "", account: "", handler: 0})
  { ...s, selectedAccount: selected.account, selectedOwner: selected.handler,
    invokedOwner: if (s.mode == Hook) selected.handler else 0,
    phase: if (selected.handler == 0) Done else if (s.mode == Send) Voice else if (s.mode == Post) Snapshot else Handler,
    result: if (entries.length() == 0) MissingResult else if (selected.handler == 0) UnsupportedResult else PendingResult }
}
pure def alwaysUnsupportedNeverInvokes(s: ConnectorState): bool = s.result == MissingResult or s.result == UnsupportedResult implies (s.phase == Done and s.selectedOwner == 0 and s.invokedOwner == 0)
pure def sometimesExactUnsupportedHook(s: ConnectorState): bool = s.mode == Hook and s.result == UnsupportedResult and s.selectedAccount != ""
pure def sometimesDefaultSendFallback(s: ConnectorState): bool = s.mode == Send and s.targetAccount != "" and s.phase == Voice and s.selectedAccount == ""
```

### A captured handler survives registry removal and replacement

The selected transport is captured before awaited voice processing or deferred post invocation. Removing a registry entry does not dispose that captured callback.

```quint
pure def canRemoveConnector(s: ConnectorState, source: str, account: str): bool = source != ""
pure def removeConnector(s: ConnectorState, source: str, account: str): ConnectorState = { ...s, descriptors: s.descriptors.select(d => d.source != source or d.account != account), transports: s.transports.select(d => d.source != source or d.account != account) }
pure def canRemoveSource(s: ConnectorState, source: str): bool = source != ""
pure def removeSource(s: ConnectorState, source: str): ConnectorState = { ...s, descriptors: s.descriptors.select(d => d.source != source), transports: s.transports.select(d => d.source != source) }
pure def canInvokeCaptured(s: ConnectorState): bool = s.phase == Voice or s.phase == Snapshot
pure def invokeCaptured(s: ConnectorState): ConnectorState = { ...s, phase: Handler, invokedOwner: s.selectedOwner }
pure def canFinishConnector(s: ConnectorState, ok: bool): bool = s.phase == Handler
pure def finishConnector(s: ConnectorState, ok: bool): ConnectorState = { ...s, phase: Done, result: if (ok) SuccessResult else FailureResult }
pure def alwaysUsesCapturedHandler(s: ConnectorState): bool = s.invokedOwner != 0 implies s.invokedOwner == s.selectedOwner
pure def alwaysAwaitBeforeInvocation(s: ConnectorState): bool = s.phase == Voice or s.phase == Snapshot implies s.invokedOwner == 0
pure def alwaysSuccessRequiresSettlement(s: ConnectorState): bool = s.result == SuccessResult or s.result == FailureResult implies s.phase == Done and s.invokedOwner > 0
pure def stepCapturedOwnerStable(before: ConnectorState, via: str, after: ConnectorState): bool = before.phase != Cold and before.phase != Idle implies after.selectedOwner == before.selectedOwner and after.selectedAccount == before.selectedAccount
pure def sometimesRemovedHandlerStillCompletes(s: ConnectorState): bool = s.phase == Done and s.result == SuccessResult and s.transports.length() == 0 and s.descriptors.length() == 0
```

### An admitted connector call eventually settles under fair transport completion

The cosmetic voice stage or deferred post callback progresses, and the transport eventually resolves or rejects.

```quint
pure val fair_invokeCaptured = "weak"
pure val fair_finishConnector = "weak"
pure def leadsToConnectorSettled(s: ConnectorState, later: ConnectorState): bool = (s.phase == Voice or s.phase == Snapshot or s.phase == Handler) implies later.phase == Done
```
