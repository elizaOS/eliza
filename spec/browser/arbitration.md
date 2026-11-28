# Website browser arbitration

A host that guides the person through a website has two browser peers: an owned Chromium and the embedded web view, each holding its own task bindings. This spec governs which peer receives the host's task operations. The [interactive task kernel](../core/interactiveTask.md) owns task epochs, the [surface channel](../agent/surfaceChannel.md) owns command delivery, and each browser checks its own bindings and receipts.

## Story: Follow the browser the person can see

> As the person being guided, I want every step to happen in the browser
> on my screen, so that what the guide reads and does matches what I see.

### A trusted owned browser can participate on-device, and the visible WebView is read first

Without a native host only the owned browser is used. A native host requires the embedded view and uses it alone unless the device reports the owned browser as trusted; then both run, the embedded one first, and an owned startup failure leaves the embedded route available. Status and capabilities come from the last selected peer with a connected profile, then the connected owned browser, then the embedded view.

A current-page read checks the embedded view first, and a page from it selects the embedded peer even when the owned browser is connected. Only an absent embedded profile, no page, or an explicit unavailable answer falls back to the owned browser; any other embedded failure propagates and leaves the selection unchanged.

```quint
import numbers as Num from "../core/numbers"
type BrowserPeer = NoPeer | OwnedPeer | EmbeddedPeer | UnreadablePeer
type GuideComposition = OwnedOnly | MissingEmbedded | DualTargets | EmbeddedOnly
type PageRead = PropagateRead | EmbeddedPage | ReadOwned | NoPage
pure def guideComposition(nativeHost: bool, embeddedConstructor: bool, trustValue: str): GuideComposition =
  if (not(nativeHost)) OwnedOnly
  else if (not(embeddedConstructor)) MissingEmbedded
  else if (trustValue == "trusted") DualTargets
  else EmbeddedOnly
pure def activePeer(lastPeer: BrowserPeer, ownedProfile: bool, embeddedProfile: bool): BrowserPeer =
  if (lastPeer == EmbeddedPeer and embeddedProfile) EmbeddedPeer
  else if (ownedProfile) OwnedPeer
  else EmbeddedPeer
type PageRoute = { embeddedProfile: bool, ownedProfile: bool, gotPage: bool, failed: bool, errorKind: str, errorCode: str }
pure def pageRoute(reading: PageRoute): PageRead =
  if (reading.embeddedProfile and reading.failed and reading.errorKind != "UNAVAILABLE" and reading.errorCode != "UNAVAILABLE") PropagateRead
  else if (reading.embeddedProfile and not(reading.failed) and reading.gotPage) EmbeddedPage
  else if (reading.ownedProfile) ReadOwned
  else NoPage
pure def lawNativeOwnedRequiresExactTrust(nativeHost: bool, embeddedConstructor: bool, trustValue: str): bool =
  nativeHost and guideComposition(nativeHost, embeddedConstructor, trustValue) == DualTargets implies trustValue == "trusted" and embeddedConstructor
pure def lawVisibleReadErrorNeverFallsThrough(reading: PageRoute): bool =
  reading.embeddedProfile and reading.failed and reading.errorKind != "UNAVAILABLE" and reading.errorCode != "UNAVAILABLE" implies pageRoute(reading) == PropagateRead
pure def lawVisibleWebViewWins(reading: PageRoute): bool =
  reading.embeddedProfile and not(reading.failed) and reading.gotPage implies pageRoute(reading) == EmbeddedPage
pure val visible: PageRoute = { embeddedProfile: true, ownedProfile: true, gotPage: true, failed: false, errorKind: "", errorCode: "" }
pure val readingValues = Set(visible, { ...visible, gotPage: false }, { ...visible, failed: true, errorKind: "STALE_REF" }, { ...visible, failed: true, errorCode: "UNAVAILABLE" }, { ...visible, embeddedProfile: false }, { ...visible, gotPage: false, ownedProfile: false })
pure val trustValueValues = Set("trusted", "1", "")
pure val lastPeerValues = Set(NoPeer, EmbeddedPeer, OwnedPeer)
```

### An operation uses the target it found before awaiting a visibility read

Bindings are keyed by actor, account, agent, task and epoch. An ordinary operation captures its bound peer, refreshes the visible page, and then goes only to that peer and only while it is still the active one. A read failure propagates; a missing binding or a changed transport is a stale reference. Hide and pause cleanup go to the bound peer without a visibility read and keep the binding. The peer's own scope, lease and observation checks decide whether a command it receives is admissible.

```quint
type OperationRoute = { matchedPeer: BrowserPeer, cleanup: bool, readFailed: bool, observedPeer: BrowserPeer }
type PeerTarget = { peer: BrowserPeer }
type OperationDispatch = StaleRef | PropagateFailure | SendTo(PeerTarget)
pure def operationRoute(command: OperationRoute): OperationDispatch =
  if (command.matchedPeer == NoPeer) StaleRef
  else if (command.cleanup) SendTo({ peer: command.matchedPeer })
  else if (command.readFailed) PropagateFailure
  else if (command.observedPeer != command.matchedPeer) StaleRef
  else SendTo({ peer: command.matchedPeer })
pure def lawDifferentObservedPeerCannotTakeOperation(command: OperationRoute): bool =
  command.matchedPeer != NoPeer and not(command.cleanup or command.readFailed) and command.observedPeer != command.matchedPeer implies operationRoute(command) == StaleRef
pure def lawCleanupKeepsOriginalPeer(command: OperationRoute): bool =
  command.matchedPeer != NoPeer and command.cleanup implies operationRoute(command) == SendTo({ peer: command.matchedPeer })
pure val operationRequest: OperationRoute = { matchedPeer: OwnedPeer, cleanup: false, readFailed: false, observedPeer: OwnedPeer }
pure val commandValues = Set(operationRequest, { ...operationRequest, observedPeer: EmbeddedPeer }, { ...operationRequest, matchedPeer: NoPeer }, { ...operationRequest, readFailed: true }, { ...operationRequest, cleanup: true, observedPeer: EmbeddedPeer })
```

## Story: Keep task binding authority on its original browser

> As the person, I want a task bound to one browser to stay there, so that a
> late reply cannot move it to another.

### A delayed binding response cannot restore a superseded or revoked numeric epoch

A numeric fence accepts only a nonnegative safe integer epoch at least the newest bound epoch and above the newest revoked one. A previous peer for the same key that differs from the active peer stops the bind before the peer is called. After the peer accepts, the fence is checked again before the binding is recorded, so a competing bind or revoke that completed meanwhile wins. A numeric revocation raises the revoked-through epoch before calling any peer, even when every peer refuses.

```quint
type EpochFence = { newestBound: int, revokedThrough: int }
pure val vacantFence: EpochFence = { newestBound: -1, revokedThrough: -1 }
pure def numberedEpoch(epoch: int): bool = epoch >= 0 and epoch <= Num::maxSafeInteger
pure def admitsEpoch(fence: EpochFence, epoch: int): bool = epoch >= fence.newestBound and epoch > fence.revokedThrough
pure def keepsEpoch(fence: EpochFence, epoch: int): bool = epoch == fence.newestBound and epoch > fence.revokedThrough
pure def revokeFence(fence: EpochFence, epoch: int): EpochFence =
  if (epoch > fence.revokedThrough) { ...fence, revokedThrough: epoch } else fence
pure def previousPeerMatches(captured: BrowserPeer, active: BrowserPeer): bool = captured == NoPeer or captured == active
type BindPhase = BindIdle | NeedPage | PeerCall | ReadFailed | WrongPeer | PeerRefused | Overtaken | Bound
type BrowserArbitration = { fence: EpochFence, boundPeer: BrowserPeer, phase: BindPhase, requested: int, previousPeer: BrowserPeer, chosenPeer: BrowserPeer }
pure val initial: BrowserArbitration = { fence: vacantFence, boundPeer: NoPeer, phase: BindIdle, requested: -1, previousPeer: NoPeer, chosenPeer: NoPeer }
pure def canBeginBind(route: BrowserArbitration, epoch: int): bool =
  route.phase != NeedPage and route.phase != PeerCall and numberedEpoch(epoch) and admitsEpoch(route.fence, epoch)
pure def beginBind(route: BrowserArbitration, epoch: int): BrowserArbitration =
  { ...route, phase: NeedPage, requested: epoch, previousPeer: if (epoch == route.fence.newestBound) route.boundPeer else NoPeer, chosenPeer: NoPeer }
pure def canChoosePeer(route: BrowserArbitration): bool = route.phase == NeedPage
pure def choosePeer(route: BrowserArbitration, active: BrowserPeer): BrowserArbitration =
  if (active != OwnedPeer and active != EmbeddedPeer) { ...route, phase: ReadFailed }
  else if (not(previousPeerMatches(route.previousPeer, active))) { ...route, phase: WrongPeer }
  else { ...route, phase: PeerCall, chosenPeer: active }
pure def canFinishBind(route: BrowserArbitration): bool = route.phase == PeerCall
pure def finishBind(route: BrowserArbitration, peerAccepted: bool): BrowserArbitration =
  if (not(peerAccepted)) { ...route, phase: PeerRefused }
  else if (not(admitsEpoch(route.fence, route.requested))) { ...route, phase: Overtaken }
  else { ...route, phase: Bound, boundPeer: route.chosenPeer, fence: { ...route.fence, newestBound: route.requested } }
type CompetingBinding = { epoch: int, capturedPeer: BrowserPeer, settledPeer: BrowserPeer }
pure def canOtherBind(route: BrowserArbitration, competitor: CompetingBinding): bool =
  numberedEpoch(competitor.epoch) and admitsEpoch(route.fence, competitor.epoch) and
  (competitor.settledPeer == OwnedPeer or competitor.settledPeer == EmbeddedPeer) and previousPeerMatches(competitor.capturedPeer, competitor.settledPeer)
pure def otherBind(route: BrowserArbitration, competitor: CompetingBinding): BrowserArbitration =
  { ...route, boundPeer: competitor.settledPeer, fence: { ...route.fence, newestBound: competitor.epoch } }
pure def canRevokeBrowser(route: BrowserArbitration, epoch: int): bool = numberedEpoch(epoch)
pure def revokeBrowser(route: BrowserArbitration, epoch: int): BrowserArbitration = {
  val updated = revokeFence(route.fence, epoch)
  { ...route, fence: updated, boundPeer: if (keepsEpoch(updated, updated.newestBound)) route.boundPeer else NoPeer }
}
pure def stopTargets(route: BrowserArbitration): BrowserArbitration = { ...route, boundPeer: NoPeer }
pure def alwaysRecordedNumericBindingIsCurrent(route: BrowserArbitration): bool =
  route.boundPeer != NoPeer implies route.fence.newestBound >= 0 and keepsEpoch(route.fence, route.fence.newestBound)
pure def alwaysPendingPeerWasChosen(route: BrowserArbitration): bool =
  route.phase == PeerCall implies (route.chosenPeer == OwnedPeer or route.chosenPeer == EmbeddedPeer) and numberedEpoch(route.requested)
pure def alwaysPendingRequestIsNumbered(route: BrowserArbitration): bool = route.phase == NeedPage implies numberedEpoch(route.requested)
pure def stepFencesNeverRegress(before: BrowserArbitration, after: BrowserArbitration): bool =
  after.fence.newestBound >= before.fence.newestBound and after.fence.revokedThrough >= before.fence.revokedThrough
pure def sometimesBoundEmbedded(route: BrowserArbitration): bool = route.phase == Bound and route.boundPeer == EmbeddedPeer
pure def sometimesRevokedDuringPeerCall(route: BrowserArbitration): bool =
  route.phase == Overtaken and route.requested <= route.fence.revokedThrough
pure val epochValues = Set(-1, 0, 1, 2)
pure val activeValues = Set(OwnedPeer, EmbeddedPeer, UnreadablePeer)
pure val competitorValues = Set({ epoch: 0, capturedPeer: NoPeer, settledPeer: OwnedPeer }, { epoch: 1, capturedPeer: NoPeer, settledPeer: EmbeddedPeer }, { epoch: 2, capturedPeer: OwnedPeer, settledPeer: EmbeddedPeer })
```

### Bounded local records and malformed numbers do not substitute for peer authority

A recorded bind refreshes the binding's insertion order. The host holds at most sixteen binding keys and removes the oldest on overflow. A numbered fence write refreshes the task's fence order, retaining at most sixty-four fences. Evicting a fence removes that task's remaining binding entries. Dropping a binding alone retains its fence. Stop clears every binding, preserves fences, asks both peers to stop, and waits for both outcomes without propagating stop failure or fabricating revoke receipts. A pending bind can still settle after stop under the same numeric fence if its peer reports acceptance.

An invalid epoch is sent to the peer for its own decision without creating or moving a numeric fence, and the host's handling of it is never evidence that a peer accepted. After an accepted unnumbered bind the host removes older local bindings, and on an unnumbered revoke it removes older or equal ones before the peer results.

```quint
pure def refreshKey(order: List[str], key: str): List[str] = order.select(held => held != key).append(key)
pure def overflowKey(order: List[str], capacity: int): str =
  if (order.length() > 0 and order.length() > capacity) order.nth(0) else ""
pure def trimBindings(order: List[str], key: str): List[str] = {
  val refreshed = refreshKey(order, key)
  if (refreshed.length() > 16) refreshed.removeAt(0) else refreshed
}
pure def fenceEviction(order: List[str], key: str): str = overflowKey(refreshKey(order, key), 64)
pure def malformedRemovesBinding(revoked: bool, less: bool, equal: bool, peerAccepted: bool): bool =
  if (revoked) less or equal else peerAccepted and less
pure def lawUnacceptedMalformedBindDoesNotRemove(revoked: bool, less: bool, equal: bool): bool =
  not(revoked) implies not(malformedRemovesBinding(revoked, less, equal, false))
pure val orderValues = Set(List(), List("a"), List("a", "b"), List("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"))
pure val keyValues = Set("a", "b", "new")
pure val capacityValues = Set(0, 1, 16, 64)
```

### Revocation keeps the local fence and forwards the peer outcomes

Revoke goes to every peer that reports a profile, owned first, and waits for all of them; with no peer it is a stale reference. A refusal other than stale reference, policy block or gone session wins over any acknowledgement; otherwise the first acknowledgement is returned, and if every peer only reports an unknown binding the first refusal is returned. The caller receives the winning peer's answer unchanged, while the local fence stays raised.

```quint
type RevokePeer = { reached: bool, accepted: bool, kindPresent: bool, kind: str, code: str }
pure def hardRevokeFailure(peer: RevokePeer): bool = {
  val failure = if (peer.kindPresent) peer.kind else peer.code
  peer.reached and not(peer.accepted) and not(Set("STALE_REF", "POLICY_BLOCKED", "SESSION_GONE").contains(failure))
}
type RevokeOutcome = OwnedRefusal | EmbeddedRefusal | OwnedAccepted | EmbeddedAccepted | NoPeerReached
pure def revokeResult(owned: RevokePeer, embedded: RevokePeer): RevokeOutcome =
  if (hardRevokeFailure(owned)) OwnedRefusal
  else if (hardRevokeFailure(embedded)) EmbeddedRefusal
  else if (owned.reached and owned.accepted) OwnedAccepted
  else if (embedded.reached and embedded.accepted) EmbeddedAccepted
  else if (owned.reached) OwnedRefusal
  else if (embedded.reached) EmbeddedRefusal
  else NoPeerReached
pure def lawHardRevokeFailureTakesPrecedence(owned: RevokePeer, embedded: RevokePeer): bool =
  hardRevokeFailure(owned) or hardRevokeFailure(embedded) implies revokeResult(owned, embedded) == OwnedRefusal or revokeResult(owned, embedded) == EmbeddedRefusal
pure def lawRevocationCannotInventAcknowledgement(owned: RevokePeer, embedded: RevokePeer): bool =
  (revokeResult(owned, embedded) == OwnedAccepted implies owned.reached and owned.accepted) and
  (revokeResult(owned, embedded) == EmbeddedAccepted implies embedded.reached and embedded.accepted)
pure val peerAbsent: RevokePeer = { reached: false, accepted: false, kindPresent: false, kind: "", code: "" }
pure val ownedValues = Set(peerAbsent, { ...peerAbsent, reached: true, accepted: true }, { ...peerAbsent, reached: true, kindPresent: true, kind: "POLICY_BLOCKED" }, { ...peerAbsent, reached: true, code: "SESSION_GONE" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME", code: "STALE_REF" }, { ...peerAbsent, reached: true, kindPresent: true, code: "STALE_REF" })
pure val embeddedValues = Set(peerAbsent, { ...peerAbsent, reached: true, accepted: true }, { ...peerAbsent, reached: true, kindPresent: true, kind: "POLICY_BLOCKED" }, { ...peerAbsent, reached: true, code: "SESSION_GONE" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME", code: "STALE_REF" }, { ...peerAbsent, reached: true, kindPresent: true, code: "STALE_REF" })
```
