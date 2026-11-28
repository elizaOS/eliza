# Turn controller registry

The source is [turn-controller.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/turn-controller.ts). Each `runWith` owns a fresh controller. Concurrent turns in one room append independently; this is not a latest-turn replacement map. The caller's own signal comes from its asynchronous context, so it outlives the cleanup of its registration; this machine keeps the registry, not that context. The room queue separately controls concurrency. The synchronous `emit` and abort loops can reenter through a telemetry or native signal callback, so this machine keeps the JavaScript call stack as frames and the identity of each room's mutable turn array as a group. It exposes no asynchronous callback execution that the source lacks.

## Story: Cancel room work without cancelling the cancel request

> As a host, I want to cancel every other active turn in a room, cancel all
> rooms including my own turn, and close the registry for good, so that no
> unaborted work starts after shutdown.

### Independent turns retain controller identity until their own cleanup

Active room order follows Map insertion order. A completed or rejected function still owns its registration until its terminal telemetry dispatch returns. Cleanup removes only that invocation, and a newer turn in the same room remains. A fulfilled function emits completed even if its signal was aborted. A rejected function preserves the original error and selects aborted-cleanup only when its signal was aborted. A turn started while the registry is closed starts aborted with the closing reason. Turns start while the stack is empty or from the top callback. A turn returns on an empty stack and cleans up when its cleanup frame is the only frame left.

```quint
type TurnPhase = RunningTurn | TurnReturned | TurnDetached
type TurnResult = PendingTurn | ResolvedTurn | RejectedTurn
type TurnEntry = {id: int, room: str, startedAt: int, phase: TurnPhase, aborted: bool, reason: str, resultKind: TurnResult, errorId: str, startEvent: int, terminalEvent: int}
type TurnNoticeKind = TurnStarted | TurnCompleted | TurnErrored | TurnAborted | TurnAbortedCleanup
type TurnNotice = {id: int, kind: TurnNoticeKind, room: str, reason: str, errorId: str, duration: int, cursor: int, finished: bool, delivered: List[int]}
type TurnListener = {callback: int, generation: int, present: bool}
type TurnControllers = {now: int, closed: bool, closedReason: str, turns: List[TurnEntry], rooms: List[str], listeners: List[TurnListener], notices: List[TurnNotice], nextNotice: int, nextListener: int, listenerErrors: int, lastAbortedRooms: List[str]}
type EventFrame = {noticeId: int, invoking: bool, listenerGeneration: int}
type GlobalFrame = {groups: List[int], cursor: int, reason: str, abortedRooms: List[str]}
type ScanFrame = {scanId: int, cursor: int, excluded: int, reason: str, notifying: int, changed: bool}
type RoomScan = {group: int, room: str, global: bool, scan: ScanFrame}
type RoomAbortReturn = {group: int, abortRoom: str, fromGlobal: bool, changedSignal: bool}
type CleanupFrame = {turnId: int}
type TurnFrame = EventFrameKind(EventFrame) | GlobalFrameKind(GlobalFrame) | CleanupFrameKind(CleanupFrame) | RoomScanKind(RoomScan) | RoomAbortReturnKind(RoomAbortReturn)
type RoomGroup = {id: int, room: str, active: bool}
type TurnGroup = {turnId: int, group: int}
type Turns = {controllers: TurnControllers, frames: List[TurnFrame], groups: List[RoomGroup], turnGroups: List[TurnGroup], nextGroup: int}
pure val emptyControllers: TurnControllers = {now: 0, closed: false, closedReason: "", turns: List(), rooms: List(), listeners: List(), notices: List(), nextNotice: 1, nextListener: 1, listenerErrors: 0, lastAbortedRooms: List()}
pure val initial: Turns = {controllers: emptyControllers, frames: List(), groups: List(), turnGroups: List(), nextGroup: 1}
pure val turnIdValues = Set(1, 2, 3)
pure val selfIdValues = Set(0, 1, 2, 3)
pure val roomValues = Set("room-a", "room-b")
pure val reasonValues = Set("cancelled", "runtime stopping", "")
pure val errorIdValues = Set("original-error", "provider-error")
pure val nowValues = Set(0, 1, 2, 10)
pure val callbackValues = Set(1, 2, 3)
pure val noTurn: TurnEntry = {id: 0, room: "", startedAt: 0, phase: TurnDetached, aborted: false, reason: "", resultKind: PendingTurn, errorId: "", startEvent: 0, terminalEvent: 0}
pure val noNotice: TurnNotice = {id: 0, kind: TurnStarted, room: "", reason: "", errorId: "", duration: 0, cursor: 0, finished: true, delivered: List()}
pure val noEventFrame: EventFrame = {noticeId: 0, invoking: false, listenerGeneration: 0}
pure val noGlobalFrame: GlobalFrame = {groups: List(), cursor: 0, reason: "", abortedRooms: List()}
pure val emptyScan: ScanFrame = {scanId: 0, cursor: 0, excluded: 0, reason: "", notifying: 0, changed: false}
pure val noRoomScan: RoomScan = {group: 0, room: "", global: false, scan: emptyScan}
pure def controller(c: TurnControllers, turnId: int): TurnEntry = c.turns.select(t => t.id == turnId).nthOr(0, noTurn)
pure def notice(c: TurnControllers, noticeId: int): TurnNotice = c.notices.select(n => n.id == noticeId).nthOr(0, noNotice)
pure def freshNotice(id: int, kind: TurnNoticeKind, room: str, reason: str, errorId: str, duration: int): TurnNotice = {id: id, kind: kind, room: room, reason: reason, errorId: errorId, duration: duration, cursor: 0, finished: false, delivered: List()}
pure def topFrame(s: Turns): TurnFrame = s.frames.nthOr(s.frames.length() - 1, EventFrameKind({noticeId: 0, invoking: false, listenerGeneration: 0}))
pure def replaceTop(frames: List[TurnFrame], frame: TurnFrame): List[TurnFrame] = frames.removeAt(frames.length() - 1).append(frame)
pure def pushNotices(before: TurnControllers, after: TurnControllers, frames: List[TurnFrame]): List[TurnFrame] = if (after.nextNotice == before.nextNotice) frames else frames.append(EventFrameKind({noticeId: before.nextNotice, invoking: false, listenerGeneration: 0}))
pure def currentEvent(s: Turns): EventFrame = {
  val selected = topFrame(s)
  match selected { | EventFrameKind(frame) => {noticeId: frame.noticeId, invoking: frame.invoking, listenerGeneration: frame.listenerGeneration} | _ => noEventFrame }
}
pure def currentRoomScan(s: Turns): RoomScan = {
  val selected = topFrame(s)
  match selected { | RoomScanKind(frame) => {group: frame.group, room: frame.room, global: frame.global, scan: frame.scan} | _ => noRoomScan }
}
pure def mayReenter(s: Turns): bool = s.frames.length() == 0 or currentEvent(s).invoking or currentRoomScan(s).scan.notifying > 0
pure def liveGroup(s: Turns, room: str): int = s.groups.select(g => g.room == room and g.active).nthOr(0, {id: 0, room: "", active: false}).id
pure def groupOf(s: Turns, turnId: int): int = s.turnGroups.select(g => g.turnId == turnId).nthOr(0, {turnId: 0, group: 0}).group
pure def roomGroupMembers(s: Turns, group: int): List[TurnEntry] = s.controllers.turns.select(t => t.phase != TurnDetached and groupOf(s, t.id) == group and group > 0)
pure def registerTurn(c: TurnControllers, turnId: int, room: str): TurnControllers = { ...c, turns: c.turns.append({id: turnId, room: room, startedAt: c.now, phase: RunningTurn, aborted: c.closed, reason: if (c.closed) c.closedReason else "", resultKind: PendingTurn, errorId: "", startEvent: c.nextNotice, terminalEvent: 0}), rooms: if (c.rooms.includes(room)) c.rooms else c.rooms.append(room), notices: c.notices.append(freshNotice(c.nextNotice, TurnStarted, room, "", "", 0)), nextNotice: c.nextNotice + 1 }
pure def canStartTurn(s: Turns, turnId: int, room: str): bool = mayReenter(s) and turnId > 0 and not(s.controllers.turns.some(t => t.id == turnId))
pure def startTurn(s: Turns, turnId: int, room: str): Turns = {
  val updated = registerTurn(s.controllers, turnId, room)
  val group = liveGroup(s, room)
  { ...s, controllers: updated, frames: pushNotices(s.controllers, updated, s.frames), groups: if (group == 0) s.groups.append({id: s.nextGroup, room: room, active: true}) else s.groups, turnGroups: s.turnGroups.append({turnId: turnId, group: if (group == 0) s.nextGroup else group}), nextGroup: s.nextGroup + (if (group == 0) 1 else 0) }
}
pure def recordReturn(c: TurnControllers, turnId: int, resolved: bool, errorId: str): TurnControllers = {
  val t = controller(c, turnId)
  { ...c, turns: c.turns.listMap(x => if (x.id == turnId) { ...x, phase: TurnReturned, resultKind: if (resolved) ResolvedTurn else RejectedTurn, errorId: if (resolved) "" else errorId, terminalEvent: c.nextNotice } else x), notices: c.notices.append(freshNotice(c.nextNotice, if (resolved) TurnCompleted else if (t.aborted) TurnAbortedCleanup else TurnErrored, t.room, t.reason, if (resolved) "" else errorId, c.now - t.startedAt)), nextNotice: c.nextNotice + 1 }
}
pure def canReturnTurn(s: Turns, turnId: int, resolved: bool, errorId: str): bool = s.frames.length() == 0 and controller(s.controllers, turnId).id != 0 and controller(s.controllers, turnId).phase == RunningTurn and notice(s.controllers, controller(s.controllers, turnId).startEvent).finished
pure def returnTurn(s: Turns, turnId: int, resolved: bool, errorId: str): Turns = {
  val updated = recordReturn(s.controllers, turnId, resolved, errorId)
  { ...s, controllers: updated, frames: pushNotices(s.controllers, updated, s.frames.append(CleanupFrameKind({turnId: turnId}))) }
}
pure def cleanupTurnId(s: Turns): int = {
  val selected = topFrame(s)
  match selected { | CleanupFrameKind(frame) => frame.turnId | _ => 0 }
}
pure def canCleanupTurn(s: Turns, turnId: int): bool = cleanupTurnId(s) == turnId and controller(s.controllers, turnId).phase == TurnReturned and notice(s.controllers, controller(s.controllers, turnId).terminalEvent).finished
pure def cleanupTurn(s: Turns, turnId: int): Turns = {
  val c = s.controllers
  val room = controller(c, turnId).room
  val group = groupOf(s, turnId)
  val hasPeer = c.turns.some(t => t.id != turnId and t.phase != TurnDetached and groupOf(s, t.id) == group)
  val detached = { ...c, turns: c.turns.listMap(t => if (t.id == turnId) { ...t, phase: TurnDetached } else t), rooms: if (c.turns.some(t => t.id != turnId and t.room == room and t.phase != TurnDetached)) c.rooms else c.rooms.select(r => r != room) }
  { ...s, controllers: detached, frames: s.frames.removeAt(s.frames.length() - 1), groups: s.groups.listMap(g => if (g.id == group and not(hasPeer)) { ...g, active: false } else g) }
}
pure def setTurnClock(s: Turns, now: int): Turns = { ...s, controllers: { ...s.controllers, now: now } }
pure def alwaysActiveRoomsMatch(s: Turns): bool = s.controllers.rooms.every(room => s.controllers.rooms.select(other => other == room).length() == 1 and s.controllers.turns.some(t => t.room == room and t.phase != TurnDetached)) and s.controllers.turns.every(t => t.phase != TurnDetached implies s.controllers.rooms.includes(t.room))
pure def stepCleanupPreservesPeers(before: Turns, via: str, after: Turns): bool = via == "cleanupTurn" implies before.controllers.turns.every(t => after.controllers.turns.some(other => other.id == t.id and other.aborted == t.aborted and other.reason == t.reason))
pure def sometimesConcurrentRoomTurns(s: Turns): bool = s.controllers.rooms.some(room => s.controllers.turns.select(t => t.room == room and t.phase != TurnDetached).length() >= 2)
```

### Room cancellation excludes its calling turn while global cancellation spares none

A room abort scans the live array the registry holds for that room, so a
turn started in that array while the scan is on the stack extends it, and
it skips its captured calling turn. A global abort captures the room arrays
in insertion order and scans each with no exclusion; a new array created
later for the same room is not part of that snapshot. Closing marks the
registry closed before the scan, keeps even an empty reason, and is
permanent; a later close replaces the reason for future turns, but no
abort ever replaces a controller's first abort reason. While the registry
is closed, every active turn is aborted or still owed a visit by an open
global abort.

```quint
pure def canAbortRoom(s: Turns, room: str, selfId: int, reason: str): bool = mayReenter(s) and selfId >= 0
pure def abortRoom(s: Turns, room: str, selfId: int, reason: str): Turns = {
  val scan = { ...emptyScan, scanId: s.frames.length() + 1, excluded: selfId, reason: reason }
  { ...s, frames: s.frames.append(RoomScanKind({group: liveGroup(s, room), room: room, global: false, scan: scan})) }
}
pure def currentGlobal(s: Turns): GlobalFrame = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => {groups: frame.groups, cursor: frame.cursor, reason: frame.reason, abortedRooms: frame.abortedRooms} | _ => noGlobalFrame }
}
pure def activeGroupIds(s: Turns): List[int] = s.groups.select(g => g.active).listMap(g => g.id)
pure def canBeginGlobalAbort(s: Turns, reason: str, close: bool): bool = mayReenter(s)
pure def beginGlobalAbort(s: Turns, reason: str, close: bool): Turns = { ...s, controllers: if (close) { ...s.controllers, closed: true, closedReason: reason } else s.controllers, frames: s.frames.append(GlobalFrameKind({groups: activeGroupIds(s), cursor: 0, reason: reason, abortedRooms: List()})) }
pure def canAdvanceGlobalAbort(s: Turns): bool = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => frame.cursor < frame.groups.length() | _ => false }
}
pure def advanceGlobalAbort(s: Turns): Turns = {
  val frame = currentGlobal(s)
  val group = frame.groups.nthOr(frame.cursor, 0)
  val room = s.groups.select(g => g.id == group).nthOr(0, {id: 0, room: "", active: false}).room
  val scan = { ...emptyScan, scanId: s.frames.length() + 1, reason: frame.reason }
  val continued = GlobalFrameKind({groups: frame.groups, cursor: frame.cursor + 1, reason: frame.reason, abortedRooms: frame.abortedRooms})
  { ...s, frames: replaceTop(s.frames, continued).append(RoomScanKind({group: group, room: room, global: true, scan: scan})) }
}
pure def canFinishGlobalAbort(s: Turns): bool = {
  val selected = topFrame(s)
  match selected { | GlobalFrameKind(frame) => frame.cursor >= frame.groups.length() | _ => false }
}
pure def finishGlobalAbort(s: Turns): Turns = { ...s, controllers: { ...s.controllers, lastAbortedRooms: currentGlobal(s).abortedRooms }, frames: s.frames.removeAt(s.frames.length() - 1) }
type GlobalGroupCursor = {remaining: int, retained: bool}
pure def groupInSuffix(groups: List[int], cursor: int, group: int): bool = {
  val initialCursor: GlobalGroupCursor = {remaining: cursor, retained: false}
  groups.foldl(initialCursor, (point, id) => {remaining: point.remaining - 1, retained: point.retained or (point.remaining <= 0 and id == group)}).retained
}
pure def frameOwnsPendingTurn(s: Turns, f: TurnFrame, turnId: int, group: int): bool = match f {
  | GlobalFrameKind(frame) => groupInSuffix(frame.groups, frame.cursor, group)
  | RoomScanKind(r) => r.global and r.group == group and groupInSuffix(roomGroupMembers(s, group).listMap(t => t.id), r.scan.cursor, turnId)
  | _ => false
}
pure def alwaysClosedPendingHasGlobalOwner(s: Turns): bool = s.controllers.closed implies s.controllers.turns.every(t => t.phase == TurnDetached or t.aborted or s.frames.some(f => frameOwnsPendingTurn(s, f, t.id, groupOf(s, t.id))))
pure def stepFirstAbortReasonStays(before: Turns, after: Turns): bool = before.controllers.turns.every(t => t.aborted implies after.controllers.turns.some(other => other.id == t.id and other.aborted and other.reason == t.reason))
pure def stepCloseIsPermanent(before: Turns, after: Turns): bool = before.controllers.closed implies after.controllers.closed
pure def sometimesCancelTurnSpared(s: Turns): bool = s.controllers.turns.some(t => t.aborted and s.controllers.turns.some(other => other.room == t.room and other.phase == RunningTurn and not(other.aborted)))
pure def sometimesLateClosedTurn(s: Turns): bool = s.controllers.closed and s.controllers.turns.some(t => t.phase == RunningTurn and t.aborted and t.reason == s.controllers.closedReason)
pure def sometimesCapturedOldRoomArray(s: Turns): bool = s.groups.some(g => not(g.active) and s.groups.some(other => other.room == g.room and other.active and other.id != g.id))
```

### A room notice follows the last native signal callback

For each eligible turn the scan first stores the abort reason and then
begins native signal delivery, so a nested scan started by that callback
sees the reason and skips the turn. The scan cannot advance while the
delivery runs, and it finishes only after the delivery returns and its
cursor reaches the current end of the array. Each scan owns its changed
result, and only a scan that changed a signal emits an aborted notice. A
room abort reports whether it changed a signal; a changed global room scan
adds its room once, in snapshot order, to its own global abort's result
after telemetry returns.

```quint
pure def canVisitRoomSignal(s: Turns): bool = {
  val r = currentRoomScan(s)
  r.scan.scanId > 0 and r.scan.notifying == 0 and r.scan.cursor >= 0 and r.scan.cursor < roomGroupMembers(s, r.group).length()
}
pure def visitRoomSignal(s: Turns): Turns = {
  val r = currentRoomScan(s)
  val target = roomGroupMembers(s, r.group).nthOr(r.scan.cursor, noTurn)
  val eligible = target.id > 0 and not(target.aborted) and target.id != r.scan.excluded
  val visited = { ...r.scan, cursor: r.scan.cursor + 1, notifying: if (eligible) target.id else 0, changed: eligible or r.scan.changed }
  { ...s, controllers: { ...s.controllers, turns: s.controllers.turns.listMap(t => if (eligible and t.id == target.id) { ...t, aborted: true, reason: r.scan.reason } else t) },
    frames: replaceTop(s.frames, RoomScanKind({group: r.group, room: r.room, global: r.global, scan: visited})) }
}
pure def canReturnNativeSignal(s: Turns): bool = {
  val r = currentRoomScan(s)
  r.scan.scanId > 0 and r.scan.notifying > 0
}
pure def returnNativeSignal(s: Turns): Turns = {
  val r = currentRoomScan(s)
  { ...s, frames: replaceTop(s.frames, RoomScanKind({group: r.group, room: r.room, global: r.global, scan: { ...r.scan, notifying: 0 }})) }
}
pure def canFinishRoomSignal(s: Turns): bool = {
  val r = currentRoomScan(s)
  r.scan.scanId > 0 and r.scan.notifying == 0 and r.scan.cursor == roomGroupMembers(s, r.group).length()
}
pure def finishRoomSignal(s: Turns): Turns = {
  val r = currentRoomScan(s)
  val frames = replaceTop(s.frames, RoomAbortReturnKind({group: r.group, abortRoom: r.room, fromGlobal: r.global, changedSignal: r.scan.changed}))
  val controls = { ...s.controllers,
    notices: if (r.scan.changed) s.controllers.notices.append(freshNotice(s.controllers.nextNotice, TurnAborted, r.room, r.scan.reason, "", 0)) else s.controllers.notices,
    nextNotice: s.controllers.nextNotice + (if (r.scan.changed) 1 else 0) }
  { ...s, controllers: controls, frames: pushNotices(s.controllers, controls, frames) }
}
pure def currentAbortReturn(s: Turns): RoomAbortReturn = {
  val top = topFrame(s)
  match top {
    | RoomAbortReturnKind(r) => {group: r.group, abortRoom: r.abortRoom, fromGlobal: r.fromGlobal, changedSignal: r.changedSignal}
    | _ => {group: 0, abortRoom: "", fromGlobal: false, changedSignal: false}
  }
}
pure def canReturnRoomAbort(s: Turns): bool = {
  val top = topFrame(s)
  match top { | RoomAbortReturnKind(_) => true | _ => false }
}
pure def returnRoomAbort(s: Turns): Turns = {
  val r = currentAbortReturn(s)
  val remaining = s.frames.removeAt(s.frames.length() - 1)
  val parent = remaining.nthOr(remaining.length() - 1, CleanupFrameKind({turnId: 0}))
  val parents = match parent {
    | GlobalFrameKind(frame) => if (r.fromGlobal and r.changedSignal)
        replaceTop(remaining, GlobalFrameKind({groups: frame.groups, cursor: frame.cursor, reason: frame.reason, abortedRooms: frame.abortedRooms.append(r.abortRoom)}))
      else remaining
    | _ => remaining
  }
  { ...s, controllers: { ...s.controllers, lastAbortedRooms: if (r.fromGlobal) s.controllers.lastAbortedRooms else if (r.changedSignal) List(r.abortRoom) else List() }, frames: parents }
}
pure def sometimesRoomScanSparesCallingTurn(s: Turns): bool = {
  val r = currentRoomScan(s)
  s.frames.length() == 1 and r.scan.scanId > 0 and not(r.global) and r.scan.changed and r.scan.cursor == roomGroupMembers(s, r.group).length() and
    roomGroupMembers(s, r.group).some(t => t.id == r.scan.excluded and not(t.aborted))
}
pure def sometimesNativeAbortStartsNestedRoomScan(s: Turns): bool =
  currentRoomScan(s).scan.scanId > 0 and
  s.frames.some(f => match f { | RoomScanKind(r) => r.scan.notifying > 0 and r.scan.scanId != currentRoomScan(s).scan.scanId | _ => false })
```

## Story: Observe lifecycle events without changing results

> As a telemetry subscriber, I want each lifecycle event in live
> subscription order, with my failures isolated from the turn, and I want
> to register or remove listeners, start a turn or cancel work from a
> callback, so that observing turns never changes their results and a
> reaction to one event can drive the next without breaking delivery order.

### Each event visits the live listeners in order and finishes nested events before resuming

Each event's cursor tracks the live registry's insertion slots and advances
before the callback runs. Removing a callback skips its pending visit;
re-adding it appends a fresh live slot, which a running event can visit
again. A stale unsubscribe closure deletes the callback's current
registration, because unsubscribe is by callback identity. Only the top
callback may reenter: a notice it publishes pushes its own frame, and the
outer callback cannot return until that frame has finished. Listener
exceptions are counted and leave every turn and result unchanged.

```quint
pure def canSubscribe(s: Turns, callback: int): bool = mayReenter(s) and callback > 0
pure def subscribe(s: Turns, callback: int): Turns = {
  val c = s.controllers
  if (c.listeners.some(l => l.callback == callback and l.present)) s else { ...s, controllers: { ...c, listeners: c.listeners.append({callback: callback, generation: c.nextListener, present: true}), nextListener: c.nextListener + 1 } }
}
pure def canUnsubscribe(s: Turns, callback: int): bool = mayReenter(s)
pure def unsubscribe(s: Turns, callback: int): Turns = { ...s, controllers: { ...s.controllers, listeners: s.controllers.listeners.listMap(l => if (l.callback == callback) { ...l, present: false } else l) } }
pure def nextTurnListener(c: TurnControllers, noticeId: int): TurnListener = {
  val n = notice(c, noticeId)
  c.listeners.select(l => l.present and l.generation > n.cursor).nthOr(0, {callback: 0, generation: 0, present: false})
}
pure def canBeginListener(s: Turns): bool = currentEvent(s).noticeId != 0 and not(currentEvent(s).invoking) and nextTurnListener(s.controllers, currentEvent(s).noticeId).present
pure def beginListener(s: Turns): Turns = {
  val frame = currentEvent(s)
  val listener = nextTurnListener(s.controllers, frame.noticeId)
  { ...s, controllers: { ...s.controllers, notices: s.controllers.notices.listMap(n => if (n.id == frame.noticeId) { ...n, cursor: listener.generation } else n) }, frames: replaceTop(s.frames, EventFrameKind({noticeId: frame.noticeId, invoking: true, listenerGeneration: listener.generation})) }
}
pure def canEndListener(s: Turns, ok: bool): bool = currentEvent(s).noticeId != 0 and currentEvent(s).invoking
pure def endListener(s: Turns, ok: bool): Turns = {
  val frame = currentEvent(s)
  { ...s, controllers: { ...s.controllers, notices: s.controllers.notices.listMap(n => if (n.id == frame.noticeId) { ...n, delivered: n.delivered.append(frame.listenerGeneration) } else n), listenerErrors: s.controllers.listenerErrors + (if (ok) 0 else 1) }, frames: replaceTop(s.frames, EventFrameKind({noticeId: frame.noticeId, invoking: false, listenerGeneration: 0})) }
}
pure def canFinishEvent(s: Turns): bool = currentEvent(s).noticeId != 0 and not(currentEvent(s).invoking) and not(nextTurnListener(s.controllers, currentEvent(s).noticeId).present)
pure def finishEvent(s: Turns): Turns = {
  val noticeId = currentEvent(s).noticeId
  { ...s, controllers: { ...s.controllers, notices: s.controllers.notices.listMap(n => if (n.id == noticeId) { ...n, finished: true } else n) }, frames: s.frames.removeAt(s.frames.length() - 1) }
}
pure def alwaysOneLiveListener(s: Turns): bool = s.controllers.listeners.every(l => l.present implies s.controllers.listeners.select(other => other.callback == l.callback and other.present).length() == 1)
pure def stepTelemetryCannotChangeResult(before: Turns, via: str, after: Turns): bool = (via == "beginListener" or via == "endListener" or via == "finishEvent" or via == "subscribe" or via == "unsubscribe") implies after.controllers.turns == before.controllers.turns
pure def sometimesAbortedFunctionResolved(s: Turns): bool = s.controllers.turns.some(t => t.aborted and t.resultKind == ResolvedTurn)
pure def sometimesObserverFailureIsolated(s: Turns): bool = s.controllers.listenerErrors > 0 and s.controllers.turns.some(t => t.resultKind == ResolvedTurn)
pure def sometimesNestedListenerEmission(s: Turns): bool = s.frames.select(f => match f { | EventFrameKind(frame) => true | _ => false }).length() > 1
```

### Every turn, notice, room array and frame keeps its own identity

Turn identities, notice identities and room-array groups are each issued
once, and every turn keeps the room array it started in after it detaches.
A room has at most one live array. A stack frame retains its own unfinished
notice, returned turn awaiting cleanup, global abort snapshot, captured room
scan or room-abort return.

Without these facts the first notice published into an empty history
could take identity zero, which means no notice, and a callback could
resume under another frame's owner.

Discovered by the proof: every room array a global abort captured remains
in the registry while the callback visits or returns from it. An abort
scan and its return retain the same room identity as the captured array,
even when a callback starts another scan, and an abort without a captured
room array cannot change a signal.

```quint
pure def alwaysTurnIdentity(s: Turns): bool = s.controllers.turns.every(t => t.id > 0 and s.controllers.turns.select(other => other.id == t.id).length() == 1)
pure def alwaysNoticesUnique(s: Turns): bool = s.controllers.nextNotice > 0 and s.controllers.notices.every(n => n.id > 0 and n.id < s.controllers.nextNotice and s.controllers.notices.select(other => other.id == n.id).length() == 1 and n.delivered.every(generation => generation <= n.cursor))
pure def alwaysGroupAllocatorValid(s: Turns): bool = s.nextGroup > 0 and s.groups.every(g => g.id > 0 and g.id < s.nextGroup and s.groups.select(other => other.id == g.id).length() == 1 and (g.active implies s.groups.select(other => other.active and other.room == g.room).length() == 1))
pure def groupMappingRetainsTurn(s: Turns, mapping: TurnGroup): bool =
  s.turnGroups.select(other => other.turnId == mapping.turnId).length() == 1 and
  s.controllers.turns.some(t => t.id == mapping.turnId and s.groups.some(g => g.id == mapping.group and g.room == t.room))
pure def turnRetainsGroup(s: Turns, t: TurnEntry): bool =
  s.turnGroups.some(g => g.turnId == t.id) and s.groups.some(g => g.id == groupOf(s, t.id) and g.room == t.room)
pure def alwaysTurnsRetainGroups(s: Turns): bool =
  s.turnGroups.every(g => groupMappingRetainsTurn(s, g)) and s.controllers.turns.every(t => turnRetainsGroup(s, t))
pure def alwaysLiveGroupOwnsTurns(s: Turns): bool = s.groups.every(g => g.active iff s.controllers.turns.some(t => t.phase != TurnDetached and groupOf(s, t.id) == g.id))
pure def noticeFrameMatches(f: TurnFrame, noticeId: int): bool = match f { | EventFrameKind(frame) => frame.noticeId == noticeId | _ => false }
pure def cleanupFrameMatches(f: TurnFrame, turnId: int): bool = match f { | CleanupFrameKind(frame) => frame.turnId == turnId | _ => false }
pure def validRoomCapture(s: Turns, group: int, room: str, global: bool, changed: bool): bool =
  if (group == 0) not(global or changed) else s.groups.some(g => g.id == group and g.room == room)
pure def validRoomScan(s: Turns, r: RoomScan): bool = {
  val members = roomGroupMembers(s, r.group)
  r.scan.scanId > 0 and r.scan.excluded >= 0 and (r.global implies r.scan.excluded == 0) and
    validRoomCapture(s, r.group, r.room, r.global, r.scan.changed) and
    r.scan.cursor >= 0 and r.scan.cursor <= members.length() and
    (r.scan.notifying != 0 implies r.scan.changed and members.some(t => t.id == r.scan.notifying and t.aborted and t.reason == r.scan.reason))
}
pure def validStackFrame(s: Turns, f: TurnFrame): bool = match f {
  | EventFrameKind(frame) => frame.noticeId > 0 and s.frames.select(other => noticeFrameMatches(other, frame.noticeId)).length() == 1 and s.controllers.notices.some(n => n.id == frame.noticeId and not(n.finished)) and (frame.invoking implies s.controllers.notices.some(n => n.id == frame.noticeId and n.cursor == frame.listenerGeneration))
  | GlobalFrameKind(frame) => frame.cursor >= 0 and frame.cursor <= frame.groups.length() and frame.groups.every(id => s.groups.some(g => g.id == id))
  | CleanupFrameKind(frame) => frame.turnId > 0 and s.frames.select(other => cleanupFrameMatches(other, frame.turnId)).length() == 1 and s.controllers.turns.some(t => t.id == frame.turnId and t.phase == TurnReturned)
  | RoomScanKind(r) => validRoomScan(s, {group: r.group, room: r.room, global: r.global, scan: r.scan})
  | RoomAbortReturnKind(r) => validRoomCapture(s, r.group, r.abortRoom, r.fromGlobal, r.changedSignal)
}
pure def alwaysFramesRetainNotices(s: Turns): bool = s.frames.every(f => validStackFrame(s, f))
```

### The stack holds at most one cleanup frame, at its bottom

A turn returns only on an empty stack, so the stack holds at most one
cleanup frame, and that frame is the bottom one: its cleanup waits below
the completion notice and any callbacks that notice starts.

Discovered by the proof: cleanup above a room scan could detach a scanned
turn and move the scan cursor beyond the end of the room array.

```quint
pure def isCleanupFrame(f: TurnFrame): bool = match f { | CleanupFrameKind(frame) => true | _ => false }
pure def alwaysCleanupAtBottom(s: Turns): bool =
  s.frames.select(f => isCleanupFrame(f)).length() == 0 or
    (s.frames.select(f => isCleanupFrame(f)).length() == 1 and isCleanupFrame(s.frames.nthOr(0, RoomAbortReturnKind({group: 0, abortRoom: "", fromGlobal: false, changedSignal: false}))))
```
