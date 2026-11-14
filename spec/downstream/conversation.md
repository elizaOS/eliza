# Client conversation turns and Stop receipts

Grace imports `ConversationTurnController` and `admitConversationStopReceipt`
from `packages/ui/src/api/conversation-turn-controller.ts`. AlphaPhone
imports `findStoppedUserTurn` from the corresponding pinned producer in
`apps/app/src/runtime/connection-ui.tsx` and has its own transport and turn
presentation. The client controller owns binding and publication. The
[core server turn registry](../core/turnControllers.md) owns server work.
A matching Stop acknowledges cancellation signaling. Server cleanup and
committed effect receipts have independent lifetimes.

## Story: Stop a reply without sending the next message against an uncertain room

### An explicit send waits for the captured Stop and owns its callbacks

The controller reserves a single turn before any transport calls. It
retains dispatch identity when transport might have reached the agent.
Stop cancels local publication immediately. A dispatched turn retains
its room and identity for later history matching. A waiting send waits
for the captured Stop. A failure refuses that first send and clears only
the same binding object. Binding a different conversation advances the
generation, retires old callbacks, and preserves the new binding when
that old Stop fails. Reset advances generation and detaches any current
Stop from the next session. An externally cancelled request and a lost
server ownership response have distinct outcomes. A fresh explicit turn
is the only way to dispatch another message.

This model uses positive ordinals for the controller's turn identity
and binding object identity. It represents at most one tracked Stop and
one reserved send. Transport completion events identify their owner.
The retained history match survives ordinary sends and failed Stop receipts.
Reset, a new binding, or an explicit clear retires it. A clear naming another
turn has no effect. The shell must still validate and copy the actual conversation and room
identifiers and match the Stop response's room and reason.

```quint
type StopPhase = NoStop | StopWaiting | StopConfirmed | StopFailed
type TurnPhase = NoTurn | BeforeDispatch | AfterDispatch
type ClientResult = NoClientResult | ClientReply | ClientFailureBeforeSend | ClientFailureAfterSend | ClientStopUnconfirmed
type Client = { generation: int, bindingSerial: int, bindingId: int, room: str, serial: int, activeTurn: int, turnPhase: TurnPhase, stopPhase: StopPhase, stopTurn: int, stopBinding: int, stoppedRoom: str, historyTurn: int, historyRoom: str, result: ClientResult }
pure val initial: Client = { generation: 0, bindingSerial: 0, bindingId: 0, room: "", serial: 0, activeTurn: 0, turnPhase: NoTurn, stopPhase: NoStop, stopTurn: 0, stopBinding: 0, stoppedRoom: "", historyTurn: 0, historyRoom: "", result: NoClientResult }
pure def stopActive(c: Client): bool = c.turnPhase == AfterDispatch
pure def retireActive(alsoStop: bool, c: Client): Client =
  if (alsoStop and stopActive(c)) { ...c, turnPhase: NoTurn, activeTurn: 0, stopPhase: StopWaiting, stopTurn: c.activeTurn, stopBinding: c.bindingId, stoppedRoom: c.room, historyTurn: c.activeTurn, historyRoom: c.room }
  else { ...c, turnPhase: NoTurn, activeTurn: 0 }
pure def canBindRoom(c: Client, room: str): bool = room != "" and room != c.room
pure def bindRoom(c: Client, room: str): Client = { ...retireActive(true, c), generation: c.generation + 1, bindingSerial: c.bindingSerial + 1, bindingId: c.bindingSerial + 1, room: room, historyTurn: 0, historyRoom: "" }
pure def resetClient(c: Client): Client = { ...c, generation: c.generation + 1, bindingId: 0, room: "", activeTurn: 0, turnPhase: NoTurn, stopPhase: NoStop, stopTurn: 0, stopBinding: 0, stoppedRoom: "", historyTurn: 0, historyRoom: "", result: NoClientResult }
pure def canClearHistory(c: Client, turnId: int): bool = c.historyTurn > 0 and (turnId == 0 or turnId == c.historyTurn)
pure def clearHistory(c: Client, turnId: int): Client = { ...c, historyTurn: 0, historyRoom: "" }
pure def canReserve(c: Client): bool = c.turnPhase == NoTurn
pure def reserve(c: Client): Client = { ...c, serial: c.serial + 1, activeTurn: c.serial + 1, turnPhase: BeforeDispatch, result: NoClientResult }
pure def canDispatchTurn(c: Client, room: str): bool = c.turnPhase == BeforeDispatch and (c.stopPhase == NoStop or c.stopPhase == StopConfirmed) and (c.room != "" or room != "")
pure def dispatchTurn(c: Client, room: str): Client = { ...c, turnPhase: AfterDispatch, room: if (c.room == "") room else c.room, bindingId: if (c.room == "") c.bindingSerial + 1 else c.bindingId, bindingSerial: if (c.room == "") c.bindingSerial + 1 else c.bindingSerial, stopPhase: NoStop, stopTurn: 0, stopBinding: 0, stoppedRoom: "" }
pure def canInterrupt(c: Client): bool = c.turnPhase != NoTurn
pure def interrupt(c: Client): Client = retireActive(true, c)
pure def canObserveStop(c: Client, turnId: int): bool = c.stopPhase == StopWaiting and turnId == c.stopTurn
pure def observeStop(c: Client, turnId: int, confirmed: bool): Client = { ...c, stopPhase: if (confirmed) StopConfirmed else StopFailed, bindingId: if (not(confirmed) and c.bindingId == c.stopBinding) 0 else c.bindingId, room: if (not(confirmed) and c.bindingId == c.stopBinding) "" else c.room }
pure def canRefuseAfterStop(c: Client): bool = c.turnPhase == BeforeDispatch and c.stopPhase == StopFailed
pure def refuseAfterStop(c: Client): Client = { ...c, turnPhase: NoTurn, activeTurn: 0, stopPhase: NoStop, stopTurn: 0, stopBinding: 0, stoppedRoom: "", result: ClientStopUnconfirmed }
pure def canFinishTurn(c: Client, turnId: int): bool = c.turnPhase != NoTurn and turnId == c.activeTurn
pure def finishTurn(c: Client, turnId: int, successful: bool, ownershipLost: bool): Client = {
  val dropRoom = not(successful) and ownershipLost
  { ...c, turnPhase: NoTurn, activeTurn: 0, bindingId: if (dropRoom) 0 else c.bindingId, room: if (dropRoom) "" else c.room,
    result: if (c.turnPhase == BeforeDispatch) ClientFailureBeforeSend else if (successful) ClientReply else ClientFailureAfterSend }
}
pure val roomValues = Set("", "room-a", "room-b")
pure val turnIdValues = Set(0, 1, 2, 3, 4)
pure def alwaysTurnCoordinates(c: Client): bool = c.generation >= 0 and c.serial >= 0 and c.activeTurn >= 0 and c.activeTurn <= c.serial and (c.turnPhase == NoTurn) == (c.activeTurn == 0)
pure def alwaysRoomOwnsBinding(c: Client): bool = c.bindingSerial >= 0 and c.bindingId >= 0 and c.bindingId <= c.bindingSerial and (c.room == "") == (c.bindingId == 0) and (c.turnPhase == AfterDispatch implies c.bindingId > 0 and c.stopPhase == NoStop)
pure def alwaysStopOwnsDispatchedIdentity(c: Client): bool = if (c.stopPhase == NoStop) c.stopTurn == 0 and c.stopBinding == 0 and c.stoppedRoom == "" else c.stopTurn > 0 and c.stopTurn <= c.serial and c.stopBinding > 0 and c.stopBinding <= c.bindingSerial and c.stoppedRoom != ""
pure def alwaysHistoryOwnsDispatchedTurn(c: Client): bool = c.historyTurn >= 0 and c.historyTurn <= c.serial and (c.historyTurn == 0) == (c.historyRoom == "")
pure def stepSendRetainsHistory(before: Client, via: str, after: Client): bool = (via == "reserve" or via == "dispatchTurn" or via == "finishTurn" or via == "refuseAfterStop" or via == "observeStop") implies after.historyTurn == before.historyTurn and after.historyRoom == before.historyRoom
pure def sometimesPriorStopHistorySurvives(c: Client): bool = c.turnPhase == AfterDispatch and c.historyTurn > 0 and c.historyTurn < c.activeTurn
pure def stepFailedStopKeepsSuccessorRoom(before: Client, via: str, after: Client): bool = (via == "observeStop" and before.bindingId != before.stopBinding) implies (after.bindingId == before.bindingId and after.room == before.room)
pure def sometimesUnconfirmedStopRefusesSend(c: Client): bool = c.result == ClientStopUnconfirmed
pure def sometimesSuccessorSurvivesOldStop(c: Client): bool = c.stopPhase == StopFailed and c.room != "" and c.room != c.stoppedRoom
pure def sometimesReplyPublished(c: Client): bool = c.result == ClientReply
```

### Matching Stop and history responses preserve the original identity

When any user row has a string client-message identifier, a stopped
turn with an ID matches by ID alone. With legacy rows that lack IDs,
use the latest user row in supplied order with the same restored text
and either no numeric timestamp or a time no earlier than two minutes
before dispatch. Repeated text cannot match a different ID. The stable
row index is represented by a positive ordinal at the decoded boundary.

```quint
type HistoryRow = { rowId: int, userRow: bool, hasClientId: bool, clientId: str, hasText: bool, restoredText: str, hasTimestamp: bool, timestamp: int }
type HistoryMatch = { hasClientId: bool, clientId: str, restoredText: str, sentAt: int }
pure val rowValues = Set(
  { rowId: 1, userRow: true, hasClientId: true, clientId: "other", hasText: true, restoredText: "hello", hasTimestamp: true, timestamp: 120001 },
  { rowId: 2, userRow: true, hasClientId: false, clientId: "", hasText: false, restoredText: "", hasTimestamp: false, timestamp: 0 },
  { rowId: 3, userRow: true, hasClientId: false, clientId: "", hasText: true, restoredText: "hello", hasTimestamp: true, timestamp: 1 }
)
pure val seekValues = Set(
  { hasClientId: true, clientId: "send", restoredText: "hello", sentAt: 120001 },
  { hasClientId: false, clientId: "", restoredText: "", sentAt: 0 }
)
pure def stoppedRowMatches(matchesById: bool, seek: HistoryMatch, row: HistoryRow): bool =
  row.userRow and (if (matchesById) row.hasClientId and row.clientId == seek.clientId else row.hasText and row.restoredText == seek.restoredText and (not(row.hasTimestamp) or row.timestamp >= seek.sentAt - 120000))
pure def stoppedHistoryUsesId(rows: List[HistoryRow], seek: HistoryMatch): bool =
  seek.hasClientId and seek.clientId != "" and rows.some(row => row.userRow and row.hasClientId)
pure def rememberStopped(rows: List[HistoryRow], seek: HistoryMatch): int = {
  val matchesById = stoppedHistoryUsesId(rows, seek)
  rows.foldl(0, (found, row) => if (stoppedRowMatches(matchesById, seek, row)) row.rowId else found)
}
pure def lawDifferentIdentifiedUserDoesNotMatch(row: HistoryRow, seek: HistoryMatch): bool =
  (row.userRow and row.hasClientId and seek.hasClientId and seek.clientId != "" and row.clientId != seek.clientId) implies rememberStopped(List(row), seek) == 0
pure def lawLegacyRowNeedsText(row: HistoryRow, seek: HistoryMatch): bool =
  (not(row.hasClientId) and not(row.hasText)) implies rememberStopped(List(row), seek) == 0
pure def admitsStopReceipt(validRecord: bool, aborted: bool, expectedRoom: str, reportedRoom: str, expectedReason: str, reportedReason: str): bool = validRecord and aborted and expectedRoom == reportedRoom and expectedReason == reportedReason
pure def lawStopPreservesTarget(expectedRoom: str, reportedRoom: str, expectedReason: str, reportedReason: str): bool = admitsStopReceipt(true, true, expectedRoom, reportedRoom, expectedReason, reportedReason) implies expectedRoom == reportedRoom and expectedReason == reportedReason
```
