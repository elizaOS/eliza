# Client turns

The browser-safe turn controller a chat screen uses (`TurnController`, with
`bind`, `send`, `interrupt`, `reset` and the stopped-turn lookup). It holds
one conversation binding and at most one turn, and it never stores drafts
or sends on its own. Each send gets a fresh `clientMessageId` (a v4 UUID,
modeled as a positive ordinal); the agent's [turns](../conversation/turns.md)
admit, join or replay a message by that key. The binding is the
conversation record `{id, roomId}` from `POST /api/conversations` or the
conversation list: the room a Stop names is always read from that record.
The shell validates and copies every identity it receives, posts the calls
this machine emits, and reads stream frames ([reply
stream](../conversation/replyStream.md)).

## Story: Stop a reply without sending the next message against an uncertain room

> As the owner, after I press Stop I want my next message sent only once
> the agent has confirmed the stop, so that it never runs beside a reply
> that may still be working.

### A message is posted only to the bound room, one turn at a time, and never while a Stop is waiting or uncertain

A send while a turn is open is refused as `busy`. A reserved send with no
binding first creates a conversation and binds it. A reserved turn that
ends before it is posted was not accepted.

```quint
import turns as T from "../conversation/turns"
type Binding = Unbound | Bound({ conversation: int, room: int })
type Attempt = Streamed | Buffered | Resent
type ClientTurn = Idle | Reserved({ id: int }) | Sent({ id: int, conversation: int, room: int, attempt: Attempt })
type StopState = NoStop | StopWaiting({ turn: int, conversation: int, room: int }) | StopUncertainHeld({ conversation: int })
type StoppedTurn = NoneStopped | StoppedAt({ turn: int, conversation: int })
type TurnOutcome = NoOutcome | Replied | AgentFailed | NotAccepted | MaybeAccepted | ConversationLost | RefusedBusy | RefusedStopUnconfirmed | StoppedByOwner
type ClientCall = PostMessage({ turn: int, room: int, attempt: Attempt }) | PostStop({ turn: int, room: int })
type TurnClient = { generation: int, nextId: int, binding: Binding, turn: ClientTurn, stop: StopState, stopped: StoppedTurn, outcome: TurnOutcome }
type ClientStep = { state: TurnClient, out: List[ClientCall] }
pure val initial: TurnClient = { generation: 0, nextId: 1, binding: Unbound, turn: Idle, stop: NoStop, stopped: NoneStopped, outcome: NoOutcome }
pure def turnId(t: ClientTurn): int = match t { | Reserved(x) => x.id | Sent(x) => x.id | Idle => 0 }
pure def isSent(t: ClientTurn): bool = match t { | Sent(_) => true | _ => false }
pure def sentIn(t: ClientTurn, id: int, a: Attempt): bool = match t { | Sent(x) => x.id == id and x.attempt == a | _ => false }
pure def boundConversation(b: Binding): int = match b { | Bound(x) => x.conversation | Unbound => 0 }
pure def boundRoom(b: Binding): int = match b { | Bound(x) => x.room | Unbound => 0 }
pure def stopTurn(p: StopState): int = match p { | StopWaiting(x) => x.turn | _ => 0 }
pure def heldConversation(p: StopState): int = match p { | StopUncertainHeld(x) => x.conversation | _ => 0 }
pure def stoppedTurnId(s: StoppedTurn): int = match s { | StoppedAt(x) => x.turn | NoneStopped => 0 }
pure def isPost(call: ClientCall): bool = match call { | PostMessage(_) => true | _ => false }
pure def send(c: TurnClient): TurnClient =
  if (c.turn != Idle) { ...c, outcome: RefusedBusy } else { ...c, turn: Reserved({ id: c.nextId }), nextId: c.nextId + 1, outcome: NoOutcome }
pure def canDispatch(c: TurnClient, turn: int, conversation: int, room: int): bool =
  turn >= 1 and c.turn == Reserved({ id: turn }) and c.stop == NoStop and (c.binding != Unbound or (conversation >= 1 and room >= 1))
pure def dispatch(c: TurnClient, turn: int, conversation: int, room: int, streaming: bool): ClientStep = {
  val b = if (c.binding == Unbound) Bound({ conversation: conversation, room: room }) else c.binding
  val a = if (streaming) Streamed else Buffered
  { state: { ...c, binding: b, turn: Sent({ id: turn, conversation: boundConversation(b), room: boundRoom(b), attempt: a }) },
    out: List(PostMessage({ turn: turn, room: boundRoom(b), attempt: a })) }
}
pure val turnValues = Set(1, 2, 3)
pure val conversationValues = Set(1, 2)
pure val roomValues = Set(1, 2)
pure def alwaysTurnsHaveFreshIds(c: TurnClient): bool =
  c.nextId >= 1 and c.generation >= 0 and turnId(c.turn) < c.nextId and (c.turn != Idle implies turnId(c.turn) >= 1) and
  stopTurn(c.stop) >= 0 and stopTurn(c.stop) < c.nextId and stoppedTurnId(c.stopped) >= 0 and stoppedTurnId(c.stopped) < c.nextId
pure def alwaysBindingNamesARoom(c: TurnClient): bool = c.binding == Unbound or (boundConversation(c.binding) >= 1 and boundRoom(c.binding) >= 1)
pure def alwaysASentTurnUsesTheBindingWithNoStop(c: TurnClient): bool = {
  val t = c.turn
  match t { | Sent(x) => c.binding == Bound({ conversation: x.conversation, room: x.room }) and c.stop == NoStop | _ => true }
}
pure def stepNothingIsPostedBesideAStop(before: TurnClient, via: str, after: TurnClient, out: List[ClientCall]): bool =
  out.some(call => isPost(call)) implies before.stop == NoStop
pure def stepAClosedTurnNeverReopens(before: TurnClient, after: TurnClient): bool =
  turnId(after.turn) == turnId(before.turn) or turnId(after.turn) == 0 or turnId(after.turn) >= before.nextId
```

### Stop is posted once for the posted turn, and only a receipt for its room and reason confirms it

Stop ends local publication at once and posts `POST /api/turns/:roomId/abort
{reason: "client-stop"}` for a posted turn; a reserved turn is dropped with
no call. The agent answers `{aborted: true, roomId, reason, outcome}`. Only
a receipt with the same room and reason whose outcome is `stopConfirmed` or
`nothingRunning` confirms the Stop; `stopUncertain`, a malformed answer or a
failed call leaves it uncertain. Stop is never retried. A send waits while
the Stop is waiting.

```quint
type StopReceipt = NoReceipt | Receipt({ room: int, reason: str, outcome: T::StopOutcome })
pure val stopReason = "client-stop"
pure def stopConfirmedBy(receipt: StopReceipt, room: int): bool = match receipt {
  | Receipt(x) => x.room == room and x.reason == stopReason and x.outcome != T::StopUncertain
  | NoReceipt => false }
pure def stopOpen(t: ClientTurn, c: TurnClient): ClientStep = match t {
  | Sent(x) => { state: { ...c, turn: Idle, outcome: StoppedByOwner, stop: StopWaiting({ turn: x.id, conversation: x.conversation, room: x.room }),
      stopped: StoppedAt({ turn: x.id, conversation: x.conversation }) }, out: List(PostStop({ turn: x.id, room: x.room })) }
  | Reserved(_) => { state: { ...c, turn: Idle, outcome: StoppedByOwner }, out: List() }
  | Idle => { state: c, out: List() } }
pure def canInterrupt(c: TurnClient): bool = c.turn != Idle
pure def interrupt(c: TurnClient): ClientStep = stopOpen(c.turn, c)
pure def canObserveStop(c: TurnClient, turn: int): bool = turn >= 1 and stopTurn(c.stop) == turn
pure def observeStop(c: TurnClient, turn: int, receipt: StopReceipt): TurnClient = {
  val p = c.stop
  match p {
    | StopWaiting(x) => if (stopConfirmedBy(receipt, x.room)) { ...c, stop: NoStop }
        else { ...c, stop: StopUncertainHeld({ conversation: x.conversation }), binding: if (boundConversation(c.binding) == x.conversation) Unbound else c.binding }
    | _ => c }
}
pure val receiptValues = Set(NoReceipt, Receipt({ room: 1, reason: "client-stop", outcome: T::StopConfirmed }), Receipt({ room: 1, reason: "client-stop", outcome: T::NothingRunning }),
  Receipt({ room: 1, reason: "client-stop", outcome: T::StopUncertain }), Receipt({ room: 2, reason: "client-stop", outcome: T::StopConfirmed }),
  Receipt({ room: 1, reason: "other", outcome: T::StopConfirmed }))
pure def alwaysAStopNamesItsRoom(c: TurnClient): bool = {
  val p = c.stop
  match p { | StopWaiting(x) => x.turn >= 1 and x.conversation >= 1 and x.room >= 1 | StopUncertainHeld(x) => x.conversation >= 1 | NoStop => true }
}
pure def stepStopIsPostedOnceForTheSentTurn(before: TurnClient, via: str, after: TurnClient, out: List[ClientCall]): bool =
  out.every(call => match call { | PostStop(x) => isSent(before.turn) and turnId(before.turn) == x.turn and turnId(after.turn) != x.turn | _ => true })
pure def sometimesSendWaitsForAStop(c: TurnClient): bool = c.turn != Idle and not(isSent(c.turn)) and stopTurn(c.stop) > 0
```

### An uncertain Stop refuses the next send once and unbinds only the stopped conversation

The refused send is reported as `stop-unconfirmed` and nothing leaves the
device; the send after it goes. A conversation bound after the Stop stays
bound.

```quint
pure def canRefuseAfterStop(c: TurnClient, turn: int): bool = turn >= 1 and c.turn == Reserved({ id: turn }) and heldConversation(c.stop) > 0
pure def refuseAfterStop(c: TurnClient, turn: int): TurnClient = { ...c, turn: Idle, stop: NoStop, outcome: RefusedStopUnconfirmed }
pure def stepUncertainStopUnbindsOnlyItsConversation(before: TurnClient, via: str, after: TurnClient): bool =
  (via == "observeStop" and heldConversation(after.stop) > 0 and heldConversation(before.stop) == 0) implies
    (boundConversation(after.binding) != heldConversation(after.stop) and
      (boundConversation(before.binding) != heldConversation(after.stop) implies after.binding == before.binding))
pure def sometimesUncertainStopRefusedASend(c: TurnClient): bool = c.outcome == RefusedStopUnconfirmed
pure def sometimesLaterConversationKeptAfterAnUncertainStop(c: TurnClient): bool =
  heldConversation(c.stop) > 0 and boundConversation(c.binding) > 0 and boundConversation(c.binding) != heldConversation(c.stop)
```

### Binding another conversation or resetting starts a new generation with no open or stopped turn

Binding another conversation stops a posted turn first; rebinding the same
record changes nothing. Reset (sign-out, teardown) also forgets the Stop it
posts. Every callback, stream update and history read from an older
generation is dropped by the shell.

```quint
pure def canBind(c: TurnClient, conversation: int, room: int): bool =
  conversation >= 1 and room >= 1 and c.binding != Bound({ conversation: conversation, room: room })
pure def bind(c: TurnClient, conversation: int, room: int): ClientStep = {
  val s = stopOpen(c.turn, c)
  { state: { ...s.state, generation: c.generation + 1, binding: Bound({ conversation: conversation, room: room }), stopped: NoneStopped }, out: s.out }
}
pure def resetClient(c: TurnClient): ClientStep = {
  val s = stopOpen(c.turn, c)
  { state: { ...s.state, generation: c.generation + 1, binding: Unbound, stop: NoStop, stopped: NoneStopped }, out: s.out }
}
pure def stepNewGenerationStartsClean(before: TurnClient, after: TurnClient): bool =
  after.generation >= before.generation and (after.generation != before.generation implies (after.turn == Idle and after.stopped == NoneStopped))
```

### A stopped turn's user row is found by its clientMessageId alone, and only its own answer releases it

A posted turn the owner stopped is kept so the screen can find its user row
in a later history read; ordinary sends and Stop receipts keep it. The row
is the newest user row with the same `clientMessageId`; text and time never
match. Only an answer naming the same turn and conversation releases it.

```quint
type HistoryRow = { message: int, fromOwner: bool, clientMessageId: int }
pure def findStopped(rows: List[HistoryRow], turn: int): int =
  rows.foldl(0, (found, r) => if (r.fromOwner and r.clientMessageId == turn) r.message else found)
pure def canReleaseStopped(c: TurnClient, turn: int, conversation: int): bool = c.stopped == StoppedAt({ turn: turn, conversation: conversation })
pure def releaseStopped(c: TurnClient, turn: int, conversation: int): TurnClient = { ...c, stopped: NoneStopped }
pure val rowsValues = Set(List(), List({ message: 1, fromOwner: true, clientMessageId: 1 }),
  List({ message: 1, fromOwner: true, clientMessageId: 2 }, { message: 2, fromOwner: false, clientMessageId: 1 }),
  List({ message: 1, fromOwner: true, clientMessageId: 1 }, { message: 2, fromOwner: true, clientMessageId: 1 }))
pure def lawNoRowMatchesWithoutTheSameId(rows: List[HistoryRow], turn: int): bool =
  rows.every(r => not(r.fromOwner) or r.clientMessageId != turn) implies findStopped(rows, turn) == 0
pure def sometimesStoppedTurnKeptBesideTheNextTurn(c: TurnClient): bool =
  stoppedTurnId(c.stopped) > 0 and isSent(c.turn) and turnId(c.turn) > stoppedTurnId(c.stopped)
```

## Story: Get the reply to my message even when the stream drops

> As the owner, when the connection drops while a reply streams, I want the
> app to fetch that reply once without sending my message twice, so that a
> bad network never makes my agent act twice or hides its answer.

### A stream that drops before its terminal frame is resent once without streaming under the same clientMessageId

`Dropped` is a stream that ends with no terminal frame and no HTTP refusal
after the message was posted; a refusal is one whether the stream opens
with its status or its body raises it. Its resend is `POST …/messages` with
the same body and key, so the agent joins the running turn or replays its
reply.
A refusal (status below 500, a 429 on the resend included), a stream never
posted and a terminal `done` with `failureKind` or `error` frame are
outcomes and are never resent. A resend that drops again, or a dropped
buffered send, may have been accepted; the screen must look at the
conversation before sending again.

```quint
type StreamEnd = Done | FailureFrame | Refusal | NotDispatched | Dropped | ConversationGone
pure def outcomeAfter(ending: StreamEnd): TurnOutcome = match ending {
  | Done => Replied | FailureFrame => AgentFailed | Refusal => NotAccepted | NotDispatched => NotAccepted
  | ConversationGone => ConversationLost | Dropped => MaybeAccepted }
pure def canFinishTurn(c: TurnClient, turn: int): bool = turn >= 1 and turnId(c.turn) == turn
pure def finishTurn(c: TurnClient, turn: int, ending: StreamEnd): ClientStep = {
  val t = c.turn
  match t {
    | Sent(x) => if (x.attempt == Streamed and ending == Dropped)
          { state: { ...c, turn: Sent({ ...x, attempt: Resent }) }, out: List(PostMessage({ turn: x.id, room: x.room, attempt: Resent })) }
        else { state: { ...c, turn: Idle, outcome: outcomeAfter(ending), binding: if (ending == ConversationGone) Unbound else c.binding }, out: List() }
    | _ => { state: { ...c, turn: Idle, outcome: NotAccepted }, out: List() } }
}
pure def stepAtMostOneResendPerTurn(before: TurnClient, via: str, after: TurnClient, out: List[ClientCall]): bool =
  out.every(call => match call { | PostMessage(x) => x.attempt != Resent or (sentIn(before.turn, x.turn, Streamed) and sentIn(after.turn, x.turn, Resent)) | _ => true })
  and ((sentIn(before.turn, turnId(before.turn), Resent) and turnId(after.turn) == turnId(before.turn)) implies sentIn(after.turn, turnId(before.turn), Resent))
pure def sometimesReplied(c: TurnClient): bool = c.outcome == Replied
pure def sometimesResendInFlight(c: TurnClient): bool = sentIn(c.turn, turnId(c.turn), Resent)
pure def sometimesMaybeAccepted(c: TurnClient): bool = c.outcome == MaybeAccepted
pure def sometimesNotAccepted(c: TurnClient): bool = c.outcome == NotAccepted
```

### A conversation the agent no longer has ends the turn as a conversation failure and unbinds it

A 404 for the bound conversation (for example after a launch on another
account's state) is `ConversationGone`; the next send creates a new
conversation.

```quint
pure def stepALostConversationIsUnbound(before: TurnClient, via: str, after: TurnClient): bool =
  (via == "finishTurn" and after.turn == Idle and after.outcome == ConversationLost) implies after.binding == Unbound
pure def sometimesConversationLost(c: TurnClient): bool = c.outcome == ConversationLost and c.binding == Unbound
```
