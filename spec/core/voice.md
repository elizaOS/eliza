# Voice cancellation and speech contracts

The owner is `voice-cancellation-token.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Each token preserves its run,
optional inference slot, first reason, native signal, external-link disposer
and listener identities. Speech generation and playback remain host effects.
[The room registry](./voiceRegistry.md) composes these tokens.

## Story: Interrupt one voice turn across its consumers

As a speaker, I want the first cancellation reason to reach planning,
inference and playback. Callbacks may unsubscribe peers, subscribe again,
throw or reenter cancellation. Their snapshot delivery remains ordered.

### Reason ownership precedes unlinking and signal abortion follows callbacks

The token's `aborted` getter follows its reason immediately. Its native
`signal.aborted` remains false while cancellation callbacks run. A linked
signal is removed before the listener snapshot is taken. An already-aborted
link produces a fully aborted token during construction. An old disposer
removes the same function identity, including a later registration of it;
it does not remove a peer from an already captured snapshot.

Callback frames below expose synchronous reentrancy. Invocation records
are observation history, not another owner of cancellation state. Public
callback IDs are positive; the internal registry-cleanup callback has its
own identity namespace and cannot be selected by a public disposer.
Completion means the synchronous callback return, including a return of a
promise: this source never awaits listener promises. Later asynchronous
work is outside this synchronous fanout and cannot delay native abortion.

```quint
type CancelReason = Active | BargeIn | EotRevoked | UserCancel | Timeout | External
type VoicePhase = Unconstructed | Listening | Unlinking | Snapshotting | DeliveringCallbacks | AbortingSignal | VoiceDone
type VoiceOptions = { runId: str, hasSlot: bool, slot: int, linked: bool, alreadyAborted: bool }
type VoiceListener = { id: int, internal: bool }
type VoiceDisposer = { id: int, listener: int, removes: bool, returned: bool }
type VoiceCall = { id: int, listener: VoiceListener, handle: int, signalAtEntry: bool, complete: bool, failed: bool }
type VoiceToken = { runId: str, hasSlot: bool, slot: int, phase: VoicePhase, reason: CancelReason, listeners: List[VoiceListener], pending: List[VoiceListener], calls: List[VoiceCall], stack: List[int], nextCall: int, handles: List[VoiceDisposer], nextHandle: int, linkInstalled: bool, unlinkOwned: bool, externalAborted: bool, signalAborted: bool }
pure val emptyListener: VoiceListener = { id: 0, internal: true }
pure val emptyVoiceCall: VoiceCall = { id: 0, listener: emptyListener, handle: 0, signalAtEntry: false, complete: true, failed: false }
pure val initial: VoiceToken = { runId: "", hasSlot: false, slot: 0, phase: Unconstructed, reason: Active, listeners: List(), pending: List(), calls: List(), stack: List(), nextCall: 1, handles: List(), nextHandle: 1, linkInstalled: false, unlinkOwned: false, externalAborted: false, signalAborted: false }
pure def canCreateToken(v: VoiceToken, options: VoiceOptions): bool = v.phase == Unconstructed
pure def createToken(v: VoiceToken, options: VoiceOptions): VoiceToken = { ...v, runId: options.runId, hasSlot: options.hasSlot, slot: options.slot, phase: if (options.linked and options.alreadyAborted) VoiceDone else Listening, reason: if (options.linked and options.alreadyAborted) External else Active, signalAborted: options.linked and options.alreadyAborted, externalAborted: options.linked and options.alreadyAborted, linkInstalled: options.linked and not(options.alreadyAborted), unlinkOwned: options.linked and not(options.alreadyAborted) }
pure def canAbort(v: VoiceToken, reason: CancelReason): bool = v.phase != Unconstructed and reason != Active
pure def abort(v: VoiceToken, reason: CancelReason): VoiceToken = if (v.reason == Active) { ...v, reason: reason, phase: Unlinking } else v
pure def canExternalAbort(v: VoiceToken): bool = v.linkInstalled and not(v.externalAborted)
pure def externalAbort(v: VoiceToken): VoiceToken = { ...abort(v, External), externalAborted: true, linkInstalled: false }
pure def canUnlink(v: VoiceToken): bool = v.phase == Unlinking
pure def unlink(v: VoiceToken): VoiceToken = { ...v, linkInstalled: false, unlinkOwned: false, phase: Snapshotting }
pure def canSnapshotListeners(v: VoiceToken): bool = v.phase == Snapshotting
pure def snapshotListeners(v: VoiceToken): VoiceToken = { ...v, pending: v.listeners, phase: DeliveringCallbacks }
pure def invokeListener(listener: VoiceListener, handle: int, v: VoiceToken): VoiceToken = { ...v, calls: v.calls.append({ id: v.nextCall, listener: listener, handle: handle, signalAtEntry: v.signalAborted, complete: false, failed: false }), stack: v.stack.append(v.nextCall), nextCall: v.nextCall + 1 }
pure def callAt(v: VoiceToken, callId: int): VoiceCall = v.calls.select(callback => callback.id == callId).nthOr(0, emptyVoiceCall)
pure def topCall(v: VoiceToken): VoiceCall = callAt(v, v.stack.nthOr(v.stack.length() - 1, 0))
pure def addListener(v: VoiceToken, listener: VoiceListener): List[VoiceListener] = if (v.listeners.includes(listener)) v.listeners else v.listeners.append(listener)
pure def canSubscribe(v: VoiceToken, listenerId: int): bool = v.phase != Unconstructed and listenerId > 0
pure def subscribe(v: VoiceToken, listenerId: int): VoiceToken = {
  val listener = { id: listenerId, internal: false }
  val withHandle = { ...v, handles: v.handles.append({ id: v.nextHandle, listener: listenerId, removes: v.reason == Active, returned: v.reason == Active }), nextHandle: v.nextHandle + 1 }
  if (v.reason == Active) { ...withHandle, listeners: addListener(v, listener) } else invokeListener(listener, v.nextHandle, withHandle)
}
pure def canSubscribeCleanup(v: VoiceToken): bool = v.phase != Unconstructed
pure def subscribeCleanup(v: VoiceToken): VoiceToken = if (v.reason == Active) { ...v, listeners: addListener(v, emptyListener) } else invokeListener(emptyListener, 0, v)
pure def canDisposeListener(v: VoiceToken, handleId: int): bool = v.handles.some(handle => handle.id == handleId and handle.returned)
pure def disposeListener(v: VoiceToken, handleId: int): VoiceToken = {
  val removes = v.handles.some(handle => handle.id == handleId and handle.removes)
  val listenerId = v.handles.select(handle => handle.id == handleId).nthOr(0, { id: 0, listener: 0, removes: false, returned: false }).listener
  { ...v, listeners: if (removes) v.listeners.select(listener => listener.internal or listener.id != listenerId) else v.listeners }
}
pure def canDeliverNext(v: VoiceToken): bool = v.phase == DeliveringCallbacks and v.pending.length() > 0 and v.stack.length() == 0
pure def deliverNext(v: VoiceToken): VoiceToken = { ...invokeListener(v.pending.nthOr(0, emptyListener), 0, v), pending: v.pending.removeAt(0) }
pure def canFinishCallback(v: VoiceToken, successful: bool): bool = v.stack.length() > 0
pure def finishCallback(v: VoiceToken, successful: bool): VoiceToken = {
  val callback = topCall(v)
  { ...v, stack: v.stack.removeAt(v.stack.length() - 1), calls: v.calls.listMap(record => if (record.id == callback.id) { ...record, complete: true, failed: not(successful) } else record), handles: v.handles.listMap(handle => if (handle.id == callback.handle) { ...handle, returned: true } else handle) }
}
pure def canClearListeners(v: VoiceToken): bool = v.phase == DeliveringCallbacks and v.pending.length() == 0 and v.stack.length() == 0
pure def clearListeners(v: VoiceToken): VoiceToken = { ...v, listeners: List(), phase: AbortingSignal }
pure def canAbortSignal(v: VoiceToken): bool = v.phase == AbortingSignal and v.stack.length() == 0
pure def abortSignal(v: VoiceToken): VoiceToken = { ...v, signalAborted: true, phase: VoiceDone }
pure val optionsValues = Set({ runId: "turn", hasSlot: false, slot: 0, linked: false, alreadyAborted: false }, { runId: "turn", hasSlot: true, slot: 1, linked: true, alreadyAborted: false }, { runId: "turn", hasSlot: false, slot: 0, linked: true, alreadyAborted: true })
pure val listenerIdValues = Set(1, 2)
pure val handleIdValues = Set(1, 2, 3)
pure def alwaysFirstReasonOwnsSignal(v: VoiceToken): bool = (v.reason == Active) == (v.phase == Listening or v.phase == Unconstructed) and (v.signalAborted == (v.phase == VoiceDone))
pure def alwaysDoneReleasesResources(v: VoiceToken): bool = v.phase == VoiceDone implies v.listeners.length() == 0 and v.pending.length() == 0 and not(v.linkInstalled) and not(v.unlinkOwned)
pure def alwaysUnlinkedBeforeFanout(v: VoiceToken): bool = (v.phase == DeliveringCallbacks or v.phase == AbortingSignal or v.phase == VoiceDone) implies not(v.linkInstalled) and not(v.unlinkOwned)
pure def alwaysListenerIdentity(v: VoiceToken): bool = v.listeners.every(listener => v.listeners.select(other => other == listener).length() == 1 and (listener.internal or listener.id > 0))
pure def alwaysCallIdentity(v: VoiceToken): bool = v.nextCall > 0 and v.calls.every(callback => callback.id > 0 and callback.id < v.nextCall and v.calls.select(other => other.id == callback.id).length() == 1) and v.stack.every(callId => v.calls.some(callback => callback.id == callId and not(callback.complete)))
pure def alwaysStackIdentity(v: VoiceToken): bool = v.stack.every(callId => v.stack.select(other => other == callId).length() == 1)
pure def alwaysUnconstructedEmpty(v: VoiceToken): bool = v.phase == Unconstructed implies v.listeners.length() == 0 and v.pending.length() == 0 and v.calls.length() == 0 and v.stack.length() == 0 and v.handles.length() == 0 and not(v.linkInstalled) and not(v.unlinkOwned)
pure def alwaysHandleIdentity(v: VoiceToken): bool = v.nextHandle > 0 and v.handles.every(handle => handle.id > 0 and handle.id < v.nextHandle and handle.listener > 0 and v.handles.select(other => other.id == handle.id).length() == 1)
pure def stepFirstReasonWins(before: VoiceToken, after: VoiceToken): bool = before.reason != Active implies before.reason == after.reason
pure def stepSignalNeverReopens(before: VoiceToken, after: VoiceToken): bool = before.signalAborted implies after.signalAborted
pure def sometimesCallbacksObserveReasonBeforeSignal(v: VoiceToken): bool = v.reason != Active and not(v.signalAborted) and v.stack.length() > 0
pure def sometimesCallbackThrows(v: VoiceToken): bool = v.calls.some(callback => callback.failed)
pure def sometimesNestedLateCallback(v: VoiceToken): bool = v.stack.length() > 1
pure def sometimesExternalLinkRemoved(v: VoiceToken): bool = v.reason != Active and not(v.unlinkOwned)
```

### Internal handoffs retain their completed cleanup

Discovered by the proof: a fabricated snapshot-ready state could still own
an external listener, and a signal-ready state could still retain pending
listeners. The source reaches these handoffs only after unlinking and
clearing have completed.

```quint
pure def alwaysSnapshotFollowsUnlink(v: VoiceToken): bool = v.phase == Snapshotting implies not(v.linkInstalled) and not(v.unlinkOwned)
pure def alwaysSignalFollowsClear(v: VoiceToken): bool = v.phase == AbortingSignal implies v.listeners.length() == 0 and v.pending.length() == 0
```
