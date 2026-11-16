# Plugin registration epochs

Each registration epoch retains its own lifecycle. A name can be registered again after its previous epoch retires. Sources include [plugin-lifecycle.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/plugin-lifecycle.ts) and [PluginLifecycle.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/PluginLifecycle.qnt).

## Story: Retry and reload plugins without losing epoch ownership

As a host I join concurrent registration of one name, allow unrelated names to progress independently and distinguish a new registration after cleanup.

### A name has at most one active registration epoch

Every new epoch has a fresh identity. Concurrent callers join the active registering epoch and observe its shared result.

```quint
import plugins as P from "./plugins"
type PluginEpoch = { id: int, name: str, lifecycle: P::PluginState }
type PluginEpochs = { epochs: List[PluginEpoch], nextEpoch: int }
pure val initial: PluginEpochs = { epochs: List(), nextEpoch: 1 }
pure val nameValues = Set("plugin-a", "plugin-b")
pure val epochIdValues = Set(1, 2, 3)
pure val absentEpoch: PluginEpoch = {id: 0, name: "", lifecycle: P::initial}
pure def epoch(s: PluginEpochs, epochId: int): PluginEpoch = s.epochs.select(e => e.id == epochId).nthOr(0, absentEpoch)
pure def activePhase(phase: P::PluginPhase): bool = phase == P::Registering or phase == P::Loaded or phase == P::RollingBack or phase == P::Unloading
pure def canBeginPlugin(s: PluginEpochs, name: str, adapter: bool): bool = name != "" and not(s.epochs.some(e => e.name == name and activePhase(e.lifecycle.phase)))
pure def beginPlugin(s: PluginEpochs, name: str, adapter: bool): PluginEpochs = { ...s, epochs: s.epochs.append({id: s.nextEpoch, name: name, lifecycle: P::beginRegistration(P::initial, adapter)}), nextEpoch: s.nextEpoch + 1 }
pure def canJoinPlugin(s: PluginEpochs, epochId: int): bool = P::canJoinRegistration(epoch(s, epochId).lifecycle)
pure def joinPlugin(s: PluginEpochs, epochId: int): PluginEpochs = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::joinRegistration(e.lifecycle) } else e) }
pure def canCommitPlugin(s: PluginEpochs, epochId: int): bool = P::canCommitRegistration(epoch(s, epochId).lifecycle)
pure def commitPlugin(s: PluginEpochs, epochId: int): PluginEpochs = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::commitRegistration(e.lifecycle) } else e) }
pure def canFailPlugin(s: PluginEpochs, epochId: int): bool = P::canFailRegistration(epoch(s, epochId).lifecycle)
pure def failPlugin(s: PluginEpochs, epochId: int): PluginEpochs = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::failRegistration(e.lifecycle) } else e) }
pure def alwaysEpochIdentityUnique(s: PluginEpochs): bool = s.nextEpoch > 0 and s.epochs.every(e => e.id > 0 and e.id < s.nextEpoch and s.epochs.select(other => other.id == e.id).length() == 1)
pure def alwaysOneActiveEpochPerName(s: PluginEpochs): bool = s.epochs.every(e => activePhase(e.lifecycle.phase) implies s.epochs.select(other => other.name == e.name and activePhase(other.lifecycle.phase)).length() == 1)
pure def alwaysEpochOutcomeHonest(s: PluginEpochs): bool = s.epochs.every(e => P::alwaysRegistrationOutcomeAgrees(e.lifecycle) and P::alwaysOneDispose(e.lifecycle) and P::alwaysCleanedHasNoContributions(e.lifecycle) and P::alwaysServiceStopsOnce(e.lifecycle) and P::alwaysConnectorWithdrawalFollowsDisposal(e.lifecycle))
pure def sometimesIndependentPluginLoads(s: PluginEpochs): bool = s.epochs.some(a => s.epochs.some(b => a.name != b.name and a.lifecycle.phase == P::Loaded and b.lifecycle.phase == P::Registering))
```

### A retired epoch cannot mutate a replacement epoch

Cleanup completion is scoped to the captured epoch identity. A failed registration can be retried after its cleanup finishes.

```quint
pure def canUnloadPlugin(s: PluginEpochs, epochId: int): bool = P::canBeginUnload(epoch(s, epochId).lifecycle)
pure def unloadPlugin(s: PluginEpochs, epochId: int): PluginEpochs = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::beginUnload(e.lifecycle) } else e) }
pure def canDisposePlugin(s: PluginEpochs, epochId: int, ok: bool): bool = P::canFinishDispose(epoch(s, epochId).lifecycle, ok)
pure def disposePlugin(s: PluginEpochs, epochId: int, ok: bool): PluginEpochs = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::finishDispose(e.lifecycle, ok) } else e) }
pure def canCleanPlugin(s: PluginEpochs, epochId: int): bool = P::canFinishCleanup(epoch(s, epochId).lifecycle)
pure def cleanPlugin(s: PluginEpochs, epochId: int): PluginEpochs = { ...s, epochs: s.epochs.listMap(e => if (e.id == epochId) { ...e, lifecycle: P::finishCleanup(e.lifecycle) } else e) }
pure def sometimesFailedRegistrationRetried(s: PluginEpochs): bool = s.epochs.some(a => a.lifecycle.phase == P::RegistrationFailed and s.epochs.some(b => a.name == b.name and b.id > a.id and b.lifecycle.phase == P::Registering))
pure def sometimesPluginReloaded(s: PluginEpochs): bool = s.epochs.some(a => a.lifecycle.phase == P::Unloaded and s.epochs.some(b => a.name == b.name and b.id > a.id and b.lifecycle.phase == P::Loaded))
```

### Connector publication follows the captured owner's withdrawal fence

Send-handler, message-connector and post-connector publication use the same
captured owner gate. An owner reference names its original registration epoch,
even after a same-name reload or a change to the service class-owner map.
While that owner awaits disposal, its captured callbacks can still publish.
The disposal continuation fences only that exact owner before connector
removal and service teardown. A withdrawn callback returns before either
the original registry operation or its ownership claim can run.

The adapter assigns each actual captured ownership reference to its retained
registration epoch. Only references established by that identity mapping are
admitted captured-owner observations. An unassigned numeric reference receives
the model boundary's `BlockPublication` validation result. The adapter maps
absent capture and capture from a different runtime to `UnownedCall`, which
delegates. Disposal and configuration callbacks inherit
their caller's ambient capture as their publication owner. The three
publication flavors delegate their existing registry behavior and collision
policies after this gate.
Connector removal has its own outcome. A traversal failure can retain an
existing registry entry while the owner's publication gate remains closed.

```quint
type ConnectorCapture = UnownedCall | CapturedOwner({epochId: int})
type ConnectorPublication = SendHandlerPublication | MessageConnectorPublication | PostConnectorPublication
type ConnectorPublicationDecision = DelegatePublication | BlockPublication
pure val captureValues = Set(UnownedCall, CapturedOwner({epochId: 1}), CapturedOwner({epochId: 2}), CapturedOwner({epochId: 3}))
pure val publicationValues = Set(SendHandlerPublication, MessageConnectorPublication, PostConnectorPublication)
pure def connectorPublicationDecision(s: PluginEpochs, capture: ConnectorCapture, publication: ConnectorPublication): ConnectorPublicationDecision = {
  val captured = match capture { | UnownedCall => absentEpoch | CapturedOwner(owner) => epoch(s, owner.epochId) }
  match capture {
    | UnownedCall => DelegatePublication
    | CapturedOwner(owner) => if (owner.epochId > 0 and captured.id == owner.epochId and P::canOwnConnector(captured.lifecycle)) DelegatePublication else BlockPublication
  }
}
pure def lawUnownedConnectorPublicationDelegates(s: PluginEpochs, publication: ConnectorPublication): bool =
  connectorPublicationDecision(s, UnownedCall, publication) == DelegatePublication
pure def lawWithdrawnConnectorOwnerIsBlocked(s: PluginEpochs, epochId: int, publication: ConnectorPublication): bool = {
  val captured = epoch(s, epochId)
  epochId > 0 and captured.id == epochId and captured.lifecycle.connectorsWithdrawn implies
    connectorPublicationDecision(s, CapturedOwner({epochId: epochId}), publication) == BlockPublication
}
pure def lawOpenConnectorOwnerDelegates(s: PluginEpochs, epochId: int, publication: ConnectorPublication): bool = {
  val captured = epoch(s, epochId)
  epochId > 0 and captured.id == epochId and captured.lifecycle.phase != P::Absent and not(captured.lifecycle.connectorsWithdrawn) implies
    connectorPublicationDecision(s, CapturedOwner({epochId: epochId}), publication) == DelegatePublication
}
pure def lawConnectorPublicationFlavorsShareTheOwnerGate(s: PluginEpochs, capture: ConnectorCapture): bool =
  connectorPublicationDecision(s, capture, SendHandlerPublication) == connectorPublicationDecision(s, capture, MessageConnectorPublication) and
  connectorPublicationDecision(s, capture, MessageConnectorPublication) == connectorPublicationDecision(s, capture, PostConnectorPublication)
pure def lawDisposeContinuationBlocksItsCapturedOwner(s: PluginEpochs, epochId: int, ok: bool, publication: ConnectorPublication): bool =
  alwaysEpochIdentityUnique(s) and epochId > 0 and canDisposePlugin(s, epochId, ok) implies
    connectorPublicationDecision(disposePlugin(s, epochId, ok), CapturedOwner({epochId: epochId}), publication) == BlockPublication
pure def lawDisposalKeepsOtherCapturedOwners(s: PluginEpochs, epochId: int, otherId: int, ok: bool, publication: ConnectorPublication): bool =
  alwaysEpochIdentityUnique(s) and epochId != otherId implies
    connectorPublicationDecision(disposePlugin(s, epochId, ok), CapturedOwner({epochId: otherId}), publication) == connectorPublicationDecision(s, CapturedOwner({epochId: otherId}), publication)
```

### Resource ownership remains with active registration epochs

Only registering or loaded epochs admit new owned classes. Retiring epochs continue to own their original resources until cleanup completes.

```quint
pure def epochDisposalFinished(s: PluginEpochs, epochId: int): bool = epoch(s, epochId).id != 0 and not(epoch(s, epochId).lifecycle.disposePending)
pure def epochAdmitsClass(s: PluginEpochs, epochId: int): bool = epoch(s, epochId).lifecycle.phase == P::Registering or epoch(s, epochId).lifecycle.phase == P::Loaded
pure def epochOwnsResources(s: PluginEpochs, epochId: int): bool = epoch(s, epochId).id != 0 and activePhase(epoch(s, epochId).lifecycle.phase)
pure def epochRetiring(s: PluginEpochs, epochId: int): bool = epoch(s, epochId).lifecycle.phase == P::RollingBack or epoch(s, epochId).lifecycle.phase == P::Unloading
pure def epochOperationSettled(s: PluginEpochs, epochId: int): bool = epoch(s, epochId).id != 0 and not(epoch(s, epochId).lifecycle.phase == P::Registering or epochRetiring(s, epochId))
```
