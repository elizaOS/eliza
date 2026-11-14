# Alpha renderer update admission

`apps/app/src/main.tsx` calls the projected Eliza
`packages/ui/src/state/app-update-gate.ts` before mounting a new Android
WebView and subscribes after mount. `supportsAppUpdateStartup` probes the
native `AlphaDevice` plugin headers for the exact `updateState` method.
Older hosts without that method can mount. Any advertised native update
journal must respond. The [native install journal](../mobileOta.md) owns
physical package staging, installation and activation.

## Story: Keep editors safe while a confirmed app activation owns input

### A pending activation retains its bridge and a matching terminal or idle receipt releases it

The first valid pending result claims the bridge for that gate. A later
activation may take its place on the same bridge. Another bridge, an
unreadable result, or a different terminal ID cannot release an active
gate. A native idle receipt on the same bridge can release it. The
startup gate returns normally on a valid non-pending result when it has
not yet captured an activation. A mounted renderer keeps its editors
alive and freezes input while it prepares. An automatic attempt still
needs settled editors. A pause offers Continue only when the journal
explicitly permits it. A continued call owns its binding while busy.

```quint
type GateKind = NewPage | MountedPage
pure val mountedKind: GateKind = MountedPage
type UpdatePhase = Preparing | Paused
type Report = Installed | Canceled | Failed | NoTerminal
type Binding = { bridge: int, activation: int }
type PendingUpdate = { binding: Binding, phase: UpdatePhase, automatic: bool, resumable: bool }
type ReleaseReceipt = { binding: Binding, idle: bool, terminal: Report, resume: bool }
type UpdateGate = { kind: GateKind, supported: bool, active: bool, pending: PendingUpdate, panel: bool, mayContinue: bool, continuing: bool, gateOpen: bool, prepared: Binding, attempt: Binding, acknowledged: Binding, readiness: bool, refused: bool, reconnect: bool }
pure val noBinding: Binding = { bridge: 0, activation: 0 }
pure val noPending: PendingUpdate = { binding: noBinding, phase: Paused, automatic: false, resumable: false }
pure val initial: UpdateGate = { kind: NewPage, supported: true, active: false, pending: noPending, panel: false, mayContinue: false, continuing: false, gateOpen: false, prepared: noBinding, attempt: noBinding, acknowledged: noBinding, readiness: false, refused: false, reconnect: false }
pure def validBinding(binding: Binding): bool = binding.bridge > 0 and binding.activation > 0
pure def canObservePending(s: UpdateGate, incoming: PendingUpdate): bool = s.supported and validBinding(incoming.binding) and (s.kind == MountedPage or not(s.gateOpen))
pure def observePending(s: UpdateGate, incoming: PendingUpdate, panelShown: bool): UpdateGate = {
  val sameBridge = not(s.active) or incoming.binding.bridge == s.pending.binding.bridge
  val needsPrepare = incoming.phase == Preparing and incoming.binding != s.attempt
  if (not(sameBridge)) { ...s, panel: true, mayContinue: false }
  else { ...s, active: true, gateOpen: false, pending: incoming, panel: panelShown or s.kind == NewPage,
    mayContinue: (panelShown or s.kind == NewPage) and incoming.phase == Paused and incoming.resumable,
    attempt: if (needsPrepare) incoming.binding else s.attempt,
    prepared: if (needsPrepare and (s.kind == NewPage or panelShown)) incoming.binding else if (needsPrepare) noBinding else s.prepared,
    acknowledged: if (needsPrepare) noBinding else s.acknowledged,
    readiness: if (needsPrepare) false else s.readiness, refused: if (needsPrepare) false else s.refused, reconnect: false }
}
pure def canObserveUncertain(s: UpdateGate): bool = s.supported and not(s.gateOpen)
pure def observeUncertain(s: UpdateGate): UpdateGate = if (s.kind == NewPage) { ...s, panel: true, mayContinue: false } else s
pure def canContinueUpdate(s: UpdateGate): bool = s.active and s.mayContinue and not(s.continuing)
pure def continueUpdate(s: UpdateGate): UpdateGate = { ...s, continuing: true }
pure def canContinueFinished(s: UpdateGate): bool = s.continuing
pure def continueFinished(s: UpdateGate): UpdateGate = { ...s, continuing: false }
pure def canRelease(s: UpdateGate, receipt: ReleaseReceipt): bool =
  s.supported and receipt.binding.bridge > 0 and (s.kind == MountedPage or not(s.gateOpen))
pure def release(s: UpdateGate, receipt: ReleaseReceipt): UpdateGate = {
  val matching = s.active and receipt.binding == s.pending.binding and receipt.terminal != NoTerminal
  val sameBridge = s.active and receipt.binding.bridge == s.pending.binding.bridge
  val clear = (not(s.active) and s.kind == NewPage) or (sameBridge and (matching or receipt.idle))
  val reconnect = s.kind == MountedPage and matching and receipt.terminal == Canceled and receipt.resume and s.readiness and s.acknowledged == receipt.binding
  if (clear) { ...s, active: false, pending: noPending, gateOpen: true, panel: false, mayContinue: false, reconnect: reconnect }
  else if (s.kind == NewPage) { ...s, panel: true, mayContinue: false }
  else s
}
pure val incomingValues = Set(
  { binding: { bridge: 1, activation: 1 }, phase: Preparing, automatic: false, resumable: false },
  { binding: { bridge: 1, activation: 1 }, phase: Paused, automatic: false, resumable: true },
  { binding: { bridge: 1, activation: 2 }, phase: Preparing, automatic: true, resumable: false },
  { binding: { bridge: 2, activation: 1 }, phase: Paused, automatic: false, resumable: true }
)
pure val receiptValues = Set(
  { binding: { bridge: 1, activation: 1 }, idle: false, terminal: Installed, resume: false },
  { binding: { bridge: 1, activation: 1 }, idle: false, terminal: Canceled, resume: true },
  { binding: { bridge: 1, activation: 2 }, idle: false, terminal: Failed, resume: false },
  { binding: { bridge: 1, activation: 0 }, idle: true, terminal: NoTerminal, resume: false },
  { binding: { bridge: 2, activation: 1 }, idle: true, terminal: Installed, resume: false }
)
pure def alwaysOpenHasReleasedInput(s: UpdateGate): bool = s.gateOpen implies not(s.active or s.panel or s.mayContinue)
pure def alwaysActiveHasExactBinding(s: UpdateGate): bool = s.active implies validBinding(s.pending.binding)
pure def alwaysContinueIsAdvertised(s: UpdateGate): bool = s.mayContinue implies s.active and s.panel and s.pending.phase == Paused and s.pending.resumable
pure def stepActiveGateKeepsItsBridge(before: UpdateGate, after: UpdateGate): bool =
  before.active and after.active implies before.pending.binding.bridge == after.pending.binding.bridge
pure def lawDifferentBridgeCannotRelease(s: UpdateGate, receipt: ReleaseReceipt): bool =
  s.active and receipt.binding.bridge != s.pending.binding.bridge implies release(s, receipt).active
pure def sometimesHoldsBeforeMount(s: UpdateGate): bool = s.kind == NewPage and s.active and not(s.gateOpen)
pure def sometimesContinues(s: UpdateGate): bool = s.continuing
```

### Acknowledgement requires the current preparation and a mounted page only reconnects after its exact cancellation

The startup gate has no mounted editors to settle. The mounted guard
sends ready only once for its latest preparing activation, after the
panel froze input and editor-specific drafts reached durable or restored
custody. A failure to freeze or prepare sends a negative acknowledgement.
If a newer activation, a pause, or a terminal receipt retires the
preparation, its completion reports nothing. Receiving a canceled receipt
can run the captured reconnect callback only with the exact activation and
an explicit resume bit. A native idle receipt alone never reconnects.
Source checks asynchronous editor preparation and session-restoration
callbacks at their existing boundaries. Acknowledgement delivery failure
can change later readback but does not repeat acknowledgement for the
current activation. If a different activation is observed and then the old
one is presented again, source compares the latest attempted identity.

```quint
pure def canMount(s: UpdateGate): bool = s.kind == NewPage and s.gateOpen
pure def mount(s: UpdateGate): UpdateGate = { ...initial, kind: mountedKind, supported: s.supported, gateOpen: true }
pure def canOlderHost(s: UpdateGate): bool = s.kind == NewPage and not(s.active or s.gateOpen)
pure def olderHost(s: UpdateGate): UpdateGate = { ...s, supported: false, gateOpen: true, panel: false }
pure def canPrepared(s: UpdateGate, binding: Binding): bool =
  s.active and s.pending.phase == Preparing and validBinding(binding) and binding == s.pending.binding and binding == s.attempt and s.acknowledged != binding
pure def prepared(s: UpdateGate, binding: Binding, editorsSettled: bool): UpdateGate = {
  val ready = s.kind == NewPage or (s.prepared == binding and editorsSettled)
  { ...s, acknowledged: binding, readiness: ready, refused: not(ready) }
}
pure val bindingValues = Set({ bridge: 1, activation: 1 }, { bridge: 1, activation: 2 }, { bridge: 2, activation: 1 })
pure def alwaysAcceptedReadyHasBinding(s: UpdateGate): bool =
  s.readiness implies validBinding(s.acknowledged) and s.acknowledged == s.attempt and not(s.refused)
pure def alwaysReconnectOnlyAfterRelease(s: UpdateGate): bool = s.reconnect implies s.gateOpen and s.kind == MountedPage and s.readiness
pure def stepOnlyPreparedCallbackAcknowledges(before: UpdateGate, via: str, after: UpdateGate): bool =
  after.acknowledged != noBinding and before.acknowledged != after.acknowledged implies via == "prepared" and before.active and before.pending.phase == Preparing and after.acknowledged == before.pending.binding
pure def sometimesRendererReconnected(s: UpdateGate): bool = s.reconnect
pure def sometimesMountedPreparationRefused(s: UpdateGate): bool = s.refused and s.kind == MountedPage
```
