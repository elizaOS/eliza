# Reentrant turn-event delivery

The synchronous `TurnControllerRegistry.emit` loop and `abortAllTurns` loop in `packages/core/src/runtime/turn-controller.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` can reenter through a telemetry callback. This composition imports the controller identities, adds the JavaScript call stack, and tracks the identity of each room's mutable turn array. It exposes no asynchronous callback execution that the source lacks.

## Story: Finish nested telemetry before resuming its caller

As a subscriber I may register or remove listeners, start a turn or cancel work synchronously from a lifecycle callback. Nested events complete before the parent listener resumes. A global abort observes the captured room-array identities and visits them in insertion order; a newly created array for the same room is not part of that old snapshot.

### A live listener frame owns each synchronous callback invocation

Only the top callback may reenter. Each source emission at this boundary publishes one notice and pushes its
allocated frame. A nested event pushes a frame; the outer callback cannot return until that frame has finished. Ordinary asynchronous turn completion and cleanup run only when the synchronous stack is empty.

The [signal scan](./turnSignalScan.md) advances one controller at a time.
The registry owns the live array and supplies its members at each step. A
native signal callback may reenter before the room scan reaches its next
slot. A global abort captures the room-array identities in insertion order
and delegates each captured array to a separate scan.

```quint
import turnControllers as T from "./turnControllers"
import turnSignalScan as S from "./turnSignalScan"
type EventFrame = {noticeId: int, invoking: bool, listenerGeneration: int}
type GlobalFrame = {groups: List[int], cursor: int, reason: str, abortedRooms: List[str]}
type RoomScan = {group: int, room: str, global: bool, scan: S::ScanFrame}
type RoomAbortReturn = {abortRoom: str, fromGlobal: bool, changedSignal: bool}
type TurnFrame = EventFrameKind(EventFrame) | GlobalFrameKind(GlobalFrame) | CleanupFrameKind({turnId: int}) | RoomScanKind(RoomScan) | RoomAbortReturnKind(RoomAbortReturn)
type RoomGroup = {id: int, room: str, active: bool}
type TurnGroup = {turnId: int, group: int}
type TurnEventStack = {controllers: T::TurnControllers, frames: List[TurnFrame], groups: List[RoomGroup], turnGroups: List[TurnGroup], nextGroup: int}
pure val initial: TurnEventStack = {controllers: T::initial, frames: List(), groups: List(), turnGroups: List(), nextGroup: 1}
pure val turnIdValues = T::turnIdValues
pure val selfIdValues = T::selfIdValues
pure val roomValues = T::roomValues
pure val reasonValues = T::reasonValues
pure val callbackValues = T::callbackValues
pure val errorIdValues = T::errorIdValues
pure val noEventFrame: EventFrame = {noticeId: 0, invoking: false, listenerGeneration: 0}
pure val noGlobalFrame: GlobalFrame = {groups: List(), cursor: 0, reason: "", abortedRooms: List()}
pure val noRoomScan: RoomScan = {group: 0, room: "", global: false, scan: S::emptyFrame}
pure def topFrame(s: TurnEventStack): TurnFrame = s.frames.nthOr(s.frames.length() - 1, EventFrameKind({noticeId: 0, invoking: false, listenerGeneration: 0}))
pure def currentEvent(s: TurnEventStack): EventFrame = {
  val selected = topFrame(s)
  match selected { | EventFrameKind(frame) => {noticeId: frame.noticeId, invoking: frame.invoking, listenerGeneration: frame.listenerGeneration} | _ => noEventFrame }
}
pure def currentGlobal(s: TurnEventStack): GlobalFrame = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => {groups: frame.groups, cursor: frame.cursor, reason: frame.reason, abortedRooms: frame.abortedRooms} | _ => noGlobalFrame }
}
pure def currentRoomScan(s: TurnEventStack): RoomScan = {
  val selected = topFrame(s)
  match selected { | RoomScanKind(frame) => {group: frame.group, room: frame.room, global: frame.global, scan: frame.scan} | _ => noRoomScan }
}
pure def mayReenter(s: TurnEventStack): bool = s.frames.length() == 0 or currentEvent(s).invoking or currentRoomScan(s).scan.notifying > 0
pure def pushNotices(before: T::TurnControllers, after: T::TurnControllers, frames: List[TurnFrame]): List[TurnFrame] = if (after.nextNotice == before.nextNotice) frames else frames.append(EventFrameKind({noticeId: before.nextNotice, invoking: false, listenerGeneration: 0}))
pure def replaceTop(frames: List[TurnFrame], frame: TurnFrame): List[TurnFrame] = frames.removeAt(frames.length() - 1).append(frame)
pure def liveGroup(s: TurnEventStack, room: str): int = s.groups.select(g => g.room == room and g.active).nthOr(0, {id: 0, room: "", active: false}).id
pure def groupOf(s: TurnEventStack, turnId: int): int = s.turnGroups.select(g => g.turnId == turnId).nthOr(0, {turnId: 0, group: 0}).group
pure def roomGroupMembers(s: TurnEventStack, group: int): List[T::TurnEntry] =
  s.controllers.turns.select(t => t.phase != T::TurnDetached and groupOf(s, t.id) == group and group > 0)
pure def scanProjection(s: TurnEventStack, r: RoomScan): S::TurnSignalScan = {
  val members = roomGroupMembers(s, r.group)
  { ...S::initial, turns: members.listMap(t => {turnId: t.id, aborted: t.aborted, reason: t.reason}), frames: List(r.scan) }
}
pure def canStartTurn(s: TurnEventStack, turnId: int, room: str): bool = mayReenter(s) and T::canStartTurn(s.controllers, turnId, room)
pure def startTurn(s: TurnEventStack, turnId: int, room: str): TurnEventStack = {
  val updatedControllers = T::startTurn(s.controllers, turnId, room)
  val group = liveGroup(s, room)
  { ...s, controllers: updatedControllers, frames: pushNotices(s.controllers, updatedControllers, s.frames), groups: if (group == 0) s.groups.append({id: s.nextGroup, room: room, active: true}) else s.groups, turnGroups: s.turnGroups.append({turnId: turnId, group: if (group == 0) s.nextGroup else group}), nextGroup: s.nextGroup + (if (group == 0) 1 else 0) }
}
pure def canReturnTurn(s: TurnEventStack, turnId: int, resolved: bool, errorId: str): bool = s.frames.length() == 0 and T::canReturnTurn(s.controllers, turnId, resolved, errorId)
pure def returnTurn(s: TurnEventStack, turnId: int, resolved: bool, errorId: str): TurnEventStack = {
  val updatedControllers = T::returnTurn(s.controllers, turnId, resolved, errorId)
  { ...s, controllers: updatedControllers, frames: pushNotices(s.controllers, updatedControllers, s.frames.append(CleanupFrameKind({turnId: turnId}))) }
}
pure def cleanupTurnId(s: TurnEventStack): int = {
  val selected = topFrame(s)
  match selected { | CleanupFrameKind(frame) => frame.turnId | _ => 0 }
}
pure def canCleanupTurn(s: TurnEventStack, turnId: int): bool = cleanupTurnId(s) == turnId and T::canCleanupTurn(s.controllers, turnId)
pure def cleanupTurn(s: TurnEventStack, turnId: int): TurnEventStack = {
  val group = groupOf(s, turnId)
  val hasPeer = s.controllers.turns.some(t => t.id != turnId and t.phase != T::TurnDetached and groupOf(s, t.id) == group)
  { ...s, controllers: T::cleanupTurn(s.controllers, turnId), frames: s.frames.removeAt(s.frames.length() - 1), groups: s.groups.listMap(g => if (g.id == group and not(hasPeer)) { ...g, active: false } else g) }
}
pure def canAbortRoom(s: TurnEventStack, room: str, selfId: int, reason: str): bool = mayReenter(s) and selfId >= 0
pure def abortRoom(s: TurnEventStack, room: str, selfId: int, reason: str): TurnEventStack = {
  val scan = { ...S::emptyFrame, scanId: s.frames.length() + 1, excluded: selfId, reason: reason }
  { ...s, frames: s.frames.append(RoomScanKind({group: liveGroup(s, room), room: room, global: false, scan: scan})) }
}
pure def activeGroupIds(s: TurnEventStack): List[int] = s.groups.select(g => g.active).listMap(g => g.id)
pure def canBeginGlobalAbort(s: TurnEventStack, reason: str, close: bool): bool = mayReenter(s)
pure def beginGlobalAbort(s: TurnEventStack, reason: str, close: bool): TurnEventStack = { ...s, controllers: if (close) { ...s.controllers, closed: true, closedReason: reason } else s.controllers, frames: s.frames.append(GlobalFrameKind({groups: activeGroupIds(s), cursor: 0, reason: reason, abortedRooms: List()})) }
pure def canAdvanceGlobalAbort(s: TurnEventStack): bool = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => frame.cursor < frame.groups.length() | _ => false }
}
pure def advanceGlobalAbort(s: TurnEventStack): TurnEventStack = {
  val frame = currentGlobal(s)
  val group = frame.groups.nthOr(frame.cursor, 0)
  val room = s.groups.select(g => g.id == group).nthOr(0, {id: 0, room: "", active: false}).room
  val scan = { ...S::emptyFrame, scanId: s.frames.length() + 1, reason: frame.reason }
  val continued = GlobalFrameKind({groups: frame.groups, cursor: frame.cursor + 1, reason: frame.reason, abortedRooms: frame.abortedRooms})
  { ...s, frames: replaceTop(s.frames, continued).append(RoomScanKind({group: group, room: room, global: true, scan: scan})) }
}
pure def canFinishGlobalAbort(s: TurnEventStack): bool = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => frame.cursor >= frame.groups.length() | _ => false }
}
pure def finishGlobalAbort(s: TurnEventStack): TurnEventStack = { ...s, controllers: { ...s.controllers, lastAbortedRooms: currentGlobal(s).abortedRooms }, frames: s.frames.removeAt(s.frames.length() - 1) }
```

### A room notice follows the last native signal callback

Each scan owns its changed result. A native callback can start a nested
scan and publish nested telemetry. After all visits finish, only a scan
that changed a signal emits an aborted notice. A changed global room
scan adds that room to its own parent frame's result after telemetry
returns. Room-specific callers observe their changed result at the same
boundary.

```quint
pure def canVisitRoomSignal(s: TurnEventStack): bool = {
  val r = currentRoomScan(s)
  r.scan.scanId > 0 and S::canVisitSignalTurn(scanProjection(s, r))
}
pure def visitRoomSignal(s: TurnEventStack): TurnEventStack = {
  val r = currentRoomScan(s)
  val visited = S::topScan(S::visitSignalTurn(scanProjection(s, r)))
  { ...s, controllers: { ...s.controllers, turns: s.controllers.turns.listMap(t =>
      if (visited.notifying != 0 and t.id == visited.notifying and not(t.aborted)) { ...t, aborted: true, reason: visited.reason } else t) },
    frames: replaceTop(s.frames, RoomScanKind({group: r.group, room: r.room, global: r.global, scan: visited})) }
}
pure def canReturnNativeSignal(s: TurnEventStack): bool = {
  val r = currentRoomScan(s)
  r.scan.scanId > 0 and S::canReturnSignalDelivery(scanProjection(s, r))
}
pure def returnNativeSignal(s: TurnEventStack): TurnEventStack = {
  val r = currentRoomScan(s)
  val resumed = S::topScan(S::returnSignalDelivery(scanProjection(s, r)))
  { ...s, frames: replaceTop(s.frames, RoomScanKind({group: r.group, room: r.room, global: r.global, scan: resumed})) }
}
pure def canFinishRoomSignal(s: TurnEventStack): bool = {
  val r = currentRoomScan(s)
  r.scan.scanId > 0 and S::canFinishSignalScan(scanProjection(s, r))
}
pure def finishRoomSignal(s: TurnEventStack): TurnEventStack = {
  val r = currentRoomScan(s)
  val ended = S::finishSignalScan(scanProjection(s, r)).returned.nthOr(0, {scanId: 0, changed: false})
  val frames = replaceTop(s.frames, RoomAbortReturnKind({abortRoom: r.room, fromGlobal: r.global, changedSignal: ended.changed}))
  val controls = { ...s.controllers,
    notices: if (ended.changed) s.controllers.notices.append(T::freshNotice(s.controllers.nextNotice, T::TurnAborted, r.room, r.scan.reason, "", 0)) else s.controllers.notices,
    nextNotice: s.controllers.nextNotice + (if (ended.changed) 1 else 0) }
  { ...s, controllers: controls, frames: pushNotices(s.controllers, controls, frames) }
}
pure def currentAbortReturn(s: TurnEventStack): RoomAbortReturn = {
  val top = topFrame(s)
  match top {
    | RoomAbortReturnKind(r) => {abortRoom: r.abortRoom, fromGlobal: r.fromGlobal, changedSignal: r.changedSignal}
    | _ => {abortRoom: "", fromGlobal: false, changedSignal: false}
  }
}
pure def canReturnRoomAbort(s: TurnEventStack): bool = {
  val top = topFrame(s)
  match top { | RoomAbortReturnKind(_) => true | _ => false }
}
pure def returnRoomAbort(s: TurnEventStack): TurnEventStack = {
  val r = currentAbortReturn(s)
  val remaining = s.frames.removeAt(s.frames.length() - 1)
  val parent = remaining.nthOr(remaining.length() - 1, CleanupFrameKind({turnId: 0}))
  val parents = match parent {
    | GlobalFrameKind(frame) => if (r.fromGlobal and r.changedSignal)
        replaceTop(remaining, GlobalFrameKind({groups: frame.groups, cursor: frame.cursor, reason: frame.reason, abortedRooms: frame.abortedRooms.append(r.abortRoom)}))
      else remaining
    | _ => remaining
  }
  { ...s, controllers: { ...s.controllers,
    lastAbortedRooms: if (r.fromGlobal) s.controllers.lastAbortedRooms else if (r.changedSignal) List(r.abortRoom) else List() }, frames: parents }
}
pure def stepFirstRegistryAbortReasonStays(before: TurnEventStack, after: TurnEventStack): bool =
  T::stepFirstAbortReasonStays(before.controllers, after.controllers)
pure def sometimesNativeAbortStartsNestedRoomScan(s: TurnEventStack): bool =
  currentRoomScan(s).scan.scanId > 0 and
  s.frames.some(f => match f { | RoomScanKind(r) => r.scan.notifying > 0 and r.scan.scanId != currentRoomScan(s).scan.scanId | _ => false })
```

### Listener iteration resumes after nested events and uses the live Set

Discovered by the proof: group and frame identities must stay unique to
preserve owners across callbacks. Each turn retains its captured group,
including after it detaches. While the registry is closed, each active
un-aborted turn belongs to an unvisited group of a global loop or to the
unvisited suffix of a global room scan. Once the scan reaches the end of
its array, that scan cannot own any pending turn.

The cursor advances before invoking a callback. Removing that callback and re-adding it makes a later live Set slot, which can be visited again. Observer exceptions leave the controller state and original operation result intact.

```quint
pure def canSubscribe(s: TurnEventStack, callback: int): bool = mayReenter(s) and T::canSubscribeTurnEvents(s.controllers, callback)
pure def subscribe(s: TurnEventStack, callback: int): TurnEventStack = { ...s, controllers: T::subscribeTurnEvents(s.controllers, callback) }
pure def canUnsubscribe(s: TurnEventStack, callback: int): bool = mayReenter(s)
pure def unsubscribe(s: TurnEventStack, callback: int): TurnEventStack = { ...s, controllers: T::unsubscribeTurnEvents(s.controllers, callback) }
pure def canBeginListener(s: TurnEventStack): bool = currentEvent(s).noticeId != 0 and not(currentEvent(s).invoking) and T::nextTurnListener(s.controllers, currentEvent(s).noticeId).present
pure def beginListener(s: TurnEventStack): TurnEventStack = {
  val frame = currentEvent(s)
  val listener = T::nextTurnListener(s.controllers, frame.noticeId)
  { ...s, controllers: { ...s.controllers, notices: s.controllers.notices.listMap(n => if (n.id == frame.noticeId) { ...n, cursor: listener.generation } else n) }, frames: replaceTop(s.frames, EventFrameKind({noticeId: frame.noticeId, invoking: true, listenerGeneration: listener.generation})) }
}
pure def canEndListener(s: TurnEventStack, ok: bool): bool = currentEvent(s).noticeId != 0 and currentEvent(s).invoking
pure def endListener(s: TurnEventStack, ok: bool): TurnEventStack = {
  val frame = currentEvent(s)
  { ...s, controllers: { ...s.controllers, notices: s.controllers.notices.listMap(n => if (n.id == frame.noticeId) { ...n, delivered: n.delivered.append(frame.listenerGeneration) } else n), listenerErrors: s.controllers.listenerErrors + (if (ok) 0 else 1) }, frames: replaceTop(s.frames, EventFrameKind({noticeId: frame.noticeId, invoking: false, listenerGeneration: 0})) }
}
pure def canFinishEvent(s: TurnEventStack): bool = currentEvent(s).noticeId != 0 and not(currentEvent(s).invoking) and not(T::nextTurnListener(s.controllers, currentEvent(s).noticeId).present)
pure def finishEvent(s: TurnEventStack): TurnEventStack = { ...s, controllers: T::finishTurnNotice(s.controllers, currentEvent(s).noticeId), frames: s.frames.removeAt(s.frames.length() - 1) }
type GlobalGroupCursor = {remaining: int, retained: bool}
pure def groupInSuffix(groups: List[int], cursor: int, group: int): bool = {
  val initialCursor: GlobalGroupCursor = {remaining: cursor, retained: false}
  groups.foldl(initialCursor, (point, id) => {remaining: point.remaining - 1, retained: point.retained or (point.remaining <= 0 and id == group)}).retained
}
pure def frameOwnsPendingTurn(s: TurnEventStack, f: TurnFrame, turnId: int, group: int): bool = match f {
  | GlobalFrameKind(frame) => groupInSuffix(frame.groups, frame.cursor, group)
  | RoomScanKind(r) => r.global and r.group == group and
      groupInSuffix(roomGroupMembers(s, group).listMap(t => t.id), r.scan.cursor, turnId)
  | _ => false
}
pure def alwaysClosedPendingHasGlobalOwner(s: TurnEventStack): bool = s.controllers.closed implies s.controllers.turns.every(t =>
  t.phase == T::TurnDetached or t.aborted or s.frames.some(f => frameOwnsPendingTurn(s, f, t.id, groupOf(s, t.id))))
pure def alwaysControllerIdentitiesValid(s: TurnEventStack): bool = T::alwaysTurnIdentity(s.controllers) and T::alwaysActiveRoomsMatch(s.controllers) and T::alwaysOneLiveListener(s.controllers) and T::alwaysNoticesUnique(s.controllers)
pure def alwaysGroupAllocatorValid(s: TurnEventStack): bool = s.nextGroup > 0 and s.groups.every(g => g.id > 0 and g.id < s.nextGroup and s.groups.select(other => other.id == g.id).length() == 1 and (g.active implies s.groups.select(other => other.active and other.room == g.room).length() == 1))
pure def alwaysTurnsRetainGroups(s: TurnEventStack): bool = s.turnGroups.every(g => s.turnGroups.select(other => other.turnId == g.turnId).length() == 1 and s.controllers.turns.some(t => t.id == g.turnId and s.groups.some(roomGroup => roomGroup.id == g.group and roomGroup.room == t.room))) and s.controllers.turns.every(t => s.turnGroups.some(g => g.turnId == t.id) and s.groups.some(g => g.id == groupOf(s, t.id) and g.room == t.room))
pure def alwaysLiveGroupOwnsTurns(s: TurnEventStack): bool = s.groups.every(g => g.active iff s.controllers.turns.some(t => t.phase != T::TurnDetached and groupOf(s, t.id) == g.id))
pure def noticeFrameMatches(f: TurnFrame, noticeId: int): bool = match f { | EventFrameKind(frame) => frame.noticeId == noticeId | _ => false }
pure def cleanupFrameMatches(f: TurnFrame, turnId: int): bool = match f { | CleanupFrameKind(frame) => frame.turnId == turnId | _ => false }
pure def validRoomScan(s: TurnEventStack, r: RoomScan): bool = {
  val projectedScan = scanProjection(s, r)
  r.scan.scanId > 0 and r.scan.excluded >= 0 and (r.global implies r.scan.excluded == 0) and
    S::alwaysScanCursorValid(projectedScan) and S::alwaysNativeDeliveryOwnsAbortedTurn(projectedScan)
}
pure def validStackFrame(s: TurnEventStack, f: TurnFrame): bool = match f {
  | EventFrameKind(frame) => frame.noticeId > 0 and s.frames.select(other => noticeFrameMatches(other, frame.noticeId)).length() == 1 and s.controllers.notices.some(n => n.id == frame.noticeId and not(n.finished)) and (frame.invoking implies s.controllers.notices.some(n => n.id == frame.noticeId and n.cursor == frame.listenerGeneration))
  | GlobalFrameKind(frame) => frame.cursor >= 0 and frame.cursor <= frame.groups.length()
  | CleanupFrameKind(frame) => frame.turnId > 0 and s.frames.select(other => cleanupFrameMatches(other, frame.turnId)).length() == 1 and s.controllers.turns.some(t => t.id == frame.turnId and t.phase == T::TurnReturned)
  | RoomScanKind(r) => validRoomScan(s, {group: r.group, room: r.room, global: r.global, scan: r.scan})
  | RoomAbortReturnKind(_) => true
}
pure def alwaysFramesRetainNotices(s: TurnEventStack): bool = s.frames.every(f => validStackFrame(s, f))
pure def stepOuterCallbackWaits(before: TurnEventStack, via: str, after: TurnEventStack): bool = via == "endListener" implies before.frames.length() == after.frames.length()
pure def sometimesNestedListenerEmission(s: TurnEventStack): bool = s.frames.select(f => match f { | EventFrameKind(frame) => true | _ => false }).length() > 1
pure def sometimesCapturedOldRoomArray(s: TurnEventStack): bool = s.groups.some(g => not(g.active) and s.groups.some(other => other.room == g.room and other.active and other.id != g.id))
```
