# Full-value connector storage handoff

The manager in `connectors/account-manager.ts` serializes backend selection, fallback transfer and the requested facade operation in one queue. This owner embeds the complete [account/flow store](./connectorStorage.md) and [queue](./connectorQueues.md). The database wrapper's process mirror and verifier state remain [oauthBridge](./oauthBridge.md); when it cannot persist flow rows, the selected target store here denotes that wrapper's retained mirror rather than a durable database.

## Story: Transfer complete fallback state before invoking the next backend

### The snapshot contains exact accounts and pending unexpired flows

A transfer snapshots every account plus each unique pending, unexpired flow, retaining each consumed marker. Already-terminal and expired unconsumed flows are not copied. New facade operations stay queued until transfer and the current operation finish. The selected backend reference remains fixed for that operation even if host configuration changes.
The fallback facade's successful one-time consume updates the embedded flow's consumed marker before the operation releases its queue ticket; a later handoff must replay that marker on the selected target.
The scheduler selects the actual oldest eligible ticket, so progress does not
depend on a finite enumeration of ticket identities. Under fair scheduling and
eventual settlement of each external I/O call, every admitted facade operation
eventually settles its ticket, whether it succeeds or fails. This assumption
does not require successful external I/O.

```quint
import connectorStorage as D from "./connectorStorage"
import accountValues as A from "./accountValues"
import connectorQueues as Q from "./connectorQueues"
import oauthBridge as B from "./oauthBridge"
import oauthSecrets as S from "./oauthSecrets"
type HandoffPhase = HandoffIdle | CopyAccounts | CopyFlows | AwaitBridgeCreate | ReplayConsumption | AwaitBridgeConsume | InvokeOperation
type BackendKind = BootFallback | ServiceBackend | DatabaseBackend
type Handoff = { fallback: D::ConnectorStore, targets: str -> D::ConnectorStore, targetIds: Set[str], bridge: B::OAuthBridge, bridgeAdapter: str, kind: BackendKind, queue: Q::ConnectorQueues, activeTicket: int, selectedBackend: str, phase: HandoffPhase, accountSnapshot: List[A::AccountValue], flowSnapshot: List[D::FlowEntry], accountIndex: int, flowIndex: int, failed: bool }
pure val initial: Handoff = { fallback: D::initial, targets: Map(), targetIds: Set(), bridge: B::initial, bridgeAdapter: "", kind: BootFallback, queue: Q::initial, activeTicket: 0, selectedBackend: "", phase: HandoffIdle, accountSnapshot: List(), flowSnapshot: List(), accountIndex: 0, flowIndex: 0, failed: false }
pure def targetStore(s: Handoff): D::ConnectorStore = { ...s.targets.getOr(s.selectedBackend, D::initial), now: s.fallback.now }
pure def enqueue(s: Handoff, manager: str): Handoff = { ...s, queue: Q::admit(s.queue, { owner: manager, provider: "storage" }) }
pure def canBeginOperation(s: Handoff, ticket: int, backend: str): bool = s.phase == HandoffIdle and backend != "" and Q::canBegin(s.queue, ticket)
pure def beginOperation(s: Handoff, ticket: int, backend: str, kind: BackendKind, methods: B::AdapterMethods): Handoff = {
  val transfer = kind != BootFallback and (s.fallback.accounts.length() > 0 or s.fallback.flows.length() > 0)
  { ...s, queue: Q::begin(s.queue, ticket), activeTicket: ticket, selectedBackend: backend, targetIds: s.targetIds.union(Set(backend)), targets: if (s.targetIds.contains(backend)) s.targets else s.targets.put(backend, D::initial), bridge: if (kind == DatabaseBackend and s.bridgeAdapter != backend) { ...B::initial, methods: methods, secrets: s.bridge.secrets } else s.bridge, bridgeAdapter: if (kind == DatabaseBackend) backend else s.bridgeAdapter, kind: kind, phase: if (transfer) CopyAccounts else InvokeOperation, accountSnapshot: if (transfer) s.fallback.accounts else List(), flowSnapshot: if (transfer) D::migratableFlows(s.fallback).select(entry => not(entry.consumed)).concat(D::migratableFlows(s.fallback).select(entry => entry.consumed)) else List(), accountIndex: 0, flowIndex: 0, failed: false }
}
pure def canBeginNextOperation(s: Handoff, backend: str): bool = canBeginOperation(s, Q::firstEligible(s.queue), backend)
pure def beginNextOperation(s: Handoff, backend: str, kind: BackendKind, methods: B::AdapterMethods): Handoff = beginOperation(s, Q::firstEligible(s.queue), backend, kind, methods)
pure def canWriteFallbackAccount(s: Handoff, account: A::AccountValue): bool = s.phase == InvokeOperation and s.kind == BootFallback and D::canUpsertAccount(s.fallback, account)
pure def writeFallbackAccount(s: Handoff, account: A::AccountValue): Handoff = { ...s, fallback: D::upsertAccount(s.fallback, account) }
pure def canWriteFallbackFlow(s: Handoff, value: D::FlowValue): bool = s.phase == InvokeOperation and s.kind == BootFallback and D::canReinsertFlow(s.fallback, value)
pure def writeFallbackFlow(s: Handoff, value: D::FlowValue): Handoff = { ...s, fallback: D::reinsertFlow(s.fallback, value) }
pure def canConsumeFallbackFlow(s: Handoff, provider: str, token: str): bool = s.phase == InvokeOperation and s.kind == BootFallback and D::canConsumeFlow(s.fallback, provider, token)
pure def consumeFallbackFlow(s: Handoff, provider: str, token: str): Handoff = { ...s, fallback: D::consumeFlow(s.fallback, provider, token) }
pure def canNextPhase(s: Handoff): bool = s.phase == CopyAccounts and s.accountIndex == s.accountSnapshot.length()
pure def nextPhase(s: Handoff): Handoff = { ...s, phase: CopyFlows }
pure def canCopyAccount(s: Handoff): bool = s.phase == CopyAccounts and s.accountIndex < s.accountSnapshot.length()
pure def copyAccount(s: Handoff): Handoff = { ...s, targets: s.targets.put(s.selectedBackend, D::upsertAccount(targetStore(s), s.accountSnapshot.nthOr(s.accountIndex, A::emptyAccount))), accountIndex: s.accountIndex + 1 }
pure def snapshotFlow(s: Handoff): D::FlowEntry = s.flowSnapshot.nthOr(s.flowIndex, D::noEntry)
pure def canCopyFlow(s: Handoff): bool = s.phase == CopyFlows and s.flowIndex < s.flowSnapshot.length() and (if (s.kind == DatabaseBackend) B::canBeginCreate(s.bridge, snapshotFlow(s).value) else D::canReinsertFlow(targetStore(s), snapshotFlow(s).value))
pure def copyFlow(s: Handoff): Handoff = if (s.kind == DatabaseBackend) { ...s, bridge: B::beginCreate(s.bridge, snapshotFlow(s).value), phase: AwaitBridgeCreate } else { ...s, targets: s.targets.put(s.selectedBackend, D::reinsertFlow(targetStore(s), snapshotFlow(s).value)), phase: if (snapshotFlow(s).consumed) ReplayConsumption else CopyFlows, flowIndex: if (snapshotFlow(s).consumed) s.flowIndex else s.flowIndex + 1 }
```

### Consumption replay treats a null idempotent result according to target state

The source consume API returns null for an already consumed, absent, terminal or expired flow, as well as returning the newly consumed row. Migration ignores that nullable return but propagates thrown I/O failures. The model likewise updates the target only when its pending row is currently consumable; an already consumed row stays consumed. If the database backend lacks its optional consume method, the bridge settles immediately using its process mirror and leaves the durable target unchanged. A thrown transfer leaves all fallback state and every already acknowledged target write intact for a fresh retry.

```quint
pure def canConfigureBridge(s: Handoff): bool = s.phase == HandoffIdle and B::canConfigure(s.bridge)
pure def configureBridge(s: Handoff, methods: B::AdapterMethods): Handoff = { ...s, bridge: B::configure(s.bridge, methods) }
pure def canResolveCreate(s: Handoff, value: D::FlowValue): bool = s.phase == AwaitBridgeCreate and B::canDurableResult(s.bridge) and value.provider == snapshotFlow(s).value.provider and value.id == snapshotFlow(s).value.id and value.token == snapshotFlow(s).value.token
pure def resolveCreate(s: Handoff, value: D::FlowValue, succeeded: bool): Handoff = { ...s, bridge: B::durableResult(s.bridge, true, value, succeeded), targets: if (succeeded) s.targets.put(s.selectedBackend, D::reinsertFlow(D::deleteFlow(targetStore(s), value.provider, value.id), B::durableValue(value))) else s.targets }
pure def canFinishBridgeCreate(s: Handoff): bool = s.phase == AwaitBridgeCreate and (s.bridge.phase == B::BridgeReturned or s.bridge.phase == B::BridgeFailed)
pure def finishBridgeCreate(s: Handoff): Handoff = if (s.bridge.phase == B::BridgeFailed) { ...s, queue: Q::finish(s.queue, s.activeTicket, false), activeTicket: 0, phase: HandoffIdle, failed: true } else { ...s, phase: if (snapshotFlow(s).consumed) ReplayConsumption else CopyFlows, flowIndex: if (snapshotFlow(s).consumed) s.flowIndex else s.flowIndex + 1 }
pure def canReplay(s: Handoff): bool = s.phase == ReplayConsumption
pure def replay(s: Handoff): Handoff = {
  val flow = snapshotFlow(s).value
  if (s.kind == DatabaseBackend) { ...s, bridge: B::beginConsume(s.bridge, flow.provider, flow.token), phase: AwaitBridgeConsume } else { ...s, targets: if (D::canConsumeFlow(targetStore(s), flow.provider, flow.token)) s.targets.put(s.selectedBackend, D::consumeFlow(targetStore(s), flow.provider, flow.token)) else s.targets, flowIndex: s.flowIndex + 1, phase: CopyFlows }
}
pure def canResolveConsumption(s: Handoff): bool = s.phase == AwaitBridgeConsume and B::canDurableResult(s.bridge)
pure def resolveConsumption(s: Handoff, succeeded: bool): Handoff = {
  val flow = snapshotFlow(s).value
  val consumable = D::canConsumeFlow(targetStore(s), flow.provider, flow.token)
  { ...s, bridge: B::durableResult(s.bridge, consumable, D::flowAt(targetStore(s), flow.provider, flow.token), succeeded), targets: if (succeeded and consumable) s.targets.put(s.selectedBackend, D::consumeFlow(targetStore(s), flow.provider, flow.token)) else s.targets }
}
pure def canFinishBridgeConsumption(s: Handoff): bool = s.phase == AwaitBridgeConsume and (s.bridge.phase == B::BridgeReturned or s.bridge.phase == B::BridgeFailed)
pure def finishBridgeConsumption(s: Handoff): Handoff = if (s.bridge.phase == B::BridgeFailed) { ...s, queue: Q::finish(s.queue, s.activeTicket, false), activeTicket: 0, phase: HandoffIdle, failed: true } else { ...s, flowIndex: s.flowIndex + 1, phase: CopyFlows }
pure def canFinishTransfer(s: Handoff): bool = s.phase == CopyFlows and s.accountIndex == s.accountSnapshot.length() and s.flowIndex == s.flowSnapshot.length()
pure def finishTransfer(s: Handoff): Handoff = { ...s, fallback: D::clearMigrated(s.fallback), phase: InvokeOperation }
pure def canTransferFails(s: Handoff): bool = s.phase == CopyAccounts or s.phase == CopyFlows or s.phase == ReplayConsumption
pure def transferFails(s: Handoff): Handoff = { ...s, queue: Q::finish(s.queue, s.activeTicket, false), activeTicket: 0, phase: HandoffIdle, failed: true }
pure def canFinishOperation(s: Handoff): bool = s.phase == InvokeOperation
pure def finishOperation(s: Handoff, success: bool): Handoff = { ...s, queue: Q::finish(s.queue, s.activeTicket, success), activeTicket: 0, phase: HandoffIdle, failed: not(success) }
pure def setClock(s: Handoff, now: int): Handoff = { ...s, fallback: D::setClock(s.fallback, now), bridge: B::setClock(s.bridge, now) }
pure def alwaysQueueSerializesHandoff(s: Handoff): bool = Q::alwaysOneRunningPerScope(s.queue) and Q::alwaysStartedAfterPredecessors(s.queue) and Q::alwaysAllocatedTickets(s.queue) and Q::alwaysCompletedEntrySettled(s.queue) and (s.phase == HandoffIdle or s.queue.entries.some(entry => entry.ticket == s.activeTicket and entry.running))
pure def alwaysSnapshotCursorsBounded(s: Handoff): bool = s.accountIndex >= 0 and s.accountIndex <= s.accountSnapshot.length() and s.flowIndex >= 0 and s.flowIndex <= s.flowSnapshot.length()
pure def stepFailureRetainsFallback(before: Handoff, via: str, after: Handoff): bool = via == "transferFails" implies before.fallback == after.fallback
pure def stepClearRetainsEveryCopiedAccount(before: Handoff, via: str, after: Handoff): bool = via == "finishTransfer" implies before.accountSnapshot.every(account => targetStore(after).accounts.includes(account))
pure def sometimesRetryAfterPartialTransfer(s: Handoff): bool = s.failed and s.fallback.accounts.length() > 0 and targetStore(s).accounts.length() > 0
pure val ticketValues = Set(1, 2, 3)
pure val managerValues = Set("manager1")
pure val providerValues = Set("provider1")
pure val tokenValues = Set("state1")
pure val backendValues = Set("fallback", "database")
pure val accountValues = D::accountValues
pure val methodsValues = B::methodsValues
pure val valueValues: Set[D::FlowValue] = Set({ ...D::emptyFlow, provider: "provider1", id: "flow1", token: "state1", status: D::PendingFlow })
pure val weight_enqueue = 5
pure val weight_beginNextOperation = 5
pure val weight_finishOperation = 5
pure val weight_writeFallbackFlow = 5
pure val weight_consumeFallbackFlow = 5
pure val weight_nextPhase = 4
pure val weight_copyFlow = 4
pure val weight_resolveCreate = 4
pure val weight_finishBridgeCreate = 4
pure val weight_replay = 4
pure val weight_resolveConsumption = 4
pure val weight_finishBridgeConsumption = 4
pure def leadsToTransferSettles(s: Handoff, later: Handoff): bool = (s.phase != HandoffIdle and s.phase != InvokeOperation) implies (later.queue.entries.some(entry => entry.ticket == s.activeTicket and entry.complete) or (later.activeTicket == s.activeTicket and later.phase == InvokeOperation))
pure def leadsToAdmittedOperationSettles(s: Handoff, later: Handoff): bool = s.queue.entries.every(entry => later.queue.entries.some(done => done.ticket == entry.ticket and done.complete))
pure val fair_beginNextOperation = "weak"
pure val fair_finishOperation = "weak"
pure val fair_nextPhase = "weak"
pure val fair_copyAccount = "weak"
pure val fair_copyFlow = "weak"
pure val fair_replay = "weak"
pure val fair_resolveCreate = "weak"
pure val fair_finishBridgeCreate = "weak"
pure val fair_resolveConsumption = "weak"
pure val fair_finishBridgeConsumption = "weak"
pure val fair_finishTransfer = "weak"
pure def sometimesMirrorOnlyConsumeJoins(s: Handoff): bool = s.phase == AwaitBridgeConsume and s.bridge.phase == B::BridgeReturned and not(s.bridge.methods.consume) and s.bridge.hasResult
pure def stepMirrorOnlyConsumePreservesDurableTarget(before: Handoff, via: str, after: Handoff): bool = via == "finishBridgeConsumption" and before.bridge.phase == B::BridgeReturned and not(before.bridge.methods.consume) implies before.targets == after.targets and after.flowIndex == before.flowIndex + 1
```
