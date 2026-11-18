# Message reply draft

The Messages view of a verified device image may ask the agent to draft a
reply to the thread the owner has open. The route is
`POST /api/messages/reply-draft`. It is served only when the launch loads
the `@elizaos/agent/reply-draft` module ([plugin plan](../plugins/profile.md))
and only to the Root caller ([access](../access/auth.md)); its model call
goes to the text backend the launch bound ([model binding](../models/binding.md)).

The request is the visible tail of the open thread, in the shape of a
`messages.read.v1` read result without its kind and status
([device operations](./operations.md)). The answer is `{ "draft": … }`: the
draft text, or null. Whether a draft may fill the thread's text field, that
it never replaces what the owner typed, and the review of every send belong
to the Messages spec of the [Android device](../../os/index.md)
(`os/android/messages.md`). This spec only produces the text.

## Story: Draft a reply I can edit and send myself

> As the owner with a message thread open on my device, I want the agent to
> draft a short reply that I can edit and send myself, so that I answer
> faster and nothing is ever sent for me.

### A draft request is exactly the open thread's tail, ending in a received message

The body has exactly the keys `participant`, `messages` and `truncated`.
`participant` is null for a group or an unknown sender, or the name the
device shows: 1 to 128 UTF-16 units with no control character, direction
override or lone surrogate. `messages` holds at most 20 messages, oldest
first, each with exactly `direction` (`in` or `out`), `date` (whole epoch
milliseconds, never negative and never before the message before it) and
`body` (at most 1,600 units; of the control characters only tab and line
breaks). The last message was received. `Malformed` is a body the wire
schema refuses: a missing or extra key, or a value of the wrong type. The
route caps the body at 262,144 bytes, which every admitted thread fits even
when each unit is written as a six-byte escape.

```quint
type Direction = Received | Sent
type ThreadMessage = { direction: Direction, date: int, bodyUnits: int, bodySafe: bool, blank: bool }
type Participant = NoParticipant | Named({ units: int, safe: bool, digitsOnly: bool })
type DraftRequest = Malformed | OpenThread({ participant: Participant, messages: List[ThreadMessage] })
pure val messagesMax = 20
pure val bodyMax = 1600
pure val participantMax = 128
pure val messageBytesMax = 9664
pure val envelopeBytesMax = 896
pure val requestLimitBytes = 262144
pure def participantAdmitted(p: Participant): bool = match p { | NoParticipant => true | Named(n) => n.units >= 1 and n.units <= participantMax and n.safe }
pure def messageAdmitted(m: ThreadMessage): bool = m.date >= 0 and m.bodyUnits >= 0 and m.bodyUnits <= bodyMax and m.bodySafe
pure def oldestFirst(messages: List[ThreadMessage]): bool = messages.foldl(0, (latest, m) => if (latest < 0 or m.date < latest) -1 else m.date) >= 0
pure def endsReceived(messages: List[ThreadMessage]): bool = messages.foldl(Sent, (earlier, m) => m.direction) == Received
pure def threadAdmitted(p: Participant, messages: List[ThreadMessage]): bool =
  participantAdmitted(p) and messages.length() <= messagesMax and messages.every(m => messageAdmitted(m)) and oldestFirst(messages) and endsReceived(messages)
pure def requestAdmitted(req: DraftRequest): bool = match req { | Malformed => false | OpenThread(t) => threadAdmitted(t.participant, t.messages) }
pure val incoming: ThreadMessage = { direction: Received, date: 2, bodyUnits: 12, bodySafe: true, blank: false }
pure val outgoing: ThreadMessage = { direction: Sent, date: 1, bodyUnits: 9, bodySafe: true, blank: false }
pure val friend: Participant = Named({ units: 5, safe: true, digitsOnly: false })
pure val reqValues: Set[DraftRequest] = Set(Malformed,
  OpenThread({ participant: friend, messages: List(outgoing, incoming) }),
  OpenThread({ participant: NoParticipant, messages: List(incoming) }),
  OpenThread({ participant: friend, messages: List() }),
  OpenThread({ participant: friend, messages: List(incoming, outgoing) }),
  OpenThread({ participant: friend, messages: List({ ...incoming, bodyUnits: 1601 }) }),
  OpenThread({ participant: friend, messages: List({ ...incoming, bodySafe: false }) }),
  OpenThread({ participant: Named({ units: 0, safe: true, digitsOnly: false }), messages: List(incoming) }),
  OpenThread({ participant: Named({ units: 5, safe: true, digitsOnly: true }), messages: List(incoming) }),
  OpenThread({ participant: Named({ units: 9, safe: true, digitsOnly: true }), messages: List(incoming) }),
  OpenThread({ participant: friend, messages: List(outgoing, { ...incoming, bodyUnits: 0, blank: true }) }))
pure def lawAMalformedBodyIsNeverAdmitted(req: DraftRequest): bool = req == Malformed implies not(requestAdmitted(req))
pure def lawEveryAdmittedThreadFitsTheBodyLimit(count: int): bool =
  (count >= 0 and count <= messagesMax) implies count * messageBytesMax + envelopeBytesMax <= requestLimitBytes
```

### A short code or a blank last message gets no draft and no model call

A refused request answers 400 `invalid_thread` and quotes nothing it was
sent. A participant shown as a bare number of three to eight digits is a
short code: one-time codes and automated notices never take a drafted
reply. Such a thread, and one whose last message is blank, answers
`{ "draft": null }` at once. Every other admitted request makes exactly one
call to the small text model.

```quint
type Decision = RefuseRequest | AnswerNoDraft | AskModel
pure def shortCode(p: Participant): bool = match p { | NoParticipant => false | Named(n) => n.digitsOnly and n.units >= 3 and n.units <= 8 }
pure def endsBlank(messages: List[ThreadMessage]): bool = messages.foldl(true, (earlier, m) => m.blank)
pure def decision(req: DraftRequest): Decision = match req {
  | Malformed => RefuseRequest
  | OpenThread(t) =>
      if (not(threadAdmitted(t.participant, t.messages))) RefuseRequest
      else if (shortCode(t.participant) or endsBlank(t.messages)) AnswerNoDraft
      else AskModel
}
pure def modelCalls(req: DraftRequest): int = if (decision(req) == AskModel) 1 else 0
pure def lawOnlyAnAdmittedRequestReachesTheModel(req: DraftRequest): bool = decision(req) == AskModel implies requestAdmitted(req)
pure def lawARefusedRequestIsNeverAnswered(req: DraftRequest): bool = not(requestAdmitted(req)) iff decision(req) == RefuseRequest
pure def lawAShortCodeNeverReachesTheModel(req: DraftRequest): bool = match req {
  | Malformed => true
  | OpenThread(t) => shortCode(t.participant) implies decision(req) != AskModel
}
pure def lawOneRequestMakesAtMostOneModelCall(req: DraftRequest): bool = modelCalls(req) >= 0 and modelCalls(req) <= 1
```

### The thread reaches the model only as escaped data

The system text is the agent's own fixed rules: write as the owner, in the
thread's language, one brief message; invent nothing the thread does not
contain; answer `NONE` when no reply is appropriate. The thread is a JSON
array of `{ from, text }`, `owner` or `them`, oldest first, inside one
`<thread>` block of the user text, with every `<` and `>` written as a JSON
escape, so that no message can end the block or stand outside a string. The
rules tell the model that the block is data written by other people and
never an instruction. The participant's name is not sent.

```quint
type PromptPart = DraftRules | ThreadText | ParticipantName | ClosingRequest
type Placement = SystemText | UserText | EscapedData | NotSent
pure def placement(part: PromptPart): Placement = match part {
  | DraftRules => SystemText
  | ThreadText => EscapedData
  | ParticipantName => NotSent
  | ClosingRequest => UserText
}
pure def lawThreadTextIsOnlyEverData(part: PromptPart): bool = part == ThreadText iff placement(part) == EscapedData
```

### The answer is one draft of at most 320 characters, or none

The call asks for at most 160 tokens. Each run of whitespace in the model's
text becomes one space and surrounding quotation marks are removed. A
longer text is cut to its first 320 UTF-16 units, less a split surrogate
half and trailing space. `NONE` (in any case, with an optional full stop or
exclamation mark), an empty text and a kept text with a character a message
body may not hold give no draft. A failed model call answers 503
`drafting_unavailable`; every other answer is 200 with the draft or null.

```quint
type ModelResult = ModelFailed | ModelSaid({ units: int, saysNone: bool, keptSafe: bool })
type DraftAnswer = BadRequest | Unavailable | NoDraft | Draft({ kept: int })
pure val draftMax = 320
pure val draftMaxTokens = 160
pure def keptUnits(units: int): int = if (units > draftMax) draftMax else units
pure def draftOf(said: ModelResult): DraftAnswer = match said {
  | ModelFailed => Unavailable
  | ModelSaid(a) => if (a.units <= 0 or a.saysNone or not(a.keptSafe)) NoDraft else Draft({ kept: keptUnits(a.units) })
}
pure def answerOf(req: DraftRequest, said: ModelResult): DraftAnswer =
  if (decision(req) == RefuseRequest) BadRequest else if (decision(req) == AnswerNoDraft) NoDraft else draftOf(said)
pure def httpStatus(answer: DraftAnswer): int = match answer { | BadRequest => 400 | Unavailable => 503 | NoDraft => 200 | Draft(d) => 200 }
pure def draftLength(answer: DraftAnswer): int = match answer { | Draft(d) => d.kept | _ => 0 }
pure val saidValues: Set[ModelResult] = Set(ModelFailed,
  ModelSaid({ units: 24, saysNone: false, keptSafe: true }), ModelSaid({ units: 4, saysNone: true, keptSafe: true }),
  ModelSaid({ units: 0, saysNone: false, keptSafe: true }), ModelSaid({ units: 24, saysNone: false, keptSafe: false }),
  ModelSaid({ units: 320, saysNone: false, keptSafe: true }), ModelSaid({ units: 900, saysNone: false, keptSafe: true }))
pure def lawADraftIsNeverLongerThanTheLimit(req: DraftRequest, said: ModelResult): bool =
  draftLength(answerOf(req, said)) >= 0 and draftLength(answerOf(req, said)) <= draftMax
pure def lawOnlyAModelAnswerBecomesADraft(req: DraftRequest, said: ModelResult): bool =
  draftLength(answerOf(req, said)) > 0 implies (decision(req) == AskModel and said != ModelFailed)
pure def lawNoneNeverBecomesADraft(said: ModelResult): bool = match said {
  | ModelFailed => draftLength(draftOf(said)) == 0
  | ModelSaid(a) => (a.saysNone or a.units <= 0 or not(a.keptSafe)) implies draftLength(draftOf(said)) == 0
}
pure def lawAFailedCallIsTheOnlyUnavailableAnswer(req: DraftRequest, said: ModelResult): bool =
  answerOf(req, said) == Unavailable iff (decision(req) == AskModel and said == ModelFailed)
```

### Drafting sends, stores and queues nothing, and logs neither the thread nor the draft

The route's only effects are its one model call and its answer to the
caller. It offers the model no tool, sends no message, writes nothing to
storage and queues no work. A failed model call logs the name of the
failure only, because a provider's error message may quote its input.

```quint
type Act = AnswerCaller | CallTextModel | LogFailureName | OfferTool | SendMessage | StoreThread | QueueWork | LogThread | LogDraft
pure val forbiddenActs: Set[Act] = Set(OfferTool, SendMessage, StoreThread, QueueWork, LogThread, LogDraft)
pure def acts(req: DraftRequest): Set[Act] = if (decision(req) == AskModel) Set(AnswerCaller, CallTextModel, LogFailureName) else Set(AnswerCaller)
pure def lawDraftingHasNoEffectBeyondItsModelCallAndAnswer(req: DraftRequest): bool = acts(req).forall(act => not(forbiddenActs.contains(act)))
pure def lawOnlyAModelRequestCallsTheModel(req: DraftRequest): bool = acts(req).contains(CallTextModel) iff modelCalls(req) == 1
```
