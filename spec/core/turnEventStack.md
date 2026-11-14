# Reentrant turn-event delivery

The synchronous `TurnControllerRegistry.emit` loop and `abortAllTurns` loop in `packages/core/src/runtime/turn-controller.ts` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` can reenter through a telemetry callback. This composition imports the controller identities, adds the JavaScript call stack, and tracks the identity of each room's mutable turn array. It exposes no asynchronous callback execution that the source lacks.

## Story: Finish nested telemetry before resuming its caller

As a subscriber I may register or remove listeners, start a turn or cancel work synchronously from a lifecycle callback. Nested events complete before the parent listener resumes. A global abort observes the captured room-array identities and visits them in insertion order; a newly created array for the same room is not part of that old snapshot.

### A live listener frame owns each synchronous callback invocation

Only the top callback may reenter. Each source emission at this boundary publishes one notice and pushes its
allocated frame. A nested event pushes a frame; the outer callback cannot return until that frame has finished. Ordinary asynchronous turn completion and cleanup run only when the synchronous stack is empty.

```quint
import turnControllers as T from "./turnControllers"
type EventFrame = {noticeId: int, invoking: bool, listenerGeneration: int}
type GlobalFrame = {groups: List[int], cursor: int, reason: str, abortedRooms: List[str]}
type TurnFrame = EventFrameKind(EventFrame) | GlobalFrameKind(GlobalFrame) | CleanupFrameKind({turnId: int})
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
pure def topFrame(s: TurnEventStack): TurnFrame = s.frames.nthOr(s.frames.length() - 1, EventFrameKind({noticeId: 0, invoking: false, listenerGeneration: 0}))
pure def currentEvent(s: TurnEventStack): EventFrame = {
  val selected = topFrame(s)
  match selected { | EventFrameKind(frame) => {noticeId: frame.noticeId, invoking: frame.invoking, listenerGeneration: frame.listenerGeneration} | _ => noEventFrame }
}
pure def currentGlobal(s: TurnEventStack): GlobalFrame = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => {groups: frame.groups, cursor: frame.cursor, reason: frame.reason, abortedRooms: frame.abortedRooms} | _ => noGlobalFrame }
}
pure def mayReenter(s: TurnEventStack): bool = s.frames.length() == 0 or currentEvent(s).invoking
pure def pushNotices(before: T::TurnControllers, after: T::TurnControllers, frames: List[TurnFrame]): List[TurnFrame] = if (after.nextNotice == before.nextNotice) frames else frames.append(EventFrameKind({noticeId: before.nextNotice, invoking: false, listenerGeneration: 0}))
pure def replaceTop(frames: List[TurnFrame], frame: TurnFrame): List[TurnFrame] = frames.removeAt(frames.length() - 1).append(frame)
pure def liveGroup(s: TurnEventStack, room: str): int = s.groups.select(g => g.room == room and g.active).nthOr(0, {id: 0, room: "", active: false}).id
pure def groupOf(s: TurnEventStack, turnId: int): int = s.turnGroups.select(g => g.turnId == turnId).nthOr(0, {turnId: 0, group: 0}).group
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
pure def canAbortRoom(s: TurnEventStack, room: str, selfId: int, reason: str): bool = mayReenter(s)
pure def abortRoom(s: TurnEventStack, room: str, selfId: int, reason: str): TurnEventStack = {
  val updatedControllers = T::abortRoom(s.controllers, room, selfId, reason)
  { ...s, controllers: updatedControllers, frames: pushNotices(s.controllers, updatedControllers, s.frames) }
}
pure def canBeginGlobalAbort(s: TurnEventStack, reason: str, close: bool): bool = mayReenter(s)
pure def beginGlobalAbort(s: TurnEventStack, reason: str, close: bool): TurnEventStack = { ...s, controllers: if (close) { ...s.controllers, closed: true, closedReason: reason } else s.controllers, frames: s.frames.append(GlobalFrameKind({groups: s.groups.select(g => g.active).listMap(g => g.id), cursor: 0, reason: reason, abortedRooms: List()})) }
pure def canAdvanceGlobalAbort(s: TurnEventStack): bool = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => frame.cursor < frame.groups.length() | _ => false }
}
pure def advanceGlobalAbort(s: TurnEventStack): TurnEventStack = {
  val frame = currentGlobal(s)
  val group = frame.groups.nthOr(frame.cursor, 0)
  val targets = s.controllers.turns.select(t => t.phase != T::TurnDetached and not(t.aborted) and groupOf(s, t.id) == group)
  val room = s.groups.select(g => g.id == group).nthOr(0, {id: 0, room: "", active: false}).room
  val updatedControllers = { ...s.controllers, turns: s.controllers.turns.listMap(t => if (targets.some(target => target.id == t.id)) { ...t, aborted: true, reason: frame.reason } else t), notices: if (targets.length() > 0) s.controllers.notices.append(T::freshNotice(s.controllers.nextNotice, T::TurnAborted, room, frame.reason, "", 0)) else s.controllers.notices, nextNotice: s.controllers.nextNotice + (if (targets.length() > 0) 1 else 0) }
  { ...s, controllers: updatedControllers, frames: pushNotices(s.controllers, updatedControllers, replaceTop(s.frames, GlobalFrameKind({groups: frame.groups, reason: frame.reason, cursor: frame.cursor + 1, abortedRooms: if (targets.length() > 0) frame.abortedRooms.append(room) else frame.abortedRooms }))) }
}
pure def canFinishGlobalAbort(s: TurnEventStack): bool = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => frame.cursor >= frame.groups.length() | _ => false }
}
pure def finishGlobalAbort(s: TurnEventStack): TurnEventStack = { ...s, controllers: { ...s.controllers, lastAbortedRooms: currentGlobal(s).abortedRooms }, frames: s.frames.removeAt(s.frames.length() - 1) }
```

### Listener iteration resumes after nested events and uses the live Set

Discovered by the proof. Active group and event-frame identities remain unique.
Each turn retains its captured group, including after it detaches.

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
pure def alwaysControllerIdentitiesValid(s: TurnEventStack): bool = T::alwaysTurnIdentity(s.controllers) and T::alwaysActiveRoomsMatch(s.controllers) and T::alwaysOneLiveListener(s.controllers) and T::alwaysNoticesUnique(s.controllers)
pure def alwaysGroupAllocatorValid(s: TurnEventStack): bool = s.nextGroup > 0 and s.groups.every(g => g.id > 0 and g.id < s.nextGroup and s.groups.select(other => other.id == g.id).length() == 1 and (g.active implies s.groups.select(other => other.active and other.room == g.room).length() == 1))
pure def alwaysTurnsRetainGroups(s: TurnEventStack): bool = s.turnGroups.every(g => s.turnGroups.select(other => other.turnId == g.turnId).length() == 1 and s.controllers.turns.some(t => t.id == g.turnId and s.groups.some(roomGroup => roomGroup.id == g.group and roomGroup.room == t.room))) and s.controllers.turns.every(t => s.turnGroups.some(g => g.turnId == t.id))
pure def alwaysLiveGroupOwnsTurns(s: TurnEventStack): bool = s.groups.every(g => g.active iff s.controllers.turns.some(t => t.phase != T::TurnDetached and groupOf(s, t.id) == g.id))
pure def noticeFrameMatches(f: TurnFrame, noticeId: int): bool = match f { | EventFrameKind(frame) => frame.noticeId == noticeId | _ => false }
pure def cleanupFrameMatches(f: TurnFrame, turnId: int): bool = match f { | CleanupFrameKind(frame) => frame.turnId == turnId | _ => false }
pure def alwaysFramesRetainNotices(s: TurnEventStack): bool = s.frames.every(f => match f { | EventFrameKind(frame) => frame.noticeId > 0 and s.frames.select(other => noticeFrameMatches(other, frame.noticeId)).length() == 1 and s.controllers.notices.some(n => n.id == frame.noticeId and not(n.finished)) and (frame.invoking implies s.controllers.notices.some(n => n.id == frame.noticeId and n.cursor == frame.listenerGeneration)) | GlobalFrameKind(frame) => frame.cursor >= 0 and frame.cursor <= frame.groups.length() | CleanupFrameKind(frame) => frame.turnId > 0 and s.frames.select(other => cleanupFrameMatches(other, frame.turnId)).length() == 1 and s.controllers.turns.some(t => t.id == frame.turnId and t.phase == T::TurnReturned) })
pure def stepOuterCallbackWaits(before: TurnEventStack, via: str, after: TurnEventStack): bool = via == "endListener" implies before.frames.length() == after.frames.length()
pure def sometimesNestedListenerEmission(s: TurnEventStack): bool = s.frames.select(f => match f { | EventFrameKind(frame) => true | _ => false }).length() > 1
pure def sometimesCapturedOldRoomArray(s: TurnEventStack): bool = s.groups.some(g => not(g.active) and s.groups.some(other => other.room == g.room and other.active and other.id != g.id))
```
