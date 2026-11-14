# Voice cancellation registry

Source `voice-cancellation-token.ts` retains one current token identity per
room. This owner embeds [concrete tokens](./voice.md); it does not keep a
second cancellation-reason map. Room order follows insertion order. The
call stack exposes synchronous reentry through token callbacks.

## Story: Replace and cancel the active voice turn by room

As a host, I cancel the captured previous token before constructing and
publishing a replacement. A callback may reenter the registry. The outer
call subsequently resumes with its original captured objects. Cleanup
removes a binding only while it still refers to that exact token.

### Captured calls retain token identity through callbacks and publication

A root caller enters when no registry call is pending. A callback can
enter a nested call only while it is the top callback and is not already
waiting for a registry call. Such a callback cannot finish before its
nested call returns. `clear` drops bindings without aborting tokens.
Bulk abort snapshots room/token pairs in insertion order; later arms are
not added to that snapshot. A room is returned as affected only after its
captured live token's abort finishes.

```quint
import voice as V from "./voice"
type VoiceArmOptions = { room: str, config: V::VoiceOptions }
type VoiceEntry = { room: str, token: V::VoiceToken }
type VoiceBinding = { room: str, tokenId: int }
type RegistryCallKind = ArmOperation | AbortOneOperation | AbortAllOperation
type RegistryCallPhase = NeedPrevious | WaitPrevious | CreateToken | PublishToken | AttachCallback | ReturnCall | VisitSnapshot | WaitSnapshot
type RegistryCall = { kind: RegistryCallKind, phase: RegistryCallPhase, parentToken: int, parentCall: int, room: str, previous: int, created: int, runId: str, hasSlot: bool, slot: int, linked: bool, alreadyAborted: bool, reason: V::CancelReason, pending: List[VoiceBinding], affected: List[str] }
type VoiceRegistry = { serial: int, ids: Set[int], tokens: int -> VoiceEntry, bindings: List[VoiceBinding], calls: List[RegistryCall], returnedTokens: List[int], returnedBulk: List[List[str]], returnedAbort: List[bool] }
pure val emptyEntry: VoiceEntry = { room: "", token: V::initial }
pure val emptyCall: RegistryCall = { kind: ArmOperation, phase: NeedPrevious, parentToken: 0, parentCall: 0, room: "", previous: 0, created: 0, runId: "", hasSlot: false, slot: 0, linked: false, alreadyAborted: false, reason: V::External, pending: List(), affected: List() }
pure val initial: VoiceRegistry = { serial: 0, ids: Set(), tokens: Map(), bindings: List(), calls: List(), returnedTokens: List(), returnedBulk: List(), returnedAbort: List() }
pure def tokenAt(r: VoiceRegistry, tokenId: int): VoiceEntry = if (r.ids.contains(tokenId)) r.tokens.getOr(tokenId, emptyEntry) else emptyEntry
pure def activeId(r: VoiceRegistry, room: str): int = r.bindings.select(binding => binding.room == room).nthOr(0, { room: room, tokenId: 0 }).tokenId
pure def currentCall(r: VoiceRegistry): RegistryCall = r.calls.nthOr(r.calls.length() - 1, emptyCall)
pure def updatedTop(r: VoiceRegistry, frame: RegistryCall): List[RegistryCall] = r.calls.removeAt(r.calls.length() - 1).append(frame)
pure def updatedBindings(r: VoiceRegistry, room: str, tokenId: int): List[VoiceBinding] = if (r.bindings.some(entry => entry.room == room)) r.bindings.listMap(entry => if (entry.room == room) { ...entry, tokenId: tokenId } else entry) else r.bindings.append({ room: room, tokenId: tokenId })
pure def updatedToken(r: VoiceRegistry, tokenId: int, token: V::VoiceToken): int -> VoiceEntry = r.tokens.put(tokenId, { ...tokenAt(r, tokenId), token: token })
pure def callbackBlocked(r: VoiceRegistry, tokenId: int, callId: int): bool = r.calls.some(frame => frame.parentToken == tokenId and frame.parentCall == callId)
pure def callerReady(r: VoiceRegistry, parentToken: int, parentCall: int): bool =
  if (parentToken == 0) parentCall == 0 and r.calls.length() == 0 and r.ids.forall(tokenId => tokenAt(r, tokenId).token.stack.length() == 0)
  else r.ids.contains(parentToken) and V::topCall(tokenAt(r, parentToken).token).id == parentCall and parentCall > 0 and not(V::topCall(tokenAt(r, parentToken).token).listener.internal) and not(callbackBlocked(r, parentToken, parentCall))
pure def canBeginArm(r: VoiceRegistry, options: VoiceArmOptions, parentToken: int, parentCall: int): bool = callerReady(r, parentToken, parentCall)
pure def beginArm(r: VoiceRegistry, options: VoiceArmOptions, parentToken: int, parentCall: int): VoiceRegistry = { ...r, calls: r.calls.append({ ...emptyCall, room: options.room, previous: activeId(r, options.room), runId: options.config.runId, hasSlot: options.config.hasSlot, slot: options.config.slot, linked: options.config.linked, alreadyAborted: options.config.alreadyAborted, parentToken: parentToken, parentCall: parentCall }) }
pure def canBeginRoomAbort(r: VoiceRegistry, room: str, reason: V::CancelReason, parentToken: int, parentCall: int): bool = callerReady(r, parentToken, parentCall) and reason != V::Active
pure def beginRoomAbort(r: VoiceRegistry, room: str, reason: V::CancelReason, parentToken: int, parentCall: int): VoiceRegistry = { ...r, calls: r.calls.append({ ...emptyCall, kind: AbortOneOperation, room: room, previous: activeId(r, room), reason: reason, parentToken: parentToken, parentCall: parentCall }) }
pure def canBeginAbortAll(r: VoiceRegistry, reason: V::CancelReason, parentToken: int, parentCall: int): bool = reason != V::Active and callerReady(r, parentToken, parentCall)
pure def beginAbortAll(r: VoiceRegistry, reason: V::CancelReason, parentToken: int, parentCall: int): VoiceRegistry = { ...r, calls: r.calls.append({ ...emptyCall, kind: AbortAllOperation, phase: VisitSnapshot, reason: reason, pending: r.bindings, parentToken: parentToken, parentCall: parentCall }) }
pure def canAdvanceRegistryCall(r: VoiceRegistry): bool = r.calls.length() > 0 and
  (currentCall(r).phase != WaitPrevious or tokenAt(r, currentCall(r).previous).token.signalAborted) and
  (currentCall(r).phase != WaitSnapshot or tokenAt(r, currentCall(r).previous).token.signalAborted) and
  (currentCall(r).phase != ReturnCall or currentCall(r).created == 0 or tokenAt(r, currentCall(r).created).token.stack.length() == 0)
pure def advanceRegistryCall(r: VoiceRegistry): VoiceRegistry = {
  val frame = currentCall(r)
  val previous = tokenAt(r, frame.previous).token
  val binding = frame.pending.nthOr(0, { room: "", tokenId: 0 })
  val shouldAbortPrevious = frame.previous != 0 and previous.reason == V::Active
  val captured = tokenAt(r, binding.tokenId).token
  val shouldAbortSnapshot = captured.reason == V::Active
  if (frame.phase == NeedPrevious) {
    { ...r, tokens: if (shouldAbortPrevious) updatedToken(r, frame.previous, V::abort(previous, frame.reason)) else r.tokens, calls: updatedTop(r, { ...frame, phase: if (shouldAbortPrevious) WaitPrevious else if (frame.kind == ArmOperation) CreateToken else ReturnCall, affected: if (shouldAbortPrevious and frame.kind == AbortOneOperation) List(frame.room) else frame.affected }) }
  } else if (frame.phase == WaitPrevious) { ...r, calls: updatedTop(r, { ...frame, phase: if (frame.kind == ArmOperation) CreateToken else ReturnCall }) }
  else if (frame.phase == CreateToken) { ...r, serial: r.serial + 1, ids: r.ids.union(Set(r.serial + 1)), tokens: r.tokens.put(r.serial + 1, { room: frame.room, token: V::createToken(V::initial, { runId: frame.runId, hasSlot: frame.hasSlot, slot: frame.slot, linked: frame.linked, alreadyAborted: frame.alreadyAborted }) }), calls: updatedTop(r, { ...frame, created: r.serial + 1, phase: PublishToken }) }
  else if (frame.phase == PublishToken) { ...r, bindings: updatedBindings(r, frame.room, frame.created), calls: updatedTop(r, { ...frame, phase: AttachCallback }) }
  else if (frame.phase == AttachCallback) { ...r, tokens: updatedToken(r, frame.created, V::subscribeCleanup(tokenAt(r, frame.created).token)), calls: updatedTop(r, { ...frame, phase: ReturnCall }) }
  else if (frame.phase == VisitSnapshot and frame.pending.length() > 0) {
    { ...r, tokens: if (shouldAbortSnapshot) updatedToken(r, binding.tokenId, V::abort(captured, frame.reason)) else r.tokens, calls: updatedTop(r, { ...frame, pending: frame.pending.removeAt(0), previous: if (shouldAbortSnapshot) binding.tokenId else 0, room: binding.room, phase: if (shouldAbortSnapshot) WaitSnapshot else VisitSnapshot }) }
  } else if (frame.phase == WaitSnapshot) { ...r, calls: updatedTop(r, { ...frame, previous: 0, affected: frame.affected.append(frame.room), phase: VisitSnapshot }) }
  else if (frame.phase == VisitSnapshot) { ...r, calls: updatedTop(r, { ...frame, phase: ReturnCall }) }
  else { ...r, calls: r.calls.removeAt(r.calls.length() - 1), returnedTokens: if (frame.kind == ArmOperation) r.returnedTokens.append(frame.created) else r.returnedTokens, returnedBulk: if (frame.kind == AbortAllOperation) r.returnedBulk.append(frame.affected) else r.returnedBulk, returnedAbort: if (frame.kind == AbortOneOperation) r.returnedAbort.append(frame.affected.length() > 0) else r.returnedAbort }
}
pure def canUnlinkToken(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and V::canUnlink(tokenAt(r, tokenId).token)
pure def unlinkToken(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::unlink(tokenAt(r, tokenId).token)) }
pure def canSnapshotToken(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and V::canSnapshotListeners(tokenAt(r, tokenId).token)
pure def snapshotToken(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::snapshotListeners(tokenAt(r, tokenId).token)) }
pure def canDeliverTokenCallback(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and V::canDeliverNext(tokenAt(r, tokenId).token)
pure def deliverTokenCallback(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::deliverNext(tokenAt(r, tokenId).token)) }
pure def canFinishUserCallback(r: VoiceRegistry, tokenId: int, successful: bool): bool = r.ids.contains(tokenId) and V::canFinishCallback(tokenAt(r, tokenId).token, successful) and not(V::topCall(tokenAt(r, tokenId).token).listener.internal) and not(callbackBlocked(r, tokenId, V::topCall(tokenAt(r, tokenId).token).id))
pure def finishUserCallback(r: VoiceRegistry, tokenId: int, successful: bool): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::finishCallback(tokenAt(r, tokenId).token, successful)) }
pure def canRunCleanupCallback(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and tokenAt(r, tokenId).token.stack.length() > 0 and V::topCall(tokenAt(r, tokenId).token).listener.internal
pure def runCleanupCallback(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, bindings: r.bindings.select(binding => binding.tokenId != tokenId), tokens: updatedToken(r, tokenId, V::finishCallback(tokenAt(r, tokenId).token, true)) }
pure def canClearTokenListeners(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and V::canClearListeners(tokenAt(r, tokenId).token)
pure def clearTokenListeners(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::clearListeners(tokenAt(r, tokenId).token)) }
pure def canAbortTokenSignal(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and V::canAbortSignal(tokenAt(r, tokenId).token)
pure def abortTokenSignal(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::abortSignal(tokenAt(r, tokenId).token)) }
pure def canSubscribeUser(r: VoiceRegistry, tokenId: int, listenerId: int): bool = r.ids.contains(tokenId) and r.returnedTokens.includes(tokenId) and V::canSubscribe(tokenAt(r, tokenId).token, listenerId)
pure def subscribeUser(r: VoiceRegistry, tokenId: int, listenerId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::subscribe(tokenAt(r, tokenId).token, listenerId)) }
pure def canDisposeUser(r: VoiceRegistry, tokenId: int, handleId: int): bool = r.ids.contains(tokenId) and r.returnedTokens.includes(tokenId) and V::canDisposeListener(tokenAt(r, tokenId).token, handleId)
pure def disposeUser(r: VoiceRegistry, tokenId: int, handleId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::disposeListener(tokenAt(r, tokenId).token, handleId)) }
pure def canExternalTokenAbort(r: VoiceRegistry, tokenId: int): bool = r.ids.contains(tokenId) and V::canExternalAbort(tokenAt(r, tokenId).token)
pure def externalTokenAbort(r: VoiceRegistry, tokenId: int): VoiceRegistry = { ...r, tokens: updatedToken(r, tokenId, V::externalAbort(tokenAt(r, tokenId).token)) }
pure def clearRegistry(r: VoiceRegistry): VoiceRegistry = { ...r, bindings: List() }
pure val optionsValues = Set({ room: "room", config: { runId: "turn", hasSlot: false, slot: 0, linked: false, alreadyAborted: false } }, { room: "peer", config: { runId: "turn", hasSlot: true, slot: 1, linked: true, alreadyAborted: false } }, { room: "room", config: { runId: "turn", hasSlot: false, slot: 0, linked: true, alreadyAborted: true } })
pure val tokenIdValues = Set(1, 2, 3)
pure val parentTokenValues = Set(0, 1, 2)
pure val parentCallValues = Set(0, 1, 2)
pure def activeRoomIds(r: VoiceRegistry): List[str] = r.bindings.select(binding => tokenAt(r, binding.tokenId).token.reason == V::Active).listMap(binding => binding.room)
pure def tokenValid(token: V::VoiceToken): bool = V::alwaysFirstReasonOwnsSignal(token) and V::alwaysDoneReleasesResources(token) and V::alwaysUnlinkedBeforeFanout(token) and V::alwaysListenerIdentity(token) and V::alwaysCallIdentity(token) and V::alwaysStackIdentity(token) and V::alwaysUnconstructedEmpty(token) and V::alwaysHandleIdentity(token) and V::alwaysSnapshotFollowsUnlink(token) and V::alwaysSignalFollowsClear(token)
pure def alwaysTokensOwned(r: VoiceRegistry): bool = r.serial >= 0 and r.ids.forall(tokenId => tokenId > 0 and tokenId <= r.serial and tokenValid(tokenAt(r, tokenId).token))
pure def alwaysBindingOwnership(r: VoiceRegistry): bool = r.bindings.every(binding => r.ids.contains(binding.tokenId) and tokenAt(r, binding.tokenId).room == binding.room and r.bindings.select(other => other.room == binding.room).length() == 1)
pure def alwaysCallStages(r: VoiceRegistry): bool = r.calls.every(frame =>
  ((frame.phase == WaitPrevious or frame.phase == WaitSnapshot) implies frame.previous > 0) and
  ((frame.phase == PublishToken or frame.phase == AttachCallback or (frame.phase == ReturnCall and frame.kind == ArmOperation)) implies frame.created > 0) and
  ((frame.phase == VisitSnapshot or frame.phase == WaitSnapshot) implies frame.kind == AbortAllOperation) and
  ((frame.phase == CreateToken or frame.phase == PublishToken or frame.phase == AttachCallback) implies frame.kind == ArmOperation) and
  frame.pending.every(binding => r.ids.contains(binding.tokenId) and tokenAt(r, binding.tokenId).room == binding.room))
pure def alwaysAllocatedTokensConstructed(r: VoiceRegistry): bool = r.ids.forall(tokenId => tokenAt(r, tokenId).token.phase != V::Unconstructed)
pure def alwaysReturnedTokensExist(r: VoiceRegistry): bool = r.returnedTokens.every(tokenId => r.ids.contains(tokenId))
pure def alwaysCapturedTokensExist(r: VoiceRegistry): bool = r.calls.every(frame => (frame.previous == 0 or r.ids.contains(frame.previous)) and (frame.created == 0 or r.ids.contains(frame.created)))
pure def stepClearRetainsTokens(before: VoiceRegistry, via: str, after: VoiceRegistry): bool = via == "clearRegistry" implies after.tokens == before.tokens and after.bindings.length() == 0
pure def sometimesRegistryReturnsToken(r: VoiceRegistry): bool = r.returnedTokens.length() > 0
pure def sometimesNestedRegistryCall(r: VoiceRegistry): bool = r.calls.length() > 1
pure def sometimesBulkAbortReturns(r: VoiceRegistry): bool = r.returnedBulk.some(rooms => rooms.length() > 0)
```

### A captured operation retains its kind and owned room

Discovered by the proof: a fabricated arm frame could point its created
identity at another room, or a bulk frame could enter an arm-only phase.
Call construction fixes the operation kind, non-active reason and created
room before these handoffs become possible. Only an arm operation can own
a newly created token; bulk traversal may subsequently change its current
room without carrying an unrelated created identity.

```quint
pure def alwaysCallKindsAndReason(r: VoiceRegistry): bool = r.calls.every(frame => frame.reason != V::Active and (frame.kind != ArmOperation implies frame.created == 0) and
  (frame.kind == AbortAllOperation implies frame.phase == VisitSnapshot or frame.phase == WaitSnapshot or frame.phase == ReturnCall) and
  (frame.kind == AbortOneOperation implies frame.phase == NeedPrevious or frame.phase == WaitPrevious or frame.phase == ReturnCall) and
  (frame.kind == ArmOperation implies frame.reason == V::External and (frame.phase == NeedPrevious or frame.phase == WaitPrevious or frame.phase == CreateToken or frame.phase == PublishToken or frame.phase == AttachCallback or frame.phase == ReturnCall)))
pure def alwaysCreatedTokenKeepsRoom(r: VoiceRegistry): bool = r.calls.every(frame => frame.created == 0 or tokenAt(r, frame.created).room == frame.room)
pure def validRegistryFrame(r: VoiceRegistry, frame: RegistryCall): bool = alwaysCapturedTokensExist({ ...r, calls: List(frame) }) and alwaysCallStages({ ...r, calls: List(frame) }) and alwaysCallKindsAndReason({ ...r, calls: List(frame) }) and alwaysCreatedTokenKeepsRoom({ ...r, calls: List(frame) })
```
