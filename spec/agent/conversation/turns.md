# Conversation turns

One message in, one reply out. `POST /api/conversations/:id/messages`
(Root) takes `{text, images?, channelType, metadata?, task?,
clientMessageId?}` and answers `{text, agentName, messageId, userMessageId,
actionResults: [{action, data}], taskChoices?, failureKind?, planAction?,
retryAfterMs?}`. The boundary
checks the body before this machine sees it: `channelType` is `DM` or
`VOICE_DM`; images follow core's chat-upload limits; `metadata` is a JSON
object of at most 64 KiB stored with the user message, of which only
`observation` and `voiceUi` are decoded ([turn context](./turnContext.md))
and no key grants anything; `clientMessageId` has at most 128 characters;
the optional header `X-ElizaOS-Client-Id` (`[A-Za-z0-9._-]{1,128}`) binds
view interactions of this turn to one client; `task` goes to the tasks
module. A conversation is its room ([conversations](./conversations.md)).

The shell runs each turn in core's room queue
([concurrency](../../core/concurrency.md), `maxPerRoom = 1`) and stops it
with core's [turn controllers](../../core/turnControllers.md) `abortRoom`;
this machine holds the decisions above them: which message starts a turn,
which repeat replays which reply, what a Stop reports, and what of a reply
was heard. The fingerprint is the shell's positive digest of the body.

## Story: Send one message and get one reply even when the request repeats

> As the owner, I want to send a message again after a dropped connection
> or a restart and get the reply to my first send, never a second reply,
> so that a bad network never makes my agent act twice.

### A quoted reply uses only the selected message from this conversation

When the owner's request includes a message identity in
`metadata.replyToMessageId`, the turn records that reply target only if it
is an earlier message from the owner or the agent in the same conversation.
A system notice cannot be a reply target. An absent, invalid or unavailable
identity leaves an ordinary message. The accepted quotation is presented
as data, preserving its text and whitespace up to 4,096 characters. It
adds no authority to the new request. A retry keeps the original reply.

```quint
pure val replyQuoteChars = 4096
pure def admitsReplyTarget(sameRoom: bool, participant: bool, ordinary: bool): bool =
  sameRoom and participant and ordinary
pure def lawAQuoteStaysWithThisConversation(sameRoom: bool, participant: bool, ordinary: bool): bool =
  admitsReplyTarget(sameRoom, participant, ordinary) implies sameRoom and participant and ordinary
```

### A message is refused, joined, replayed or admitted by its key, its room and the backend

A launch without a text backend answers 503 `INFERENCE_UNAVAILABLE` and
stores nothing. A key whose turn is running joins it and waits; a key
answered in this process within five minutes replays its reply even while
the room is busy; a key seen with another body is 409
`CHAT_IDEMPOTENCY_CONFLICT`. Otherwise a busy room is 429, so a 429 means
the message was not taken. A stored key whose turn left no reply (it ended
without one, or a restart cut it) is answered with an empty reply of kind
`aborted`, written then, and never run again.

```quint
import binding as B from "../models/binding"
type KeyView = NoKey | HeldRunning({ fingerprint: int }) | HeldAnswered({ fingerprint: int, reply: int, live: bool }) | HeldUnanswered({ fingerprint: int })
type Admission = Unkeyed({ turn: int }) | Owner({ turn: int }) | Duplicate | Conflict | Settled({ reply: int }) | Busy | InferenceUnavailable
pure def decide(ready: bool, view: KeyView, keyed: bool, busy: bool, fingerprint: int, fresh: int): Admission =
  if (not(ready)) InferenceUnavailable
  else match view {
    | HeldRunning(x) => if (x.fingerprint != fingerprint) Conflict else Duplicate
    | HeldAnswered(x) => if (not(x.live) and busy) Busy else if (x.fingerprint != fingerprint) Conflict else Settled({ reply: x.reply })
    | HeldUnanswered(x) => if (busy) Busy else if (x.fingerprint != fingerprint) Conflict else Settled({ reply: fresh })
    | NoKey => if (busy) Busy else if (keyed) Owner({ turn: fresh }) else Unkeyed({ turn: fresh })
  }
pure def liveHold(view: KeyView): bool = match view { | HeldRunning(_) => true | HeldAnswered(x) => x.live | _ => false }
pure def heldWith(view: KeyView): int = match view {
  | HeldRunning(x) => x.fingerprint | HeldAnswered(x) => x.fingerprint | HeldUnanswered(x) => x.fingerprint | NoKey => 0 }
pure val viewValues = Set(NoKey, HeldRunning({ fingerprint: 1 }), HeldAnswered({ fingerprint: 1, reply: 3, live: true }),
  HeldAnswered({ fingerprint: 1, reply: 3, live: false }), HeldUnanswered({ fingerprint: 1 }))
pure val fingerprintValues = Set(1, 2)
pure val freshValues = Set(7)
pure def lawBusyMeansNotTaken(ready: bool, view: KeyView, keyed: bool, busy: bool, fingerprint: int, fresh: int): bool =
  decide(ready, view, keyed, busy, fingerprint, fresh) == Busy implies (busy and not(liveHold(view)))
pure def lawConflictOnlyForAnotherBody(ready: bool, view: KeyView, keyed: bool, busy: bool, fingerprint: int, fresh: int): bool =
  decide(ready, view, keyed, busy, fingerprint, fresh) == Conflict implies (view != NoKey and heldWith(view) != fingerprint)
pure def lawAHeldKeyNeverStartsATurn(ready: bool, view: KeyView, keyed: bool, busy: bool, fingerprint: int, fresh: int): bool =
  view != NoKey implies (decide(ready, view, keyed, busy, fingerprint, fresh) != Owner({ turn: fresh }) and decide(ready, view, keyed, busy, fingerprint, fresh) != Unkeyed({ turn: fresh }))
pure def lawNoBackendAdmitsNothing(view: KeyView, keyed: bool, busy: bool, fingerprint: int, fresh: int): bool =
  decide(false, view, keyed, busy, fingerprint, fresh) == InferenceUnavailable
```

### A room runs one turn at a time, and only an admitted or recovered message changes anything

A keyed turn leaves a durable record on its user message (room, key,
fingerprint), so a repeat finds it after a restart. The user message and
its turn share one id.

```quint
pure val receiptRetentionMs = 300000
type TurnPhase = Running | Stopping({ requestedAt: int }) | StopUnconfirmed
type Turn = { id: int, room: int, key: str, startedAt: int, phase: TurnPhase }
type KeyPhase = KeyRunning({ turn: int }) | KeyAnswered({ reply: int, settledAt: int, boot: int }) | KeyUnanswered
type KeyRecord = { room: int, key: str, fingerprint: int, userMessage: int, phase: KeyPhase }
type ReplyKind = Answered | AccountFailed({ failure: B::AccountFailure }) | TimedOut | Aborted | Unfinished
type Heard = NotReported | HeardUpTo({ boundary: int })
type Reply = { id: int, room: int, userMessage: int, units: List[int], kind: ReplyKind, heard: Heard }
type StopOutcome = StopConfirmed | StopUncertain | NothingRunning
type HeardVerdict = HeardRecorded | HeardUnchanged | HeardConflict | HeardNotAgentReply
type TurnAnswer = SendAnswered({ admission: Admission }) | ReplyReady({ turn: int, reply: int }) | ReplyUnavailable({ turn: int })
  | StopAnswered({ room: int, outcome: StopOutcome }) | HeardAnswered({ reply: int, verdict: HeardVerdict })
type Turns = { turns: List[Turn], records: List[KeyRecord], replies: List[Reply], nextId: int, clock: int, boot: int }
type TurnStep = { state: Turns, out: List[TurnAnswer] }
pure val initial: Turns = { turns: List(), records: List(), replies: List(), nextId: 1, clock: 0, boot: 0 }
pure val noRecord: KeyRecord = { room: 0, key: "", fingerprint: 0, userMessage: 0, phase: KeyUnanswered }
pure val noTurn: Turn = { id: 0, room: 0, key: "", startedAt: 0, phase: Running }
pure def timeAt(s: Turns, now: int): int = if (now > s.clock) now else s.clock
pure def roomBusy(s: Turns, room: int): bool = s.turns.some(t => t.room == room)
pure def recordAt(s: Turns, room: int, key: str): KeyRecord = s.records.select(q => q.room == room and q.key == key).nthOr(0, noRecord)
pure def runningTurn(p: KeyPhase): int = match p { | KeyRunning(x) => x.turn | _ => 0 }
pure def answeredReply(p: KeyPhase): int = match p { | KeyAnswered(x) => x.reply | _ => 0 }
pure def holdOf(p: KeyPhase, fingerprint: int, boot: int, t: int): KeyView = match p {
  | KeyRunning(_) => HeldRunning({ fingerprint: fingerprint })
  | KeyAnswered(x) => HeldAnswered({ fingerprint: fingerprint, reply: x.reply, live: x.boot == boot and t <= x.settledAt + receiptRetentionMs })
  | KeyUnanswered => HeldUnanswered({ fingerprint: fingerprint }) }
pure def viewOf(s: Turns, room: int, key: str, t: int): KeyView = {
  val q = recordAt(s, room, key)
  if (key == "" or q.room == 0) NoKey else holdOf(q.phase, q.fingerprint, s.boot, t)
}
pure def admission(s: Turns, room: int, key: str, fingerprint: int, now: int, inferenceReady: bool): Admission =
  decide(inferenceReady, viewOf(s, room, key, timeAt(s, now)), key != "", roomBusy(s, room), fingerprint, s.nextId)
pure def canSend(s: Turns, room: int, key: str, fingerprint: int, now: int, inferenceReady: bool): bool = room >= 1 and fingerprint >= 1
pure def send(s: Turns, room: int, key: str, fingerprint: int, now: int, inferenceReady: bool): TurnStep = {
  val t = timeAt(s, now)
  val view = viewOf(s, room, key, t)
  val a = decide(inferenceReady, view, key != "", roomBusy(s, room), fingerprint, s.nextId)
  val answer = List(SendAnswered({ admission: a }))
  val started: Turns = { ...s, turns: s.turns.append({ id: s.nextId, room: room, key: key, startedAt: t, phase: Running }), nextId: s.nextId + 1, clock: t }
  val cut: Reply = { id: s.nextId, room: room, userMessage: recordAt(s, room, key).userMessage, units: List(), kind: Unfinished, heard: NotReported }
  match a {
    | Unkeyed(_) => { state: started, out: answer }
    | Owner(_) => { state: { ...started, records: s.records.append({ room: room, key: key, fingerprint: fingerprint, userMessage: s.nextId, phase: KeyRunning({ turn: s.nextId }) }) }, out: answer }
    | Settled(_) => match view {
        | HeldUnanswered(_) => { state: { ...s, replies: s.replies.append(cut), nextId: s.nextId + 1, clock: t,
            records: s.records.listMap(q => if (q.room == room and q.key == key) { ...q, phase: KeyAnswered({ reply: s.nextId, settledAt: t, boot: s.boot }) } else q) }, out: answer }
        | _ => { state: s, out: answer } }
    | _ => { state: s, out: answer }
  }
}
pure val roomValues = Set(1, 2)
pure val keyValues = Set("", "k1")
pure val nowValues = Set(0, 6000, 200000, 400000)
pure def alwaysOneTurnPerRoomWithFreshIds(s: Turns): bool =
  s.nextId >= 1 and s.turns.every(t => t.id >= 1 and t.id < s.nextId and t.room >= 1 and s.turns.select(u => u.room == t.room).length() == 1 and s.turns.select(u => u.id == t.id).length() == 1) and
  s.replies.every(r => r.id >= 1 and r.id < s.nextId and s.replies.select(x => x.id == r.id).length() == 1)
pure def alwaysKeyedTurnsHoldTheirRecord(s: Turns): bool =
  s.records.every(q => q.key != "" and q.room >= 1 and q.userMessage >= 1 and q.userMessage < s.nextId and s.records.select(o => o.room == q.room and o.key == q.key).length() == 1 and
    (runningTurn(q.phase) > 0 implies (q.userMessage == runningTurn(q.phase) and s.turns.some(t => t.id == runningTurn(q.phase) and t.room == q.room and t.key == q.key)))) and
  s.turns.every(t => t.key != "" implies s.records.some(q => q.room == t.room and q.key == t.key and runningTurn(q.phase) == t.id))
pure def isRefusalOrReplay(a: TurnAnswer): bool = match a {
  | SendAnswered(x) => x.admission == Duplicate or x.admission == Conflict or x.admission == Busy or x.admission == InferenceUnavailable
  | _ => false }
pure def stepRefusalsAndRepeatsStoreNothing(before: Turns, via: str, after: Turns, out: List[TurnAnswer]): bool =
  (via == "send" and out.some(a => isRefusalOrReplay(a))) implies after == before
pure def stepARecordedKeyNeverRunsAgain(before: Turns, after: Turns): bool =
  after.turns.every(t => before.turns.some(b => b.id == t.id) or t.key == "" or not(before.records.some(q => q.room == t.room and q.key == t.key)))
pure def sometimesAnsweredKeyWhileTheRoomIsBusy(s: Turns): bool =
  s.records.some(q => answeredReply(q.phase) > 0 and roomBusy(s, q.room))
```

### Every turn ends once, storing its reply with its kind, or answering that no reply exists

A reply is `answered`, an account failure named by the
[binding](../models/binding.md) (`credential_invalid`,
`insufficient_credits`, `limit_reached`, `provider_issue`), `timeout` after
180 s, or `aborted` (a Stop, a dropped stream, shutdown, or a restart). A
failed turn stores what it wrote with its kind, and a failure no cause
names is a `provider_issue` (below). A turn that stores no agent message
answers 503 `ASSISTANT_RESPONSE_UNAVAILABLE`, and its key keeps no reply.

```quint
pure val turnDeadlineMs = 180000
pure val stopConfirmMs = 5000
pure def failureKind(k: ReplyKind): str = match k {
  | Answered => "" | AccountFailed(x) => B::failureName(x.failure) | TimedOut => "timeout" | Aborted => "aborted" | Unfinished => "aborted" }
pure def turnAt(s: Turns, turn: int): Turn = s.turns.select(t => t.id == turn).nthOr(0, noTurn)
pure def stopAnswerOnEnd(room: int, p: TurnPhase, t: int): List[TurnAnswer] = match p {
  | Stopping(x) => List(StopAnswered({ room: room, outcome: if (t <= x.requestedAt + stopConfirmMs) StopConfirmed else StopUncertain }))
  | _ => List() }
pure def settleKey(records: List[KeyRecord], turn: int, p: KeyPhase): List[KeyRecord] =
  records.listMap(q => if (runningTurn(q.phase) == turn) { ...q, phase: p } else q)
pure def canEndTurn(s: Turns, turn: int, kind: ReplyKind, now: int): bool =
  turn >= 1 and turnAt(s, turn).id == turn and kind != Unfinished and (kind == TimedOut implies timeAt(s, now) >= turnAt(s, turn).startedAt + turnDeadlineMs)
pure def endTurn(s: Turns, turn: int, kind: ReplyKind, units: List[int], now: int): TurnStep = {
  val tr = turnAt(s, turn)
  val t = timeAt(s, now)
  { state: { ...s, turns: s.turns.select(x => x.id != turn), nextId: s.nextId + 1, clock: t,
      replies: s.replies.append({ id: s.nextId, room: tr.room, userMessage: turn, units: units, kind: kind, heard: NotReported }),
      records: settleKey(s.records, turn, KeyAnswered({ reply: s.nextId, settledAt: t, boot: s.boot })) },
    out: List(ReplyReady({ turn: turn, reply: s.nextId })).concat(stopAnswerOnEnd(tr.room, tr.phase, t)) }
}
pure def canEndWithoutReply(s: Turns, turn: int): bool = turn >= 1 and turnAt(s, turn).id == turn
pure def endWithoutReply(s: Turns, turn: int, now: int): TurnStep = {
  val tr = turnAt(s, turn)
  val t = timeAt(s, now)
  { state: { ...s, turns: s.turns.select(x => x.id != turn), clock: t, records: settleKey(s.records, turn, KeyUnanswered) },
    out: List(ReplyUnavailable({ turn: turn })).concat(stopAnswerOnEnd(tr.room, tr.phase, t)) }
}
pure val turnValues = Set(1, 2, 3)
pure val kindValues = Set(Answered, AccountFailed({ failure: B::ProviderIssue }), AccountFailed({ failure: B::InsufficientCredits }), TimedOut, Aborted)
pure val unitsValues = Set(List(), List(104, 105), List(104, 105, 32, 33))
pure def alwaysAnsweredKeysNameTheirReply(s: Turns): bool =
  s.records.every(q => answeredReply(q.phase) > 0 implies s.replies.some(r => r.id == answeredReply(q.phase) and r.room == q.room and r.userMessage == q.userMessage))
pure def sometimesAccountFailureStored(s: Turns): bool = s.replies.some(r => failureKind(r.kind) == "insufficient_credits")
pure def sometimesTimedOut(s: Turns): bool = s.replies.some(r => r.kind == TimedOut)
pure def sometimesKeyLeftWithoutReply(s: Turns): bool = s.records.some(q => q.phase == KeyUnanswered)
```

### A failed reply names the owner's fix, and only a live rate limit carries its wait

The fix follows the failure kind: `sign-in` for a refused credential,
`funding` for spent credits or allowance, `retry` for a provider issue. A
rate limit, a timeout and a stop name none: waiting, or sending again, is
the fix. A rate-limited reply answered live carries `retryAfterMs`, the
milliseconds from the answer to the binding's retry time, never negative.
A replay, the history and a limit whose retry time is unknown carry none,
so a client never restarts a stale wait.

```quint
pure def accountFailed(k: ReplyKind): bool = match k { | AccountFailed(_) => true | _ => false }
pure def planActionOf(k: ReplyKind): str =
  if (failureKind(k) == "credential_invalid") "sign-in"
  else if (failureKind(k) == "insufficient_credits") "funding"
  else if (failureKind(k) == "provider_issue") "retry"
  else ""
pure def retryAtIn(k: ReplyKind): int = match k { | AccountFailed(x) => B::retryAtOf(x.failure) | _ => -1 }
pure def providerWaitMs(k: ReplyKind, now: int): int =
  if (retryAtIn(k) <= 0) -1 else if (retryAtIn(k) > now) retryAtIn(k) - now else 0
pure val endedValues = Set(Answered, TimedOut, Aborted, AccountFailed({ failure: B::ProviderIssue }), AccountFailed({ failure: B::InsufficientCredits }),
  AccountFailed({ failure: B::CredentialInvalid({ version: 1 }) }), AccountFailed({ failure: B::LimitReached({ retryAt: 0 }) }),
  AccountFailed({ failure: B::LimitReached({ retryAt: 200000 }) }))
pure def lawOnlyAnAccountFailureNamesAFix(ended: ReplyKind): bool = planActionOf(ended) != "" implies accountFailed(ended)
pure def lawARateLimitNamesNoFix(ended: ReplyKind): bool = failureKind(ended) == "limit_reached" implies planActionOf(ended) == ""
pure def lawOnlyARateLimitCarriesAWait(ended: ReplyKind, now: int): bool = providerWaitMs(ended, now) >= 0 implies failureKind(ended) == "limit_reached"
pure def lawAWaitEndsAtTheRetryTime(ended: ReplyKind, now: int): bool = providerWaitMs(ended, now) > 0 implies now + providerWaitMs(ended, now) == retryAtIn(ended)
```

### A reply that spent credits on a refusal naming Cloud's own code carries that code, and every other reply carries none

A turn ended `insufficient_credits` by a model refusal that carries Cloud's
own code (the [binding](../models/binding.md)'s `cloudCode`,
`insufficient_credits` or `allowance_exhausted`) stores it with the reply,
and the reply, its replay and its `done` frame carry it as `cloudCode`, so a
client can tell an account out of plan allowance and credits from any other
spent-credits failure. Every other reply carries none: an answer, another
kind, and spent credits the binding recorded without that code.

```quint
pure def cloudCodeOn(k: ReplyKind, refused: B::FundsCode): str =
  if (failureKind(k) == "insufficient_credits") B::fundsCodeName(refused) else ""
pure val refusedValues = Set(B::NoFundsCode, B::CreditsSpent, B::AllowanceSpent)
pure def lawOnlySpentCreditsCarriesACloudCode(ended: ReplyKind, refused: B::FundsCode): bool =
  cloudCodeOn(ended, refused) != "" implies (failureKind(ended) == "insufficient_credits" and planActionOf(ended) == "funding")
pure def lawSpentCreditsCarriesTheCodeTheRefusalNamed(refused: B::FundsCode): bool =
  cloudCodeOn(AccountFailed({ failure: B::InsufficientCredits }), refused) == B::fundsCodeName(refused)
```

### A rate-limited reply stores who set the limit, and every other reply stores none

A turn ended `limit_reached` by a model refusal that names who set the limit
(the [binding](../models/binding.md)'s `provider` or `cloud`) stores it with
the reply as `limitOrigin`, so the stored conversation tells a limit of
Cloud's own from the model provider's. Every other reply stores none: an
answer, another kind, and a limit the binding enforced from a refusal in
an earlier turn. The origin is never part of the reply's text.

```quint
pure def limitOriginOn(storedKind: str, origin: B::LimitOrigin): str =
  if (storedKind == B::failureName(B::LimitReached({ retryAt: 0 }))) B::limitOriginName(origin) else ""
pure val storedKindValues = Set("", "limit_reached", "provider_issue", "aborted")
pure val originValues = Set(B::NoLimitOrigin, B::ProviderSetLimit, B::CloudSetLimit)
pure def lawOnlyARateLimitedReplyStoresAnOrigin(storedKind: str, origin: B::LimitOrigin): bool =
  limitOriginOn(storedKind, origin) != "" implies storedKind == "limit_reached"
pure def lawARateLimitedReplyKeepsTheOriginTheRefusalNamed(origin: B::LimitOrigin): bool =
  limitOriginOn("limit_reached", origin) == B::limitOriginName(origin)
```

### A re-send the binding refuses for the limit its turn met keeps who set that limit

When a turn's model call is rate limited and the turn re-sends it once, the
binding may refuse the re-send itself because the limit is still in force,
and that refusal names no origin. The turn then keeps the origin of the
refusal it met, so its rate-limited reply still says whether the model
provider or Cloud set the limit. A re-send refused by a new refusal that
names its own origin keeps that one.

```quint
pure def originAfterResend(met: B::LimitOrigin, again: B::LimitOrigin): B::LimitOrigin =
  if (again == B::NoLimitOrigin) met else again
pure val metValues = Set(B::NoLimitOrigin, B::ProviderSetLimit, B::CloudSetLimit)
pure val againValues = Set(B::NoLimitOrigin, B::ProviderSetLimit, B::CloudSetLimit)
pure def lawAHeldResendKeepsTheOriginTheTurnMet(met: B::LimitOrigin): bool =
  originAfterResend(met, B::NoLimitOrigin) == met
pure def lawANamedResendKeepsItsOwnOrigin(met: B::LimitOrigin, again: B::LimitOrigin): bool =
  again != B::NoLimitOrigin implies originAfterResend(met, again) == again
```

### A turn that failed before any reply, for no cause the binding named, is stored as a provider issue

A turn that fails without being stopped stores what it wrote with the
kind of its cause: the model refusal that ended it, else the account
failure the binding recorded since the turn began. A failure neither
names (a call that threw outside the binding, storage that could not be
read, a turn whose steps produced no reply) is one a later send may get
past, so it is stored as `provider_issue`: the owner sees a failed reply
that offers Retry, not 503 and nothing in the conversation. Once the
turn's reply is stored, a later unnamed failure stores no second message.

```quint
pure def storedFailureName(named: str, replied: bool): str =
  if (named != "") named else if (replied) "" else B::failureName(B::ProviderIssue)
pure val namedValues = Set("", "credential_invalid", "insufficient_credits", "limit_reached", "provider_issue")
pure def lawANamedFailureKeepsItsKind(named: str, replied: bool): bool = named != "" implies storedFailureName(named, replied) == named
pure def lawAnUnnamedFailureBeforeAnyReplyIsAProviderIssueThatOffersRetry(named: str): bool =
  named == "" implies (storedFailureName(named, false) == failureKind(AccountFailed({ failure: B::ProviderIssue })) and planActionOf(AccountFailed({ failure: B::ProviderIssue })) == "retry")
pure def lawAStoredReplyIsNeverFollowedByAnUnnamedFailure(named: str): bool = named == "" implies storedFailureName(named, true) == ""
```

### An interrupted reply keeps proof of an applied effect

An abort, timeout, named account failure or provider issue stores
`cutOffEffect: "applied"` on its reply if an action in this turn supplied an applied receipt with a
durable or provider-accepted commit made during the turn. A receipt marked
as replayed, a receipt undone by a recorded rollback and a Calendar
approval request provide no proof of an applied change. The marker is
absent when the turn was cut before the receipt arrived or is recovered
after a restart with no stored reply.

A message POST with the request header `x-eliza-device-cut-off-effect: applied`
gets the stored marker on its buffered or streamed reply. The header does
not change the key, content, or outcome of a turn. An initial answer, a
joined request and a same-key replay each honor their own header. No
receipt identifier or action payload is disclosed by the marker.

```quint
pure def carriesCutOffEffect(interrupted: bool, confirmedApplied: bool): bool =
  interrupted and confirmedApplied
pure def publishesCutOffEffect(stored: bool, negotiated: bool): bool =
  stored and negotiated
```

### An aborted reply records what ended its turn, and never in its text

An `aborted` reply stores `abortCause`, a code naming what ended its turn,
so a stopped reply can be told from a dropped one afterwards: `stop` for a
Stop, `client_left` when the client that sent or streams the turn left,
`runtime` when the runtime ended the turn's work without either, and
`restart` for a turn a restart cut. Whichever reached the turn first names
it. A Stop's reason is stored with it as `stopReason` when the reason is a
code: a letter, then at most 63 letters, digits, `_`, `-`, `.` or `:`. A
`timeout` and every other kind store no cause. The cause is never part of
the reply's text, its frames or its speech.

```quint
type TurnEnder = StopEnded | ClientEnded | RuntimeEnded
pure def abortCauseOf(ended: ReplyKind, ender: TurnEnder): str = match ended {
  | Aborted => match ender { | StopEnded => "stop" | ClientEnded => "client_left" | RuntimeEnded => "runtime" }
  | Unfinished => "restart"
  | _ => "" }
pure val enderValues = Set(StopEnded, ClientEnded, RuntimeEnded)
pure def lawOnlyAnAbortedReplyNamesWhatEndedIt(ended: ReplyKind, ender: TurnEnder): bool =
  (abortCauseOf(ended, ender) != "") iff (failureKind(ended) == "aborted")
pure def lawACutTurnNamesTheRestart(ender: TurnEnder): bool = abortCauseOf(Unfinished, ender) == "restart"
```

### After a restart a repeat replays the stored reply, and a turn the restart cut is never run again

A restart loses every running turn and every five-minute receipt; the
durable records stay, and a record whose turn was running keeps no reply.

```quint
pure def answeredBoot(p: KeyPhase): int = match p { | KeyAnswered(x) => x.boot | _ => -1 }
pure def restart(s: Turns): Turns =
  { ...s, turns: List(), boot: s.boot + 1, records: s.records.listMap(q => if (runningTurn(q.phase) > 0) { ...q, phase: KeyUnanswered } else q) }
pure def sometimesCutTurnAnsweredAfterRestart(s: Turns): bool = s.boot >= 1 and s.replies.some(r => r.kind == Unfinished)
pure def sometimesReplayAfterRestart(s: Turns): bool =
  s.turns.length() == 0 and s.records.some(q => answeredReply(q.phase) > 0 and answeredBoot(q.phase) < s.boot)
```

## Story: Stop a reply and know whether it stopped

> As the owner, I want Stop to tell me whether the reply really stopped, so
> that I never send my next message beside a turn that may still be
> working.

### A Stop is confirmed only when its turn ends within five seconds, and is otherwise uncertain

`POST /api/turns/:roomId/abort {reason}` signals the room's turn through
core's turn controllers and answers `{aborted: true, roomId, reason,
outcome}`. A room with no turn answers `nothingRunning`. A Stop on a turn
already stopping joins that Stop's answer. A turn whose Stop is uncertain
keeps its room until it ends, so the next message is 429, and a later Stop
waits again.

```quint
pure def turnInRoom(s: Turns, room: int): Turn = s.turns.select(t => t.room == room).nthOr(0, noTurn)
pure def stopPending(p: TurnPhase): bool = match p { | Stopping(_) => true | _ => false }
pure def stopWindowOpen(p: TurnPhase, t: int): bool = match p { | Stopping(x) => t <= x.requestedAt + stopConfirmMs | _ => false }
pure def canRequestStop(s: Turns, room: int, now: int): bool = room >= 1
pure def requestStop(s: Turns, room: int, now: int): TurnStep = {
  val tr = turnInRoom(s, room)
  val t = timeAt(s, now)
  if (tr.id == 0) { state: s, out: List(StopAnswered({ room: room, outcome: NothingRunning })) }
  else if (stopPending(tr.phase)) { state: s, out: List() }
  else { state: { ...s, clock: t, turns: s.turns.listMap(x => if (x.id == tr.id) { ...x, phase: Stopping({ requestedAt: t }) } else x) }, out: List() }
}
pure def canStopDeadline(s: Turns, room: int, now: int): bool = stopPending(turnInRoom(s, room).phase) and not(stopWindowOpen(turnInRoom(s, room).phase, timeAt(s, now)))
pure def stopDeadline(s: Turns, room: int, now: int): TurnStep =
  { state: { ...s, clock: timeAt(s, now), turns: s.turns.listMap(x => if (x.room == room) { ...x, phase: StopUnconfirmed } else x) },
    out: List(StopAnswered({ room: room, outcome: StopUncertain })) }
pure def stepStopAnswersAreTrue(before: Turns, via: str, after: Turns, out: List[TurnAnswer]): bool =
  out.every(a => match a {
    | StopAnswered(x) => (x.outcome == StopConfirmed implies (not(roomBusy(after, x.room)) and before.turns.some(t => t.room == x.room and stopWindowOpen(t.phase, after.clock))))
        and (x.outcome == NothingRunning implies not(roomBusy(before, x.room)))
        and (x.outcome == StopUncertain implies before.turns.some(t => t.room == x.room and stopPending(t.phase)))
    | _ => true })
pure def sometimesStopUncertainHoldsTheRoom(s: Turns): bool = s.turns.some(t => t.phase == StopUnconfirmed)
pure def sometimesStoppedReplyStored(s: Turns): bool = s.replies.some(r => r.kind == Aborted) and s.turns.length() == 0
```

## Story: Remember what of a spoken reply was heard

> As the owner, when I cut a spoken reply short, I want my agent to know
> which part I heard, while the written reply stays whole, so that it does
> not assume I heard the rest.

### A heard report only moves the heard boundary of an agent reply back, and never changes the reply

`POST /api/conversations/:id/messages/:messageId/heard` takes `{heardText}`
or `{nothingHeard: true}`. Heard text must be nonblank and a prefix of the
reply as written, as written with whitespace runs collapsed, or as spoken:
the reply's speech text, without its markdown, addresses, code and stage
directions, whitespace collapsed. A collapsed or spoken prefix stands for
the shortest prefix of the reply's UTF-16 units that says it, a spoken one
cut at the end of a word; a report the whole reply says is heard to its
end. It records the boundary at the end of that prefix, nothing heard at
zero. A report past the current boundary, or not a prefix, is 409
`CONVERSATION_HEARD_NOT_PREFIX`; one at the boundary is `unchanged`; an id
that is not an agent reply of this conversation is 404. A reply heard to
its end needs no boundary. The reply is its whole stored text: a reply too
long to keep inline (over 64 KiB) is read back from its stored segments,
so its heard text is compared with all of it.

```quint
import streamUnits.* from "../../core/streamUnits"
type HeardReport = HeardText({ text: List[int] }) | NothingHeard
pure val noReply: Reply = { id: 0, room: 0, userMessage: 0, units: List(), kind: Answered, heard: NotReported }
pure def heardBoundary(h: Heard, whole: int): int = match h { | HeardUpTo(x) => x.boundary | NotReported => whole }
pure def boundaryOf(r: Reply): int = heardBoundary(r.heard, r.units.length())
pure def reportedUnits(report: HeardReport): int = match report { | HeardText(x) => x.text.length() | NothingHeard => 0 }
pure def prefixReport(units: List[int], report: HeardReport): bool = match report {
  | HeardText(x) => trimUnits(x.text).length() > 0 and unitPrefix(units, x.text) | NothingHeard => true }
pure def heardVerdict(s: Turns, room: int, reply: int, report: HeardReport): HeardVerdict = {
  val r = s.replies.select(x => x.id == reply).nthOr(0, noReply)
  val n = reportedUnits(report)
  if (r.id == 0 or r.room != room) HeardNotAgentReply
  else if (not(prefixReport(r.units, report)) or n > boundaryOf(r)) HeardConflict
  else if (n == boundaryOf(r)) HeardUnchanged else HeardRecorded
}
pure def canReportHeard(s: Turns, room: int, reply: int, report: HeardReport): bool = room >= 1 and reply >= 1
pure def reportHeard(s: Turns, room: int, reply: int, report: HeardReport): TurnStep = {
  val verdict = heardVerdict(s, room, reply, report)
  { state: if (verdict != HeardRecorded) s else { ...s, replies: s.replies.listMap(x => if (x.id == reply) { ...x, heard: HeardUpTo({ boundary: reportedUnits(report) }) } else x) },
    out: List(HeardAnswered({ reply: reply, verdict: verdict })) }
}
pure val replyValues = Set(2, 3, 4)
pure val reportValues = Set(NothingHeard, HeardText({ text: List(104) }), HeardText({ text: List(104, 105) }), HeardText({ text: List(32) }), HeardText({ text: List(105) }))
pure def alwaysHeardBoundaryInsideTheReply(s: Turns): bool = s.replies.every(r => boundaryOf(r) >= 0 and boundaryOf(r) <= r.units.length())
pure def stepStoredRepliesStayWhole(before: Turns, after: Turns): bool =
  before.replies.every(r => after.replies.some(x => x.id == r.id and x.room == r.room and x.userMessage == r.userMessage and x.units == r.units and x.kind == r.kind and boundaryOf(x) <= boundaryOf(r)))
pure def sometimesNothingHeard(s: Turns): bool = s.replies.some(r => r.units.length() > 0 and boundaryOf(r) == 0)
pure def sometimesPartHeard(s: Turns): bool = s.replies.some(r => boundaryOf(r) > 0 and boundaryOf(r) < r.units.length())
```

### The heard part and the unheard remainder together are the whole reply

The next turn's context shows the stored reply with its unheard remainder
marked; nothing is dropped, a reply read back from its stored segments
included. A message whose stored segments are missing or do not match its
digest is shown as a note that its text could not be read back, never left
out of the history.

```quint
pure def heardPart(r: Reply): List[int] = sliceUnits(r.units, 0, boundaryOf(r))
pure def unheardPart(r: Reply): List[int] = sliceUnits(r.units, boundaryOf(r), r.units.length())
pure val rValues = Set({ ...noReply, id: 2, units: List(104, 105, 33), heard: HeardUpTo({ boundary: 1 }) }, { ...noReply, id: 2, units: List(104, 105) },
  { ...noReply, id: 3, units: List(104), heard: HeardUpTo({ boundary: 0 }) })
pure def lawHeardAndUnheardMakeTheReply(r: Reply): bool =
  (boundaryOf(r) >= 0 and boundaryOf(r) <= r.units.length()) implies heardPart(r).concat(unheardPart(r)) == r.units
```
