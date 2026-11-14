# Concurrent connector dispatches

This composes [connector selection](./messaging.md) across one shared registry and independent invocations. Sources are `packages/core/src/runtime/connector-registry.ts` and `connector-registration.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`.

## Story: Retain captured transports during registry replacement

As a host I can dispatch multiple send, hook and post calls while replacing account registrations. Each call retains its own selected callback through voice preparation, deferred invocation and transport settlement.

### Shared descriptors expose distinct capabilities to independent calls

Descriptor presence is independent of method availability. Send transports use their separate map; hook and post inspect their respective method on the selected descriptor. Each call receives an immutable projection at admission.

```quint
import messaging as C from "./messaging"
type ConnectorDescriptor = {source: str, account: str, hook: int, post: int}
type ConnectorCall = {id: int, unit: C::ConnectorState}
type ConcurrentConnectors = {descriptors: List[ConnectorDescriptor], transports: List[C::ConnectorEntry], calls: List[ConnectorCall]}
pure val initial: ConcurrentConnectors = {descriptors: List(), transports: List(), calls: List()}
pure val callIdValues = Set(1, 2, 3)
pure val sourceValues = C::sourceValues
pure val accountValues = C::accountValues
pure val handlerValues = C::handlerValues
pure val hookValues = C::handlerValues
pure val postValues = C::handlerValues
pure def connectorCall(s: ConcurrentConnectors, callId: int): C::ConnectorState = s.calls.select(c => c.id == callId).nthOr(0, {id: 0, unit: C::initial}).unit
pure def canRegisterDescriptor(s: ConcurrentConnectors, source: str, account: str, hook: int, post: int): bool = source != "" and hook >= 0 and post >= 0
pure def registerDescriptor(s: ConcurrentConnectors, source: str, account: str, hook: int, post: int): ConcurrentConnectors = { ...s, descriptors: s.descriptors.select(d => d.source != source or d.account != account).append({source: source, account: account, hook: hook, post: post}) }
pure def canRegisterTransport(s: ConcurrentConnectors, source: str, account: str, handler: int): bool = source != "" and handler > 0
pure def registerTransport(s: ConcurrentConnectors, source: str, account: str, handler: int): ConcurrentConnectors = { ...s, transports: s.transports.select(d => d.source != source or d.account != account).append({source: source, account: account, handler: handler}) }
pure def removeAccount(s: ConcurrentConnectors, source: str, account: str): ConcurrentConnectors = { ...s, descriptors: s.descriptors.select(d => d.source != source or d.account != account), transports: s.transports.select(d => d.source != source or d.account != account) }
pure def removeSource(s: ConcurrentConnectors, source: str): ConcurrentConnectors = { ...s, descriptors: s.descriptors.select(d => d.source != source), transports: s.transports.select(d => d.source != source) }
pure def canBeginCall(s: ConcurrentConnectors, callId: int, mode: C::DispatchMode, source: str, account: str): bool = callId > 0 and not(s.calls.some(c => c.id == callId)) and C::canConfigureConnector(C::initial, mode, source, account)
pure def beginCall(s: ConcurrentConnectors, callId: int, mode: C::DispatchMode, source: str, account: str): ConcurrentConnectors = {
  val unit = { ...C::configureConnector(C::initial, mode, source, account), descriptors: s.descriptors.listMap(d => {source: d.source, account: d.account, handler: if (mode == C::Hook) d.hook else d.post}), transports: s.transports }
  { ...s, calls: s.calls.append({id: callId, unit: C::dispatchConnector(unit)}) }
}
pure def canInvokeCall(s: ConcurrentConnectors, callId: int): bool = C::canInvokeCaptured(connectorCall(s, callId))
pure def invokeCall(s: ConcurrentConnectors, callId: int): ConcurrentConnectors = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, unit: C::invokeCaptured(c.unit) } else c) }
pure def canFinishCall(s: ConcurrentConnectors, callId: int, ok: bool): bool = C::canFinishConnector(connectorCall(s, callId), ok)
pure def finishCall(s: ConcurrentConnectors, callId: int, ok: bool): ConcurrentConnectors = { ...s, calls: s.calls.listMap(c => if (c.id == callId) { ...c, unit: C::finishConnector(c.unit, ok) } else c) }
pure def alwaysEachCallValid(s: ConcurrentConnectors): bool = s.calls.every(c => C::alwaysUnsupportedNeverInvokes(c.unit) and C::alwaysUsesCapturedHandler(c.unit) and C::alwaysAwaitBeforeInvocation(c.unit) and C::alwaysSuccessRequiresSettlement(c.unit))
pure def alwaysCallIdsUnique(s: ConcurrentConnectors): bool = s.calls.every(c => c.id > 0 and s.calls.select(other => other.id == c.id).length() == 1)
pure def stepCapturedCallbacksStable(before: ConcurrentConnectors, after: ConcurrentConnectors): bool = before.calls.every(c => after.calls.some(other => other.id == c.id and other.unit.selectedOwner == c.unit.selectedOwner and other.unit.selectedAccount == c.unit.selectedAccount))
pure def stepRegistryDoesNotMutateCalls(before: ConcurrentConnectors, via: str, after: ConcurrentConnectors): bool = (via == "registerDescriptor" or via == "registerTransport" or via == "removeAccount" or via == "removeSource") implies after.calls == before.calls
pure def sometimesOldAndNewTransportCaptured(s: ConcurrentConnectors): bool = s.calls.some(a => s.calls.some(b => a.id != b.id and a.unit.targetSource == b.unit.targetSource and a.unit.targetAccount == b.unit.targetAccount and a.unit.selectedOwner > 0 and b.unit.selectedOwner > 0 and a.unit.selectedOwner != b.unit.selectedOwner))
pure def sometimesConcurrentModes(s: ConcurrentConnectors): bool = s.calls.some(a => s.calls.some(b => a.id != b.id and a.unit.mode != b.unit.mode and a.unit.phase != C::Done and b.unit.phase != C::Done))
pure val fair_invokeCall = "strong"
pure val fair_finishCall = "strong"
pure def leadsToCapturedCallsSettle(s: ConcurrentConnectors, later: ConcurrentConnectors): bool = s.calls.every(c => later.calls.some(done => done.id == c.id and done.unit.phase == C::Done))
```
