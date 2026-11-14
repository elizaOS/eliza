# Turn controller registry

The source is [turn-controller.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/turn-controller.ts). Each `runWith` owns a fresh controller. Concurrent turns in one room append independently; this is not a latest-turn replacement map. The current asynchronous context selects the caller's own signal even after its registration is cleaned up. The room queue separately controls concurrency.

## Story: Cancel room work without cancelling the cancel request

As a host I can cancel every other active turn in a room, cancel all rooms including my own turn, and permanently close the registry to unaborted future work.

### Independent turns retain controller identity until their own cleanup

Active room order follows Map insertion order. A completed or rejected function still owns its registration until its terminal telemetry dispatch returns. Cleanup removes only that invocation; a newer turn in the same room remains. A fulfilled function emits completed even if its signal was aborted. A rejected function preserves the original error and selects aborted-cleanup only when its signal was aborted.

```quint
type TurnPhase = RunningTurn | TurnReturned | TurnDetached
type TurnResult = PendingTurn | ResolvedTurn | RejectedTurn
type TurnEntry = {id: int, room: str, startedAt: int, phase: TurnPhase, aborted: bool, reason: str, resultKind: TurnResult, errorId: str, startEvent: int, terminalEvent: int}
type TurnNoticeKind = TurnStarted | TurnCompleted | TurnErrored | TurnAborted | TurnAbortedCleanup
type TurnNotice = {id: int, kind: TurnNoticeKind, room: str, reason: str, errorId: str, duration: int, cursor: int, finished: bool, delivered: List[int]}
type TurnListener = {callback: int, generation: int, present: bool}
type TurnControllers = {now: int, closed: bool, closedReason: str, turns: List[TurnEntry], rooms: List[str], listeners: List[TurnListener], notices: List[TurnNotice], nextNotice: int, nextListener: int, listenerErrors: int, lastAbortedRooms: List[str]}
pure val initial: TurnControllers = {now: 0, closed: false, closedReason: "", turns: List(), rooms: List(), listeners: List(), notices: List(), nextNotice: 1, nextListener: 1, listenerErrors: 0, lastAbortedRooms: List()}
pure val turnIdValues = Set(1, 2, 3)
pure val selfIdValues = Set(0, 1, 2, 3)
pure val roomValues = Set("room-a", "room-b")
pure val reasonValues = Set("cancelled", "runtime stopping", "")
pure val errorIdValues = Set("original-error", "provider-error")
pure val nowValues = Set(0, 1, 2, 10)
pure val callbackValues = Set(1, 2, 3)
pure val noticeIdValues = Set(1, 2, 3, 4)
pure val noTurn: TurnEntry = {id: 0, room: "", startedAt: 0, phase: TurnDetached, aborted: false, reason: "", resultKind: PendingTurn, errorId: "", startEvent: 0, terminalEvent: 0}
pure val emptyNotices: List[TurnNotice] = List()
pure val noNotice: TurnNotice = {id: 0, kind: TurnStarted, room: "", reason: "", errorId: "", duration: 0, cursor: 0, finished: true, delivered: List()}
pure def controller(s: TurnControllers, turnId: int): TurnEntry = s.turns.select(t => t.id == turnId).nthOr(0, noTurn)
pure def notice(s: TurnControllers, noticeId: int): TurnNotice = s.notices.select(n => n.id == noticeId).nthOr(0, noNotice)
pure def freshNotice(id: int, kind: TurnNoticeKind, room: str, reason: str, errorId: str, duration: int): TurnNotice = {id: id, kind: kind, room: room, reason: reason, errorId: errorId, duration: duration, cursor: 0, finished: false, delivered: List()}
pure def canStartTurn(s: TurnControllers, turnId: int, room: str): bool = turnId > 0 and not(s.turns.some(t => t.id == turnId))
pure def startTurn(s: TurnControllers, turnId: int, room: str): TurnControllers = { ...s, turns: s.turns.append({id: turnId, room: room, startedAt: s.now, phase: RunningTurn, aborted: s.closed, reason: if (s.closed) s.closedReason else "", resultKind: PendingTurn, errorId: "", startEvent: s.nextNotice, terminalEvent: 0}), rooms: if (s.rooms.includes(room)) s.rooms else s.rooms.append(room), notices: s.notices.append(freshNotice(s.nextNotice, TurnStarted, room, "", "", 0)), nextNotice: s.nextNotice + 1 }
pure def canReturnTurn(s: TurnControllers, turnId: int, resolved: bool, errorId: str): bool = controller(s, turnId).id != 0 and controller(s, turnId).phase == RunningTurn and notice(s, controller(s, turnId).startEvent).finished
pure def returnTurn(s: TurnControllers, turnId: int, resolved: bool, errorId: str): TurnControllers = {
  val t = controller(s, turnId)
  { ...s, turns: s.turns.listMap(x => if (x.id == turnId) { ...x, phase: TurnReturned, resultKind: if (resolved) ResolvedTurn else RejectedTurn, errorId: if (resolved) "" else errorId, terminalEvent: s.nextNotice } else x), notices: s.notices.append(freshNotice(s.nextNotice, if (resolved) TurnCompleted else if (t.aborted) TurnAbortedCleanup else TurnErrored, t.room, t.reason, if (resolved) "" else errorId, s.now - t.startedAt)), nextNotice: s.nextNotice + 1 }
}
pure def canCleanupTurn(s: TurnControllers, turnId: int): bool = controller(s, turnId).phase == TurnReturned and notice(s, controller(s, turnId).terminalEvent).finished
pure def cleanupTurn(s: TurnControllers, turnId: int): TurnControllers = {
  val room = controller(s, turnId).room
  { ...s, turns: s.turns.listMap(t => if (t.id == turnId) { ...t, phase: TurnDetached } else t), rooms: if (s.turns.some(t => t.id != turnId and t.room == room and t.phase != TurnDetached)) s.rooms else s.rooms.select(r => r != room) }
}
pure def canSetTurnClock(s: TurnControllers, now: int): bool = true
pure def setTurnClock(s: TurnControllers, now: int): TurnControllers = { ...s, now: now }
pure def hasActiveRoom(s: TurnControllers, room: str): bool = s.rooms.includes(room)
pure def selectedSignal(s: TurnControllers, room: str, selfId: int): int = {
  val self = controller(s, selfId)
  val active = s.turns.select(t => t.room == room and t.phase != TurnDetached)
  if (self.id != 0 and self.room == room) self.id else active.nthOr(active.length() - 1, noTurn).id
}
pure def alwaysTurnIdentity(s: TurnControllers): bool = s.turns.every(t => t.id > 0 and s.turns.select(other => other.id == t.id).length() == 1)
pure def alwaysActiveRoomsMatch(s: TurnControllers): bool = s.rooms.every(room => s.rooms.select(other => other == room).length() == 1 and s.turns.some(t => t.room == room and t.phase != TurnDetached)) and s.turns.every(t => t.phase != TurnDetached implies s.rooms.includes(t.room))
pure def stepCleanupPreservesPeers(before: TurnControllers, via: str, after: TurnControllers): bool = via == "cleanupTurn" implies before.turns.every(t => after.turns.some(other => other.id == t.id and other.aborted == t.aborted and other.reason == t.reason))
pure def sometimesConcurrentRoomTurns(s: TurnControllers): bool = s.rooms.some(room => s.turns.select(t => t.room == room and t.phase != TurnDetached).length() >= 2)
```

### Room cancellation excludes its calling turn while global cancellation spares none

Room cancellation returns whether any non-aborted other turn changed. Global cancellation returns each changed room once in active-room insertion order. Closing stores even an empty reason as a real permanent closure; later close calls replace that reason for future turns but never replace an existing controller's first abort reason.

```quint
pure def abortableRooms(s: TurnControllers): List[str] = s.rooms.select(room => s.turns.some(t => t.room == room and t.phase != TurnDetached and not(t.aborted)))
pure def hasAbortableTurn(s: TurnControllers, room: str, selfId: int): bool = s.turns.some(t => t.room == room and t.phase != TurnDetached and t.id != selfId and not(t.aborted))
pure def abortRoom(s: TurnControllers, room: str, selfId: int, reason: str): TurnControllers = {
  val changed = hasAbortableTurn(s, room, selfId)
  { ...s, turns: s.turns.listMap(t => if (t.room == room and t.phase != TurnDetached and t.id != selfId and not(t.aborted)) { ...t, aborted: true, reason: reason } else t), lastAbortedRooms: if (changed) List(room) else List(), notices: if (changed) s.notices.append(freshNotice(s.nextNotice, TurnAborted, room, reason, "", 0)) else s.notices, nextNotice: s.nextNotice + (if (changed) 1 else 0) }
}
pure def abortAll(s: TurnControllers, reason: str): TurnControllers = {
  val changed = abortableRooms(s)
  { ...s, turns: s.turns.listMap(t => if (t.phase != TurnDetached and not(t.aborted)) { ...t, aborted: true, reason: reason } else t), lastAbortedRooms: changed, notices: s.notices.concat(changed.foldl(emptyNotices, (events, room) => events.append(freshNotice(s.nextNotice + events.length(), TurnAborted, room, reason, "", 0)))), nextNotice: s.nextNotice + changed.length() }
}
pure def closeTurns(s: TurnControllers, reason: str): TurnControllers = { ...abortAll(s, reason), closed: true, closedReason: reason }
pure def stepFirstAbortReasonStays(before: TurnControllers, after: TurnControllers): bool = before.turns.every(t => t.aborted implies after.turns.some(other => other.id == t.id and other.aborted and other.reason == t.reason))
pure def stepCloseIsPermanent(before: TurnControllers, after: TurnControllers): bool = before.closed implies after.closed
pure def alwaysClosedActiveTurnsAborted(s: TurnControllers): bool = s.closed implies s.turns.every(t => t.phase != TurnDetached implies t.aborted)
pure def sometimesCancelTurnSpared(s: TurnControllers): bool = s.turns.some(t => t.aborted and s.turns.some(other => other.room == t.room and other.phase == RunningTurn and not(other.aborted)))
pure def sometimesLateClosedTurn(s: TurnControllers): bool = s.closed and s.turns.some(t => t.phase == RunningTurn and t.aborted and t.reason == s.closedReason)
```

## Story: Observe lifecycle events without changing results

As a telemetry subscriber I receive each event in live Set insertion order. An observer failure is isolated. Removing a callback skips its pending visit; re-adding it appends a fresh live entry. A stale unsubscribe closure deletes the callback's current registration because source unsubscribe is by callback identity.

### Live listener mutation controls each event's remaining visits

Each event's cursor tracks the live registry's insertion slots. This specifies mutation between visits. The [turn event stack](./turnEventStack.md) specifies nested synchronous emission, including a listener that starts or cancels turns recursively.

Discovered by the proof. The notice allocator stays positive even when its
notice list is empty, so every published notice has a valid identity.

```quint
pure def canSubscribeTurnEvents(s: TurnControllers, callback: int): bool = callback > 0
pure def subscribeTurnEvents(s: TurnControllers, callback: int): TurnControllers = if (s.listeners.some(l => l.callback == callback and l.present)) s else { ...s, listeners: s.listeners.append({callback: callback, generation: s.nextListener, present: true}), nextListener: s.nextListener + 1 }
pure def unsubscribeTurnEvents(s: TurnControllers, callback: int): TurnControllers = { ...s, listeners: s.listeners.listMap(l => if (l.callback == callback) { ...l, present: false } else l) }
pure def nextTurnListener(s: TurnControllers, noticeId: int): TurnListener = {
  val n = notice(s, noticeId)
  s.listeners.select(l => l.present and l.generation > n.cursor).nthOr(0, {callback: 0, generation: 0, present: false})
}
pure def canVisitTurnListener(s: TurnControllers, noticeId: int, ok: bool): bool = notice(s, noticeId).id != 0 and not(notice(s, noticeId).finished) and nextTurnListener(s, noticeId).present
pure def visitTurnListener(s: TurnControllers, noticeId: int, ok: bool): TurnControllers = {
  val l = nextTurnListener(s, noticeId)
  { ...s, notices: s.notices.listMap(n => if (n.id == noticeId) { ...n, cursor: l.generation, delivered: n.delivered.append(l.generation) } else n), listenerErrors: s.listenerErrors + (if (ok) 0 else 1) }
}
pure def canFinishTurnNotice(s: TurnControllers, noticeId: int): bool = notice(s, noticeId).id != 0 and not(notice(s, noticeId).finished) and not(nextTurnListener(s, noticeId).present)
pure def finishTurnNotice(s: TurnControllers, noticeId: int): TurnControllers = { ...s, notices: s.notices.listMap(n => if (n.id == noticeId) { ...n, finished: true } else n) }
pure def alwaysOneLiveListener(s: TurnControllers): bool = s.listeners.every(l => l.present implies s.listeners.select(other => other.callback == l.callback and other.present).length() == 1)
pure def alwaysNoticesUnique(s: TurnControllers): bool = s.nextNotice > 0 and s.notices.every(n => n.id > 0 and n.id < s.nextNotice and s.notices.select(other => other.id == n.id).length() == 1 and n.delivered.every(generation => generation <= n.cursor))
pure def stepTelemetryCannotChangeResult(before: TurnControllers, via: str, after: TurnControllers): bool = (via == "visitTurnListener" or via == "finishTurnNotice" or via == "subscribeTurnEvents" or via == "unsubscribeTurnEvents") implies after.turns == before.turns
pure def sometimesAbortedFunctionResolved(s: TurnControllers): bool = s.turns.some(t => t.aborted and t.resultKind == ResolvedTurn)
pure def sometimesObserverFailureIsolated(s: TurnControllers): bool = s.listenerErrors > 0 and s.turns.some(t => t.resultKind == ResolvedTurn)
```
