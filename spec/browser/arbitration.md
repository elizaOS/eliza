# Website browser arbitration

A host that guides the person through a website composes two browser peers from the browser package: `native-socket-target.ts` for an owned Chromium and `native-surface-target.ts` for the embedded WebView, with `packages/os/browser/src/task-bindings.mjs` for browser-side authority. This contract governs which of those peers receives the host's task operations. The [interactive task kernel](../core/interactiveTask.md) owns task epochs, the [surface channel](../agent/nativeHost/surfaceChannel.md) owns command delivery, and each browser checks its own bindings and receipts.

## Story: Follow the browser the person can see

> As the person, I want the guide to act in the browser I can see.

### A trusted owned browser can participate on-device, and the visible WebView is read first

Development uses the owned target. The native composition requires the WebView target and uses it alone unless the native layer reports the owned browser as exactly `trusted`. In the dual-target composition, embedded startup runs first and must succeed. Owned startup failure is diagnostic and leaves the embedded route available. Connection presence and visible selection are distinct. Before an observation, status, profile and capabilities delegate to the last selected target with a connected profile, then to the connected owned browser, then to the embedded target.

A current-page read checks the embedded profile first. A page from that profile selects the embedded target, even with a connected owned browser. No embedded profile, a null page, or an explicit `UNAVAILABLE` in either error field permits fallback to a connected owned browser. Any other embedded failure propagates and leaves selection unchanged. The owned read may itself fail or have no page. The routing result below identifies the chosen port and leaves the owned read result to that port.

```quint
pure def guideComposition(nativeHost: bool, embeddedConstructor: bool, trustValue: str): str =
  if (not(nativeHost)) "owned"
  else if (not(embeddedConstructor)) "missing-embedded"
  else if (trustValue == "trusted") "dual"
  else "embedded"
pure def activePeer(lastPeer: str, ownedProfile: bool, embeddedProfile: bool): str =
  if (lastPeer == "embedded" and embeddedProfile) "embedded"
  else if (ownedProfile) "owned"
  else "embedded"
type PageRoute = { embeddedProfile: bool, ownedProfile: bool, gotPage: bool, failed: bool, errorKind: str, errorCode: str }
pure def pageRoute(reading: PageRoute): str =
  if (reading.embeddedProfile and reading.failed and reading.errorKind != "UNAVAILABLE" and reading.errorCode != "UNAVAILABLE") "propagate"
  else if (reading.embeddedProfile and not(reading.failed) and reading.gotPage) "embedded-page"
  else if (reading.ownedProfile) "read-owned"
  else "no-page"
pure def lawNativeOwnedRequiresExactTrust(nativeHost: bool, embeddedConstructor: bool, trustValue: str): bool =
  nativeHost and guideComposition(nativeHost, embeddedConstructor, trustValue) == "dual" implies trustValue == "trusted" and embeddedConstructor
pure def lawVisibleReadErrorNeverFallsThrough(reading: PageRoute): bool =
  reading.embeddedProfile and reading.failed and reading.errorKind != "UNAVAILABLE" and reading.errorCode != "UNAVAILABLE" implies pageRoute(reading) == "propagate"
pure def lawVisibleWebViewWins(reading: PageRoute): bool =
  reading.embeddedProfile and not(reading.failed) and reading.gotPage implies pageRoute(reading) == "embedded-page"
pure val visible: PageRoute = { embeddedProfile: true, ownedProfile: true, gotPage: true, failed: false, errorKind: "", errorCode: "" }
pure val readingValues = Set(visible, { ...visible, gotPage: false }, { ...visible, failed: true, errorKind: "STALE_REF" }, { ...visible, failed: true, errorCode: "UNAVAILABLE" }, { ...visible, embeddedProfile: false }, { ...visible, gotPage: false, ownedProfile: false })
pure val trustValueValues = Set("trusted", "1", "")
pure val lastPeerValues = Set("", "embedded", "owned")
```

### An operation uses the target it found before awaiting a visibility read

The host keys bindings by actor, account, agent, task and epoch. An ordinary operation first captures its bound target. After refreshing the visible page, that operation can go only to the captured target and only if it is still the active target. A read failure propagates. A missing matching binding or a changed transport returns `STALE_REF`. Cleanup guidance of kind `hide` or `pause` goes to the bound target without a visibility read and leaves its binding in place. The host captures the target before awaiting visibility and does not reload the binding map afterwards. A concurrent local revoke may therefore remove the binding before the host sends a command to the captured target. The peer's scope, lease and observation checks determine whether that command is admissible there. These rules model routing rather than the peer's execution receipt.

```quint
type OperationRoute = { matchedPeer: str, cleanup: bool, readFailed: bool, observedPeer: str }
pure def operationRoute(command: OperationRoute): str =
  if (command.matchedPeer == "") "STALE_REF"
  else if (command.cleanup) command.matchedPeer
  else if (command.readFailed) "propagate"
  else if (command.observedPeer != command.matchedPeer) "STALE_REF"
  else command.matchedPeer
pure def lawDifferentObservedPeerCannotTakeOperation(command: OperationRoute): bool =
  command.matchedPeer != "" and not(command.cleanup or command.readFailed) and command.observedPeer != command.matchedPeer implies operationRoute(command) == "STALE_REF"
pure def lawCleanupKeepsOriginalPeer(command: OperationRoute): bool =
  command.matchedPeer != "" and command.cleanup implies operationRoute(command) == command.matchedPeer
pure val operationRequest: OperationRoute = { matchedPeer: "owned", cleanup: false, readFailed: false, observedPeer: "owned" }
pure val commandValues = Set(operationRequest, { ...operationRequest, observedPeer: "embedded" }, { ...operationRequest, matchedPeer: "" }, { ...operationRequest, readFailed: true }, { ...operationRequest, cleanup: true, observedPeer: "embedded" })
```

## Story: Keep task binding authority on its original browser

> As the person, I want a task bound to one browser to stay there, so that a
> late reply cannot move it to another.

### A delayed binding response cannot restore a superseded or revoked numeric epoch

For a safe nonnegative integer epoch, the host checks that it is at least the latest bound epoch and strictly above the last revoked epoch. It then captures any previous target for the exact binding key and awaits a page read. A previous target different from the active target stops before calling the peer. If the peer accepts, the host repeats the numeric fence check before updating the local map. A higher completed bind supersedes older local binds. Revocation records the maximum revoked-through epoch before the peer calls, even when all peers refuse.

The pure fence is the host's verified epoch fence. The machine follows one task identity, one pending numbered bind and any intervening numbered bind, revoke or stop. `otherBind` represents a competing call after its own peer acceptance, with its prior target already captured. Two calls at the same epoch can both capture no previous target during overlap. Acceptance of an earlier reply can then replace the host's same-epoch route even after a different peer's reply was recorded first. The second check only reads the numeric fence. Peer authority, observation and later visibility still apply at dispatch.

```quint
type EpochFence = { newestBound: int, revokedThrough: int }
pure val vacantFence: EpochFence = { newestBound: -1, revokedThrough: -1 }
pure def numberedEpoch(epoch: int): bool = epoch >= 0 and epoch <= 9007199254740991
pure def admitsEpoch(fence: EpochFence, epoch: int): bool = epoch >= fence.newestBound and epoch > fence.revokedThrough
pure def keepsEpoch(fence: EpochFence, epoch: int): bool = epoch == fence.newestBound and epoch > fence.revokedThrough
pure def revokeFence(fence: EpochFence, epoch: int): EpochFence =
  if (epoch > fence.revokedThrough) { ...fence, revokedThrough: epoch } else fence
pure def previousPeerMatches(captured: str, active: str): bool = captured == "" or captured == active
type BrowserArbitration = { fence: EpochFence, boundPeer: str, phase: str, requested: int, previousPeer: str, chosenPeer: str }
pure val initial: BrowserArbitration = { fence: vacantFence, boundPeer: "", phase: "idle", requested: -1, previousPeer: "", chosenPeer: "" }
pure def canBeginBind(route: BrowserArbitration, epoch: int): bool =
  route.phase != "need-page" and route.phase != "peer-call" and numberedEpoch(epoch) and admitsEpoch(route.fence, epoch)
pure def beginBind(route: BrowserArbitration, epoch: int): BrowserArbitration =
  { ...route, phase: "need-page", requested: epoch, previousPeer: if (epoch == route.fence.newestBound) route.boundPeer else "", chosenPeer: "" }
pure def canChoosePeer(route: BrowserArbitration): bool = route.phase == "need-page"
pure def choosePeer(route: BrowserArbitration, active: str): BrowserArbitration =
  if (active != "owned" and active != "embedded") { ...route, phase: "read-failed" }
  else if (not(previousPeerMatches(route.previousPeer, active))) { ...route, phase: "wrong-peer" }
  else { ...route, phase: "peer-call", chosenPeer: active }
pure def canFinishBind(route: BrowserArbitration): bool = route.phase == "peer-call"
pure def finishBind(route: BrowserArbitration, peerAccepted: bool): BrowserArbitration =
  if (not(peerAccepted)) { ...route, phase: "peer-refused" }
  else if (not(admitsEpoch(route.fence, route.requested))) { ...route, phase: "overtaken" }
  else { ...route, phase: "bound", boundPeer: route.chosenPeer, fence: { ...route.fence, newestBound: route.requested } }
type CompetingBinding = { epoch: int, capturedPeer: str, settledPeer: str }
pure def canOtherBind(route: BrowserArbitration, competitor: CompetingBinding): bool =
  numberedEpoch(competitor.epoch) and admitsEpoch(route.fence, competitor.epoch) and
  (competitor.settledPeer == "owned" or competitor.settledPeer == "embedded") and previousPeerMatches(competitor.capturedPeer, competitor.settledPeer)
pure def otherBind(route: BrowserArbitration, competitor: CompetingBinding): BrowserArbitration =
  { ...route, boundPeer: competitor.settledPeer, fence: { ...route.fence, newestBound: competitor.epoch } }
pure def canRevokeBrowser(route: BrowserArbitration, epoch: int): bool = numberedEpoch(epoch)
pure def revokeBrowser(route: BrowserArbitration, epoch: int): BrowserArbitration = {
  val updated = revokeFence(route.fence, epoch)
  { ...route, fence: updated, boundPeer: if (keepsEpoch(updated, updated.newestBound)) route.boundPeer else "" }
}
pure def stopTargets(route: BrowserArbitration): BrowserArbitration = { ...route, boundPeer: "" }
pure def alwaysRecordedNumericBindingIsCurrent(route: BrowserArbitration): bool =
  route.boundPeer != "" implies route.fence.newestBound >= 0 and keepsEpoch(route.fence, route.fence.newestBound)
pure def alwaysPendingPeerWasChosen(route: BrowserArbitration): bool =
  route.phase == "peer-call" implies (route.chosenPeer == "owned" or route.chosenPeer == "embedded") and numberedEpoch(route.requested)
pure def alwaysPendingRequestIsNumbered(route: BrowserArbitration): bool = route.phase == "need-page" implies numberedEpoch(route.requested)
pure def stepFencesNeverRegress(before: BrowserArbitration, after: BrowserArbitration): bool =
  after.fence.newestBound >= before.fence.newestBound and after.fence.revokedThrough >= before.fence.revokedThrough
pure def sometimesBoundEmbedded(route: BrowserArbitration): bool = route.phase == "bound" and route.boundPeer == "embedded"
pure def sometimesRevokedDuringPeerCall(route: BrowserArbitration): bool =
  route.phase == "overtaken" and route.requested <= route.fence.revokedThrough
pure val epochValues = Set(-1, 0, 1, 2)
pure val activeValues = Set("owned", "embedded", "read-error")
pure val competitorValues = Set({ epoch: 0, capturedPeer: "", settledPeer: "owned" }, { epoch: 1, capturedPeer: "", settledPeer: "embedded" }, { epoch: 2, capturedPeer: "owned", settledPeer: "embedded" })
```

### Bounded local records and malformed numbers do not substitute for peer authority

A recorded bind refreshes the binding's insertion order. The host holds at most sixteen binding keys and removes the oldest on overflow. A numbered fence write refreshes the task's fence order, retaining at most sixty-four fences. Evicting a fence removes that task's remaining binding entries. Dropping a binding alone retains its fence. Stop clears every binding, preserves fences, asks both peers to stop, and waits for both outcomes without propagating stop failure or fabricating revoke receipts. A pending bind can still settle after stop under the same numeric fence if its peer reports acceptance. The pinned peers separately end their connections and stale work.

An invalid epoch is sent to the peer for its own decision without creating or moving a numeric fence. For malformed but comparable values, the host's fallback removes older local bindings after an accepted unnumbered bind and removes older or equal local bindings on an unnumbered revoke before peer results. NaN does not compare and positive infinity can remove all finite bindings of the task. The local host's malformed branch must not be used as evidence a peer accepted. The list functions below apply to ordered unique keys from the host maps and the comparison facts come from the JavaScript boundary.

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

The host sends revoke to each target that currently reports a profile, in owned-then-embedded order, and waits for all reached peers. With no peer it returns `STALE_REF`. In the result ordering, a rejection with kind or fallback code outside `STALE_REF`, `POLICY_BLOCKED`, and `SESSION_GONE` wins over any acknowledgement. Otherwise the first fulfilled reply supplies the actual value. If all reached peers only report an unknown binding, return the first refusal. The model names a winning peer and disposition, and the host uses that peer's unchanged value or error. A rejected same-epoch revoke may already have retired the local route while the browser still retains the binding. The caller receives the actual refusal.

```quint
type RevokePeer = { reached: bool, accepted: bool, kindPresent: bool, kind: str, code: str }
pure def hardRevokeFailure(peer: RevokePeer): bool = {
  val failure = if (peer.kindPresent) peer.kind else peer.code
  peer.reached and not(peer.accepted) and not(Set("STALE_REF", "POLICY_BLOCKED", "SESSION_GONE").contains(failure))
}
pure def revokeResult(owned: RevokePeer, embedded: RevokePeer): str =
  if (hardRevokeFailure(owned)) "owned-refusal"
  else if (hardRevokeFailure(embedded)) "embedded-refusal"
  else if (owned.reached and owned.accepted) "owned-accepted"
  else if (embedded.reached and embedded.accepted) "embedded-accepted"
  else if (owned.reached) "owned-refusal"
  else if (embedded.reached) "embedded-refusal"
  else "STALE_REF"
pure def lawHardRevokeFailureTakesPrecedence(owned: RevokePeer, embedded: RevokePeer): bool =
  hardRevokeFailure(owned) or hardRevokeFailure(embedded) implies revokeResult(owned, embedded) == "owned-refusal" or revokeResult(owned, embedded) == "embedded-refusal"
pure def lawRevocationCannotInventAcknowledgement(owned: RevokePeer, embedded: RevokePeer): bool =
  (revokeResult(owned, embedded) == "owned-accepted" implies owned.reached and owned.accepted) and
  (revokeResult(owned, embedded) == "embedded-accepted" implies embedded.reached and embedded.accepted)
pure val peerAbsent: RevokePeer = { reached: false, accepted: false, kindPresent: false, kind: "", code: "" }
pure val ownedValues = Set(peerAbsent, { ...peerAbsent, reached: true, accepted: true }, { ...peerAbsent, reached: true, kindPresent: true, kind: "POLICY_BLOCKED" }, { ...peerAbsent, reached: true, code: "SESSION_GONE" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME", code: "STALE_REF" }, { ...peerAbsent, reached: true, kindPresent: true, code: "STALE_REF" })
pure val embeddedValues = Set(peerAbsent, { ...peerAbsent, reached: true, accepted: true }, { ...peerAbsent, reached: true, kindPresent: true, kind: "POLICY_BLOCKED" }, { ...peerAbsent, reached: true, code: "SESSION_GONE" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME" }, { ...peerAbsent, reached: true, kindPresent: true, kind: "UNCERTAIN_OUTCOME", code: "STALE_REF" }, { ...peerAbsent, reached: true, kindPresent: true, code: "STALE_REF" })
```
