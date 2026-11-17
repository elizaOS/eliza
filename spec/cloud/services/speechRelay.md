# Speech relay protocol

The wire on the one socket of a minted speech session. It is develop's wire
(plan decision D41): `packages/host/src/voice/speech-relay-{wire,session}.ts`
on the pinned branch and `packages/cloud/api/src/speech-relay-coordinator.ts`;
the Android speech bridge (`SpeechStreamBridgePlugin.java`) is its client.

This library has no state. `relayStep` is the relay's answer to one input:
a device frame, or an edge the session or a provider reports. The session
machine (`./speechSession`) holds a `Relay` per socket and owns consent,
windows, budgets and settlement; the device client
(`spec/os/voice/cloudSpeech.md`) reads the same frames. JSON, bytes, token
digests and provider calls stay in the shell (`src/client/relay-frames.ts`
is the codec).

## Story: Speak the relay protocol on one socket

> As a device connected to a minted speech session, I want one greeting that
> proves the session token, the audio format announced once, each utterance
> prepared once, its flushes and its end acknowledged in order, and every end
> of the socket named, so that I can tell an exhausted account from a bad
> token, an outage or my own mistake.

### The wire is version 1 with 16 kHz mono PCM16 and bounded frames

Control frames are JSON of at most 8192 UTF-8 bytes. The device sends
`{t: "hello", token, errorReasons?: true, extend?: true}` (no other key),
`{t: "prepare" | "finish" | "cancel", id}`, `{t: "tts", id, text, flush?}`,
`{t: "stop"}`, and binary PCM16 LE chunks. The relay sends `{t: "ready",
version, sampleRate, channels, expiresAt}`, `{t: "stt", event: {type,
transcript?}}` (a longer transcript from the provider is a provider
failure), `{t: "tts_prepared" | "flush_complete" | "complete", id}`,
`{t: "extended", expiresAt}`, `{t: "error", code, reason?}`, and binary
`[1, idLength, id, PCM16]`. An id matches `[A-Za-z0-9_-]{1,64}`. A frame out
of these bounds is a `ClientViolation`.

```quint
import types.* from "../shared/types"
pure val relayVersion = 1
pure val relaySampleRate = 16000
pure val relayChannels = 1
pure val maxControlBytes = 8192
pure val maxHelloTokenChars = 6144
pure val maxTtsTextChars: CharCount = 1024
pure val maxTranscriptChars: CharCount = 16384
pure val maxUplinkChunkBytes = 3200
pure val maxUtteranceIdChars = 64
pure val maxDownlinkPcmBytes = 65536
pure val helloDeadline: Millis = 5000
pure def validPcm(bytes: int, limit: int): bool = bytes > 0 and bytes % 2 == 0 and bytes <= limit
pure def validUplinkChunk(bytes: int): bool = validPcm(bytes, maxUplinkChunkBytes)
pure def validDownlinkAudio(idChars: int, pcmBytes: int): bool = idChars >= 1 and idChars <= maxUtteranceIdChars and validPcm(pcmBytes, maxDownlinkPcmBytes)
```

### The relay answers each input with frames in the order the input produced them

A relay waits for the hello, opens (the session admits the first window and
starts the providers), is live, or has ended. Each utterance named is open,
finishing, cancelled or done, with its unacknowledged flushes. The shell
sends an answer's frames before it reads the next input, so audio and its
acknowledgements are never reordered.

```quint
type RelayPhase = RelayAwaitingHello | RelayOpening | RelayLive | RelayEnded
type UtteranceStage = UtteranceOpen | UtteranceFinishing | UtteranceCancelled | UtteranceDone
type Utterance = { id: str, stage: UtteranceStage, flushes: int }
type Relay = { phase: RelayPhase, errorReasons: bool, extend: bool, sttConnected: bool, utterances: List[Utterance] }
type SttEventKind = SttConnected | StartOfTurn | TurnResumed | EndOfTurn | TranscriptUpdate | EagerEndOfTurn
type RelayInput =
  ClientHello({ tokenMatches: bool, errorReasons: bool, extend: bool })
  | ClientPrepare({ id: str }) | ClientSpeak({ id: str, flush: bool }) | ClientFinish({ id: str }) | ClientCancel({ id: str })
  | ClientStop | ClientAudio | ClientViolation
  | HelloTimedOut | Admitted | WindowRenewed | ProviderStt({ kind: SttEventKind })
  | ProviderAudio({ id: str }) | ProviderFlushed({ id: str }) | ProviderCompleted({ id: str })
  | ProviderFailed | FundingRefused({ funding: RefusalCode }) | CredentialRefused | SessionOver
type RelayErrorCode = RelayUnauthorized | RelayProtocol | RelayUnavailable | RelayClosed
type RelayReason = NoRelayReason | FundingReason({ funding: RefusalCode })
type ServerFrame =
  ReadyFrame | ExtendedFrame | SttFrame({ kind: SttEventKind })
  | PreparedFrame({ id: str }) | AudioFrame({ id: str }) | FlushedFrame({ id: str }) | CompleteFrame({ id: str })
  | ErrorFrame({ code: RelayErrorCode, reason: RelayReason }) | CloseFrame({ closeCode: int })
type RelayAnswer = { relay: Relay, frames: List[ServerFrame] }
type UtteranceLookup = Unseen | Seen({ stage: UtteranceStage, flushes: int })
pure val relayAtUpgrade: Relay = { phase: RelayAwaitingHello, errorReasons: false, extend: false, sttConnected: false, utterances: List() }
pure def lookupUtterance(r: Relay, id: str): UtteranceLookup = {
  val found = r.utterances.select(u => u.id == id)
  if (found.length() == 0) Unseen else Seen({ stage: found.nthOr(0, { id: id, stage: UtteranceDone, flushes: 0 }).stage, flushes: found.nthOr(0, { id: id, stage: UtteranceDone, flushes: 0 }).flushes })
}
pure def stageIs(r: Relay, id: str, stage: UtteranceStage): bool = {
  val found = lookupUtterance(r, id)
  match found { | Seen(u) => u.stage == stage | Unseen => false }
}
pure def flushesOf(r: Relay, id: str): int = {
  val found = lookupUtterance(r, id)
  match found { | Seen(u) => u.flushes | Unseen => 0 }
}
pure def withUtterance(r: Relay, id: str, stage: UtteranceStage, flushes: int): Relay =
  if (lookupUtterance(r, id) == Unseen) { ...r, utterances: r.utterances.append({ id: id, stage: stage, flushes: flushes }) }
  else { ...r, utterances: r.utterances.listMap(u => if (u.id == id) { id: id, stage: stage, flushes: flushes } else u) }
pure def quiet(r: Relay): RelayAnswer = { relay: r, frames: List() }
pure def answer(r: Relay, frame: ServerFrame): RelayAnswer = { relay: r, frames: List(frame) }
```

### Every end of a socket is one error and a close code for its cause, except a stop the device asked for

A live device's `stop` closes with 1000 and no error. Any other end sends
one `error`, then closes: `unauthorized` (4401) for a wrong token, no hello
within 5 s, or a refused credential; `unavailable` (4402) when funding
refused a window; `closed` (4410) when the session is over (deadline passed
unrenewed, owner revoked it, account deleting); `protocol` (1008) for a
frame that breaks the protocol or the window's budget; `unavailable` (1008)
for a provider or service outage. As in develop, any frame sent while the
relay is opening is refused as `unavailable`. An ended relay answers nothing.

```quint
pure val normalClose = 1000
pure val violationClose = 1008
pure val unauthorizedClose = 4401
pure val fundingClose = 4402
pure val sessionClosedClose = 4410
pure val fundingCodes = Set(InsufficientCredits, AllowanceExhausted)
type EndCause = CauseUnauthorized | CauseProtocol | CauseOutage | CauseFunding({ funding: RefusalCode }) | CauseSessionOver
pure def isFunding(cause: EndCause): bool = match cause { | CauseFunding(f) => fundingCodes.contains(f.funding) | _ => false }
pure def errorCodeOf(cause: EndCause): RelayErrorCode =
  if (cause == CauseUnauthorized) RelayUnauthorized else if (cause == CauseProtocol) RelayProtocol else if (cause == CauseSessionOver) RelayClosed else RelayUnavailable
pure def closeCodeOf(cause: EndCause): int =
  if (cause == CauseUnauthorized) unauthorizedClose else if (isFunding(cause)) fundingClose else if (cause == CauseSessionOver) sessionClosedClose else violationClose
pure def reasonShown(r: Relay, cause: EndCause): RelayReason = match cause { | CauseFunding(f) => if (r.errorReasons and fundingCodes.contains(f.funding)) FundingReason({ funding: f.funding }) else NoRelayReason | _ => NoRelayReason }
pure def endWith(r: Relay, cause: EndCause): RelayAnswer =
  { relay: { ...r, phase: RelayEnded }, frames: List(ErrorFrame({ code: errorCodeOf(cause), reason: reasonShown(r, cause) }), CloseFrame({ closeCode: closeCodeOf(cause) })) }
pure def serverEnding(r: Relay, input: RelayInput): RelayAnswer = match input {
  | FundingRefused(f) => endWith(r, if (fundingCodes.contains(f.funding)) CauseFunding({ funding: f.funding }) else CauseOutage)
  | CredentialRefused => endWith(r, CauseUnauthorized)
  | SessionOver => endWith(r, CauseSessionOver)
  | ProviderFailed => endWith(r, CauseOutage)
  | _ => quiet(r)
}
pure def isServerEnding(input: RelayInput): bool = match input { | FundingRefused(f) => true | CredentialRefused => true | SessionOver => true | ProviderFailed => true | _ => false }
pure def isClientFrame(input: RelayInput): bool = match input {
  | ClientHello(h) => true | ClientPrepare(p) => true | ClientSpeak(p) => true | ClientFinish(p) => true | ClientCancel(p) => true
  | ClientStop => true | ClientAudio => true | ClientViolation => true | _ => false
}
pure def isErrorFrame(f: ServerFrame): bool = match f { | ErrorFrame(e) => true | _ => false }
pure def isCloseFrame(f: ServerFrame): bool = match f { | CloseFrame(c) => true | _ => false }
pure def lawOnlyAStopClosesNormally(r: Relay, input: RelayInput): bool =
  relayStep(r, input).frames.includes(CloseFrame({ closeCode: normalClose })) implies (input == ClientStop and r.phase == RelayLive)
pure def endsNow(r: Relay, a: RelayAnswer): bool = r.phase != RelayEnded and a.relay.phase == RelayEnded
pure def lawEveryEndIsOneErrorThenItsCloseOrAStop(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  (a.frames.some(f => isCloseFrame(f)) iff endsNow(r, a))
  and (endsNow(r, a) implies (a.frames.length() == 2 and isErrorFrame(a.frames.nthOr(0, ReadyFrame)) and isCloseFrame(a.frames.nthOr(1, ReadyFrame)))
    or (a.frames == List(CloseFrame({ closeCode: normalClose })) and input == ClientStop and r.phase == RelayLive))
}
pure def lawAnEndedRelayAnswersNothing(r: Relay, input: RelayInput): bool = r.phase == RelayEnded implies relayStep(r, input) == quiet(r)
```

### Only a hello carrying the session token opens the relay, and ready is sent once the first window is admitted

The first frame must be a hello whose token matches the session's digest;
its `errorReasons` and `extend` flags hold for the socket. Binary audio
first is `unavailable`; anything else first is `unauthorized`. The session
then admits the first window and starts the providers, and only then is
`ready` sent, once.

```quint
pure def beforeHello(r: Relay, input: RelayInput): RelayAnswer = match input {
  | ClientHello(h) => if (h.tokenMatches) quiet({ ...r, phase: RelayOpening, errorReasons: h.errorReasons, extend: h.extend }) else endWith(r, CauseUnauthorized)
  | ClientAudio => endWith(r, CauseOutage)
  | HelloTimedOut => endWith(r, CauseUnauthorized)
  | _ => if (isServerEnding(input)) serverEnding(r, input) else if (isClientFrame(input)) endWith(r, CauseUnauthorized) else quiet(r)
}
pure def whileOpening(r: Relay, input: RelayInput): RelayAnswer =
  if (input == Admitted) answer({ ...r, phase: RelayLive }, ReadyFrame) else if (isServerEnding(input)) serverEnding(r, input) else if (isClientFrame(input)) endWith(r, CauseOutage) else quiet(r)
pure def isTokenHello(input: RelayInput): bool = match input { | ClientHello(h) => h.tokenMatches | _ => false }
pure def lawOnlyTheSessionTokenOpensTheRelay(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  (r.phase == RelayAwaitingHello and a.relay.phase != RelayEnded and a.relay.phase != RelayAwaitingHello) implies (isTokenHello(input) and a.relay.phase == RelayOpening and a.frames == List())
}
pure def lawReadyIsSentOnlyWhenTheOpeningIsAdmitted(r: Relay, input: RelayInput): bool =
  relayStep(r, input).frames.includes(ReadyFrame) iff (r.phase == RelayOpening and input == Admitted)
pure def lawNothingButReadyOrAnEndBeforeTheRelayIsLive(r: Relay, input: RelayInput): bool =
  r.phase != RelayLive implies relayStep(r, input).frames.every(f => f == ReadyFrame or isErrorFrame(f) or isCloseFrame(f))
```

### While live, frames follow the life of each utterance

`prepare`, or the first `tts` of an id, opens the utterance and is answered
with one `tts_prepared`. A `tts` for an open utterance adds text (and a
pending flush when it asks). `finish` moves an open utterance to finishing.
`cancel` cancels any id, and nothing more is sent for it. A frame for a
cancelled id is ignored (a cancel may overtake queued phrases); `prepare`
or `tts` for a finishing or done id, and `finish` for one that is not open,
break the protocol. Provider audio and flush edges are forwarded for an
open or finishing utterance, a flush only while one is pending; the
provider's completion of a finishing utterance is answered with `complete`
and ends it, while completion of one never finished is a provider failure.
`stt` events are forwarded only after `connected`, which is sent once;
uplink audio before it breaks the protocol (a client starts capture on
`connected`). A renewed window is announced only to a hello with `extend`.

```quint
pure def opens(r: Relay, id: str, flushes: int): RelayAnswer =
  if (lookupUtterance(r, id) == Unseen) answer(withUtterance(r, id, UtteranceOpen, flushes), PreparedFrame({ id: id }))
  else if (stageIs(r, id, UtteranceOpen)) quiet(withUtterance(r, id, UtteranceOpen, flushesOf(r, id) + flushes))
  else if (stageIs(r, id, UtteranceCancelled)) quiet(r)
  else endWith(r, CauseProtocol)
pure def speaking(r: Relay, id: str): bool = stageIs(r, id, UtteranceOpen) or stageIs(r, id, UtteranceFinishing)
pure def whileLive(r: Relay, input: RelayInput): RelayAnswer = match input {
  | ClientPrepare(p) => opens(r, p.id, 0)
  | ClientSpeak(p) => opens(r, p.id, if (p.flush) 1 else 0)
  | ClientFinish(p) => if (stageIs(r, p.id, UtteranceOpen)) quiet(withUtterance(r, p.id, UtteranceFinishing, flushesOf(r, p.id))) else if (stageIs(r, p.id, UtteranceCancelled)) quiet(r) else endWith(r, CauseProtocol)
  | ClientCancel(p) => quiet(withUtterance(r, p.id, UtteranceCancelled, 0))
  | ClientStop => { relay: { ...r, phase: RelayEnded }, frames: List(CloseFrame({ closeCode: normalClose })) }
  | ClientAudio => if (r.sttConnected) quiet(r) else endWith(r, CauseProtocol)
  | ClientHello(h) => endWith(r, CauseProtocol)
  | ClientViolation => endWith(r, CauseProtocol)
  | ProviderStt(e) => if (e.kind == SttConnected) (if (r.sttConnected) quiet(r) else answer({ ...r, sttConnected: true }, SttFrame({ kind: SttConnected }))) else if (r.sttConnected) answer(r, SttFrame({ kind: e.kind })) else quiet(r)
  | ProviderAudio(p) => if (speaking(r, p.id)) answer(r, AudioFrame({ id: p.id })) else quiet(r)
  | ProviderFlushed(p) => if (speaking(r, p.id) and flushesOf(r, p.id) > 0) answer(withUtterance(r, p.id, if (stageIs(r, p.id, UtteranceOpen)) UtteranceOpen else UtteranceFinishing, flushesOf(r, p.id) - 1), FlushedFrame({ id: p.id })) else quiet(r)
  | ProviderCompleted(p) => if (stageIs(r, p.id, UtteranceFinishing)) answer(withUtterance(r, p.id, UtteranceDone, 0), CompleteFrame({ id: p.id })) else if (stageIs(r, p.id, UtteranceOpen)) endWith(r, CauseOutage) else quiet(r)
  | WindowRenewed => if (r.extend) answer(r, ExtendedFrame) else quiet(r)
  | _ => serverEnding(r, input)
}
pure def relayStep(r: Relay, input: RelayInput): RelayAnswer =
  if (r.phase == RelayEnded) quiet(r)
  else if (r.phase == RelayAwaitingHello) beforeHello(r, input)
  else if (r.phase == RelayOpening) whileOpening(r, input)
  else whileLive(r, input)
pure def lawAnUtteranceIsPreparedOnce(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  a.frames.includes(PreparedFrame({ id: id })) implies (lookupUtterance(r, id) == Unseen and stageIs(a.relay, id, UtteranceOpen))
}
pure def lawAFlushIsAcknowledgedOnlyWhilePending(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  a.frames.includes(FlushedFrame({ id: id })) implies (flushesOf(r, id) > 0 and flushesOf(a.relay, id) == flushesOf(r, id) - 1)
}
pure def lawCompleteFollowsFinish(r: Relay, input: RelayInput, id: str): bool =
  relayStep(r, input).frames.includes(CompleteFrame({ id: id })) implies stageIs(r, id, UtteranceFinishing)
pure def lawNothingIsSentForACancelledUtterance(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  stageIs(r, id, UtteranceCancelled) implies (stageIs(a.relay, id, UtteranceCancelled) and not(a.frames.includes(PreparedFrame({ id: id })) or a.frames.includes(AudioFrame({ id: id })) or a.frames.includes(FlushedFrame({ id: id })) or a.frames.includes(CompleteFrame({ id: id }))))
}
```

### Turn events and accepted uplink audio follow connected, and extended goes only to a hello that asked

```quint
pure def isTurnFrame(f: ServerFrame): bool = match f { | SttFrame(e) => e.kind != SttConnected | _ => false }
pure def lawConnectedPrecedesTurnsAndAcceptedAudio(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  (a.frames.some(f => isTurnFrame(f)) implies r.sttConnected)
  and (a.frames.includes(SttFrame({ kind: SttConnected })) implies not(r.sttConnected))
  and ((input == ClientAudio and a.relay.phase == RelayLive) implies r.sttConnected)
}
pure def lawExtendedOnlyForAHelloThatAsked(r: Relay, input: RelayInput): bool =
  relayStep(r, input).frames.includes(ExtendedFrame) implies r.extend
```

### Exhausted funding is never reported as a bad token, and its reason is shown only to a hello that asked

A refused window always closes with 4402. Its `error` is `unavailable`, with
the reason `insufficient_credits` or `allowance_exhausted` only for a hello
that sent `errorReasons`; older clients refuse an unknown key, so no other
code ever carries a reason.

```quint
pure def isUnauthorizedFrame(f: ServerFrame): bool = match f { | ErrorFrame(e) => e.code == RelayUnauthorized | _ => false }
pure def lawFundingIsNeverUnauthorized(r: Relay, funding: RefusalCode): bool =
  not(relayStep(r, FundingRefused({ funding: funding })).frames.some(f => isUnauthorizedFrame(f)))
pure def fundingOfReason(reason: RelayReason): RefusalCode = match reason { | FundingReason(x) => x.funding | NoRelayReason => ServiceUnavailable }
pure def frameReasonFits(r: Relay, f: ServerFrame): bool = match f {
  | ErrorFrame(e) => e.reason == NoRelayReason or (e.code == RelayUnavailable and r.errorReasons and fundingCodes.contains(fundingOfReason(e.reason)))
  | _ => true
}
pure def lawAReasonIsShownOnlyToAHelloThatAskedAndOnlyForFunding(r: Relay, input: RelayInput): bool = relayStep(r, input).frames.every(f => frameReasonFits(r, f))
pure def lawRefusedFundingClosesAsFunding(r: Relay, funding: RefusalCode): bool = {
  val a = relayStep(r, FundingRefused({ funding: funding }))
  (r.phase != RelayEnded and fundingCodes.contains(funding)) implies
    (a.frames.includes(CloseFrame({ closeCode: fundingClose })) and (r.errorReasons implies a.frames.nthOr(0, ReadyFrame) == ErrorFrame({ code: RelayUnavailable, reason: FundingReason({ funding: funding }) })))
}
pure val idValues = Set("u1", "u2")
pure val fundingValues = Set(InsufficientCredits, AllowanceExhausted, ServiceUnavailable)
pure val rValues = Set(
  relayAtUpgrade,
  { ...relayAtUpgrade, phase: RelayOpening, errorReasons: true, extend: true },
  { phase: RelayLive, errorReasons: false, extend: false, sttConnected: false, utterances: List() },
  { phase: RelayLive, errorReasons: true, extend: true, sttConnected: true, utterances: List({ id: "u1", stage: UtteranceOpen, flushes: 1 }, { id: "u2", stage: UtteranceFinishing, flushes: 0 }) },
  { phase: RelayLive, errorReasons: true, extend: false, sttConnected: true, utterances: List({ id: "u1", stage: UtteranceCancelled, flushes: 0 }, { id: "u2", stage: UtteranceDone, flushes: 0 }) },
  { phase: RelayEnded, errorReasons: true, extend: true, sttConnected: true, utterances: List({ id: "u1", stage: UtteranceFinishing, flushes: 1 }) })
pure val inputValues = Set(
  ClientHello({ tokenMatches: true, errorReasons: true, extend: true }), ClientHello({ tokenMatches: false, errorReasons: true, extend: false }),
  ClientPrepare({ id: "u1" }), ClientPrepare({ id: "u3" }), ClientSpeak({ id: "u1", flush: true }), ClientSpeak({ id: "u2", flush: false }),
  ClientFinish({ id: "u1" }), ClientFinish({ id: "u2" }), ClientCancel({ id: "u1" }), ClientStop, ClientAudio, ClientViolation,
  HelloTimedOut, Admitted, WindowRenewed, ProviderStt({ kind: SttConnected }), ProviderStt({ kind: EndOfTurn }),
  ProviderAudio({ id: "u1" }), ProviderFlushed({ id: "u1" }), ProviderCompleted({ id: "u1" }), ProviderCompleted({ id: "u2" }),
  ProviderFailed, FundingRefused({ funding: AllowanceExhausted }), FundingRefused({ funding: InsufficientCredits }), CredentialRefused, SessionOver)
```
