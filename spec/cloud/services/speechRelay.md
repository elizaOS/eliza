# Speech relay protocol

The wire on the one socket of a minted speech session. Each socket holds a
`Relay`; `relayStep` answers one device frame or one provider or session edge
with the frames the shell sends before the next input. Consent, windows and
receipts are [the speech session's](./speechSession.md); the device side is
`spec/os/voice/cloudSpeech.md`.

## Story: Speak the relay protocol on one socket

> As a device on a speech session, I want the relay to answer each frame in
> order and say why it ends, so that I can tell an exhausted account from a
> bad token or an outage.

### Every frame on the wire stays within its bound

Control frames are JSON of at most 8192 UTF-8 bytes. The device sends
`{t: "hello", token, errorReasons?: true, extend?: true}` (token 1 to 6144
chars), `{t: "prepare" | "finish" | "cancel", id}`, `{t: "tts", id, text,
flush?}` (text 1 to 1024 chars, not blank), `{t: "stop"}`, and binary PCM16
LE chunks, 16 kHz mono (even, 2 to 3200 bytes). The relay sends `{t: "ready",
version: 1, sampleRate: 16000, channels: 1, expiresAt}`, `{t: "stt", event:
{type, transcript?}}` (transcript at most 16384 chars), `{t: "tts_prepared" |
"flush_complete" | "complete", id}`, `{t: "extended", expiresAt}`, `{t:
"error", code, reason?}`, and binary `[1, idLength, id, PCM16]`. An id matches
`[A-Za-z0-9_-]{1,64}`. The codec owns these bounds and the frame round
trips; a control frame out of bounds is a `ClientViolation`, a binary one a
`ClientBadAudio`.

```quint
import types.* from "../shared/types"
pure val relayVersion = 1
pure val relaySampleRate = 16000
pure val relayChannels = 1
pure val maxControlBytes = 8192
pure val maxHelloTokenChars: CharCount = 6144
pure val maxTtsTextChars: CharCount = 1024
pure val maxTranscriptChars: CharCount = 16384
pure val maxUplinkChunkBytes = 3200
pure val maxUtteranceIdChars = 64
pure val maxDownlinkPcmBytes = 65536
pure val helloDeadline: Millis = 5000
pure def validPcm(bytes: int, limit: int): bool = bytes > 0 and bytes % 2 == 0 and bytes <= limit
pure def validDownlinkAudio(idChars: int, pcmBytes: int): bool =
  idChars >= 1 and idChars <= maxUtteranceIdChars and validPcm(pcmBytes, maxDownlinkPcmBytes)
```

### A step keeps the relay well formed

While a relay opens, its `stt` edges are held, at most 64, and `connected`
is held exactly when it has arrived. Each utterance remembers whether audio
was forwarded since its last acknowledged flush. Each live window admits 64
new ids. `Shortfall` is the relay's own name for the two funding refusals,
built by the session from its funding observation. Close code 1008, develop's
only refusal code, stays for a protocol break and an outage.

```quint
type RelayPhase = RelayAwaitingHello | RelayOpening | RelayLive | RelayEnded
type UtteranceStage = UtteranceOpen | UtteranceFinishing | UtteranceCancelled | UtteranceDone
type Utterance = { id: str, stage: UtteranceStage, heard: bool }
type SttEventKind = SttConnected | StartOfTurn | TurnResumed | EndOfTurn | TranscriptUpdate | EagerEndOfTurn
type Shortfall = CreditsShort | AllowanceShort
type RelayErrorCode = RelayUnauthorized | RelayProtocol | RelayUnavailable | RelayClosed
type RelayReason = NoRelayReason | FundingReason({ funding: Shortfall })
type ServerFrame =
  ReadyFrame | ExtendedFrame | SttFrame({ kind: SttEventKind })
  | PreparedFrame({ id: str }) | AudioFrame({ id: str }) | FlushedFrame({ id: str }) | CompleteFrame({ id: str })
  | ErrorFrame({ code: RelayErrorCode, reason: RelayReason }) | CloseFrame({ closeCode: int })
type Relay = { phase: RelayPhase, errorReasons: bool, extend: bool, sttConnected: bool, windows: int, pending: List[ServerFrame], utterances: List[Utterance] }
type RelayInput =
  ClientHello({ tokenMatches: bool, errorReasons: bool, extend: bool })
  | ClientPrepare({ id: str }) | ClientSpeak({ id: str, flush: bool }) | ClientFinish({ id: str }) | ClientCancel({ id: str })
  | ClientStop | ClientAudio | ClientBadAudio | ClientViolation
  | HelloTimedOut | Admitted | WindowRenewed | ProviderStt({ kind: SttEventKind, transcriptChars: CharCount })
  | ProviderAudio({ id: str }) | ProviderFlushed({ id: str }) | ProviderCompleted({ id: str })
  | ProviderFailed | FundingRefused({ funding: Shortfall }) | CredentialRefused | SessionOver
type RelayAnswer = { relay: Relay, frames: List[ServerFrame] }
type EndCause = CauseUnauthorized | CauseProtocol | CauseOutage | CauseFunding({ funding: Shortfall }) | CauseSessionOver
pure val maxPendingFrames = 64
pure val maxUtterancesPerWindow = 64
pure val normalClose = 1000
pure val violationClose = 1008
pure val unauthorizedClose = 4401
pure val fundingClose = 4402
pure val sessionClosedClose = 4410
pure val relayAtUpgrade: Relay = { phase: RelayAwaitingHello, errorReasons: false, extend: false, sttConnected: false, windows: 0, pending: List(), utterances: List() }
pure def seen(r: Relay, id: str): bool = r.utterances.some(u => u.id == id)
pure def stageIs(r: Relay, id: str, stage: UtteranceStage): bool = r.utterances.some(u => u.id == id and u.stage == stage)
pure def heardOf(r: Relay, id: str): bool = r.utterances.some(u => u.id == id and u.heard)
pure def speaking(r: Relay, id: str): bool = stageIs(r, id, UtteranceOpen) or stageIs(r, id, UtteranceFinishing)
pure def withUtterance(r: Relay, id: str, stage: UtteranceStage): Relay =
  if (not(seen(r, id))) { ...r, utterances: r.utterances.append({ id: id, stage: stage, heard: false }) }
  else { ...r, utterances: r.utterances.listMap(u => if (u.id == id) { ...u, stage: stage } else u) }
pure def withHeard(r: Relay, id: str, heard: bool): Relay = { ...r, utterances: r.utterances.listMap(u => if (u.id == id) { ...u, heard: heard } else u) }
pure def roomFor(r: Relay, id: str): bool = seen(r, id) or r.utterances.length() < maxUtterancesPerWindow * r.windows
pure def acceptsAudio(r: Relay): bool = r.phase == RelayLive and r.sttConnected
pure def quiet(r: Relay): RelayAnswer = { relay: r, frames: List() }
pure def answer(r: Relay, frame: ServerFrame): RelayAnswer = { relay: r, frames: List(frame) }
pure def isSttFrame(f: ServerFrame): bool = match f { | SttFrame(e) => true | _ => false }
pure def isTurnFrame(f: ServerFrame): bool = match f { | SttFrame(e) => e.kind != SttConnected | _ => false }
pure def isErrorFrame(f: ServerFrame): bool = match f { | ErrorFrame(e) => true | _ => false }
pure def isCloseFrame(f: ServerFrame): bool = match f { | CloseFrame(c) => true | _ => false }
pure def errorCodeOf(cause: EndCause): RelayErrorCode = match cause { | CauseUnauthorized => RelayUnauthorized | CauseProtocol => RelayProtocol | CauseSessionOver => RelayClosed | _ => RelayUnavailable }
pure def closeCodeOf(cause: EndCause): int = match cause { | CauseUnauthorized => unauthorizedClose | CauseFunding(f) => fundingClose | CauseSessionOver => sessionClosedClose | _ => violationClose }
pure def reasonShown(r: Relay, cause: EndCause): RelayReason =
  match cause { | CauseFunding(f) => if (r.errorReasons) FundingReason({ funding: f.funding }) else NoRelayReason | _ => NoRelayReason }
pure def endWith(r: Relay, cause: EndCause): RelayAnswer =
  { relay: { ...r, phase: RelayEnded, pending: List() }, frames: List(ErrorFrame({ code: errorCodeOf(cause), reason: reasonShown(r, cause) }), CloseFrame({ closeCode: closeCodeOf(cause) })) }
pure def isServerEnding(input: RelayInput): bool = match input { | FundingRefused(f) => true | CredentialRefused => true | SessionOver => true | ProviderFailed => true | _ => false }
pure def serverEnding(r: Relay, input: RelayInput): RelayAnswer = match input { | FundingRefused(f) => endWith(r, CauseFunding({ funding: f.funding }))
  | CredentialRefused => endWith(r, CauseUnauthorized) | SessionOver => endWith(r, CauseSessionOver) | ProviderFailed => endWith(r, CauseOutage) | _ => quiet(r) }
pure def isClientFrame(input: RelayInput): bool = match input { | ClientHello(h) => true | ClientPrepare(p) => true | ClientSpeak(p) => true
  | ClientFinish(p) => true | ClientCancel(p) => true | ClientStop => true | ClientAudio => true | ClientBadAudio => true | ClientViolation => true | _ => false }
pure def deliver(r: Relay, frame: ServerFrame): RelayAnswer =
  if (r.phase == RelayLive) answer(r, frame)
  else if (r.pending.length() >= maxPendingFrames) endWith(r, CauseOutage)
  else quiet({ ...r, pending: r.pending.append(frame) })
pure def onStt(r: Relay, kind: SttEventKind, transcriptChars: CharCount): RelayAnswer =
  if (kind != SttConnected and transcriptChars > maxTranscriptChars) endWith(r, CauseOutage)
  else if ((kind == SttConnected) == r.sttConnected) quiet(r)
  else deliver({ ...r, sttConnected: true }, SttFrame({ kind: kind }))
pure def beforeHello(r: Relay, input: RelayInput): RelayAnswer = match input {
  | ClientHello(h) => if (h.tokenMatches) quiet({ ...r, phase: RelayOpening, errorReasons: h.errorReasons, extend: h.extend }) else endWith(r, CauseUnauthorized)
  | ClientAudio => endWith(r, CauseOutage)
  | ClientBadAudio => endWith(r, CauseOutage)
  | HelloTimedOut => endWith(r, CauseUnauthorized)
  | _ => if (isServerEnding(input)) serverEnding(r, input) else if (isClientFrame(input)) endWith(r, CauseUnauthorized) else quiet(r)
}
pure def whileOpening(r: Relay, input: RelayInput): RelayAnswer = match input {
  | Admitted => { relay: { ...r, phase: RelayLive, windows: 1, pending: List() }, frames: List(ReadyFrame).concat(r.pending) }
  | ProviderStt(e) => onStt(r, e.kind, e.transcriptChars)
  | _ => if (isServerEnding(input)) serverEnding(r, input) else if (isClientFrame(input)) endWith(r, CauseOutage) else quiet(r)
}
pure def opens(r: Relay, id: str): RelayAnswer =
  if (not(roomFor(r, id))) endWith(r, CauseProtocol)
  else if (not(seen(r, id))) answer(withUtterance(r, id, UtteranceOpen), PreparedFrame({ id: id }))
  else if (stageIs(r, id, UtteranceOpen) or stageIs(r, id, UtteranceCancelled)) quiet(r)
  else endWith(r, CauseProtocol)
pure def whileLive(r: Relay, input: RelayInput): RelayAnswer = match input {
  | ClientPrepare(p) => opens(r, p.id)
  | ClientSpeak(p) => opens(r, p.id)
  | ClientFinish(p) => if (stageIs(r, p.id, UtteranceOpen)) quiet(withUtterance(r, p.id, UtteranceFinishing))
      else if (stageIs(r, p.id, UtteranceCancelled) or stageIs(r, p.id, UtteranceDone)) quiet(r) else endWith(r, CauseProtocol)
  | ClientCancel(p) => if (roomFor(r, p.id)) quiet(withUtterance(r, p.id, UtteranceCancelled)) else endWith(r, CauseProtocol)
  | ClientStop => { relay: { ...r, phase: RelayEnded }, frames: List(CloseFrame({ closeCode: normalClose })) }
  | ClientAudio => quiet(r)
  | ClientBadAudio => endWith(r, CauseProtocol)
  | ClientHello(h) => endWith(r, CauseProtocol)
  | ClientViolation => endWith(r, CauseProtocol)
  | ProviderStt(e) => onStt(r, e.kind, e.transcriptChars)
  | ProviderAudio(p) => if (speaking(r, p.id)) answer(withHeard(r, p.id, true), AudioFrame({ id: p.id })) else quiet(r)
  | ProviderFlushed(p) => if (speaking(r, p.id) and heardOf(r, p.id)) answer(withHeard(r, p.id, false), FlushedFrame({ id: p.id })) else quiet(r)
  | ProviderCompleted(p) => if (speaking(r, p.id)) answer(withUtterance(r, p.id, UtteranceDone), CompleteFrame({ id: p.id })) else quiet(r)
  | WindowRenewed => if (r.extend) answer({ ...r, windows: r.windows + 1 }, ExtendedFrame) else quiet({ ...r, windows: r.windows + 1 })
  | _ => serverEnding(r, input)
}
pure def relayStep(r: Relay, input: RelayInput): RelayAnswer =
  if (r.phase == RelayEnded) quiet(r)
  else if (r.phase == RelayAwaitingHello) beforeHello(r, input)
  else if (r.phase == RelayOpening) whileOpening(r, input)
  else whileLive(r, input)
pure def relayWellFormed(r: Relay): bool =
  r.utterances.every(u => r.utterances.select(v => v.id == u.id).length() == 1)
  and (r.phase == RelayAwaitingHello implies (not(r.errorReasons) and not(r.extend) and not(r.sttConnected) and r.windows == 0 and r.utterances == List()))
  and (r.phase == RelayOpening implies (r.windows == 0 and r.utterances == List() and r.pending.length() <= maxPendingFrames
    and r.pending.every(f => isSttFrame(f)) and (r.sttConnected iff r.pending.includes(SttFrame({ kind: SttConnected })))))
  and (r.phase != RelayOpening implies r.pending == List())
  and (r.phase == RelayLive implies (r.windows >= 1 and r.utterances.length() <= maxUtterancesPerWindow * r.windows))
pure def endsNow(r: Relay, a: RelayAnswer): bool = r.phase != RelayEnded and a.relay.phase == RelayEnded
pure def endedAs(a: RelayAnswer, code: RelayErrorCode, closeCode: int): bool =
  a.relay.phase == RelayEnded and a.frames == List(ErrorFrame({ code: code, reason: NoRelayReason }), CloseFrame({ closeCode: closeCode }))
pure def lawStepKeepsTheRelayWellFormed(r: Relay, input: RelayInput): bool =
  relayWellFormed(relayAtUpgrade) and (relayWellFormed(r) implies relayWellFormed(relayStep(r, input).relay))
pure val idValues = Set("u1", "u2")
pure val transcriptCharsValues = Set(0, 16384, 16385)
pure val rValues = Set(
  { phase: RelayAwaitingHello, errorReasons: false, extend: false, sttConnected: false, windows: 0, pending: List(), utterances: List() },
  { phase: RelayOpening, errorReasons: true, extend: true, sttConnected: false, windows: 0, pending: List(), utterances: List() },
  { phase: RelayOpening, errorReasons: false, extend: false, sttConnected: true, windows: 0, pending: List(SttFrame({ kind: SttConnected }), SttFrame({ kind: StartOfTurn })), utterances: List() },
  { phase: RelayLive, errorReasons: false, extend: false, sttConnected: false, windows: 1, pending: List(), utterances: List() },
  { phase: RelayLive, errorReasons: true, extend: true, sttConnected: true, windows: 1, pending: List(), utterances: List({ id: "u1", stage: UtteranceOpen, heard: true }, { id: "u2", stage: UtteranceFinishing, heard: false }) },
  { phase: RelayLive, errorReasons: true, extend: false, sttConnected: true, windows: 2, pending: List(), utterances: List({ id: "u1", stage: UtteranceCancelled, heard: false }, { id: "u2", stage: UtteranceDone, heard: false }) },
  { phase: RelayEnded, errorReasons: true, extend: true, sttConnected: true, windows: 1, pending: List(), utterances: List({ id: "u1", stage: UtteranceFinishing, heard: true }) })
pure val inputValues = Set(
  ClientHello({ tokenMatches: true, errorReasons: true, extend: true }), ClientHello({ tokenMatches: false, errorReasons: true, extend: false }),
  ClientPrepare({ id: "u1" }), ClientPrepare({ id: "u3" }), ClientSpeak({ id: "u1", flush: true }), ClientSpeak({ id: "u2", flush: false }),
  ClientFinish({ id: "u1" }), ClientFinish({ id: "u2" }), ClientCancel({ id: "u1" }), ClientCancel({ id: "u4" }),
  ClientStop, ClientAudio, ClientBadAudio, ClientViolation, HelloTimedOut, Admitted, WindowRenewed,
  ProviderStt({ kind: SttConnected, transcriptChars: 0 }), ProviderStt({ kind: EndOfTurn, transcriptChars: 12 }), ProviderStt({ kind: TranscriptUpdate, transcriptChars: 20000 }),
  ProviderAudio({ id: "u1" }), ProviderAudio({ id: "u2" }), ProviderFlushed({ id: "u1" }), ProviderFlushed({ id: "u2" }),
  ProviderCompleted({ id: "u1" }), ProviderCompleted({ id: "u2" }),
  ProviderFailed, FundingRefused({ funding: AllowanceShort }), FundingRefused({ funding: CreditsShort }), CredentialRefused, SessionOver)
```

### Only a hello carrying the session token opens the relay

The hello's `errorReasons` and `extend` flags hold for the socket. A binary
frame first, well formed or not, ends the relay as `unavailable`, as in
develop; any other frame first ends it as `unauthorized`.

```quint
pure def isTokenHello(input: RelayInput): bool = match input { | ClientHello(h) => h.tokenMatches | _ => false }
pure def lawOnlyTheSessionTokenOpensTheRelay(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  (r.phase == RelayAwaitingHello and a.relay.phase != RelayEnded and a.relay.phase != RelayAwaitingHello) implies (isTokenHello(input) and a.relay.phase == RelayOpening and a.frames == List())
}
pure def lawAudioBeforeTheHelloIsUnavailable(r: Relay, input: RelayInput): bool =
  (r.phase == RelayAwaitingHello and (input == ClientAudio or input == ClientBadAudio)) implies endedAs(relayStep(r, input), RelayUnavailable, violationClose)
```

### Ready and then the held edges are sent once, when the first window is admitted

The session admits the first window and starts the providers before `ready`.
A device frame sent while the relay opens ends it as `unavailable`, as in
develop.

```quint
pure def lawReadyThenHeldEdgesOnlyWhenTheOpeningIsAdmitted(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  relayWellFormed(r) implies (
    (a.frames.includes(ReadyFrame) iff (r.phase == RelayOpening and input == Admitted))
    and ((r.phase == RelayOpening and input == Admitted) implies a.frames == List(ReadyFrame).concat(r.pending))
    and (r.phase != RelayLive implies a.frames.every(f => f == ReadyFrame or isErrorFrame(f) or isCloseFrame(f) or (input == Admitted and r.pending.includes(f)))))
}
```

### Turn events and accepted uplink audio follow connected, which is sent once

The shell forwards uplink audio to the provider only while `acceptsAudio`
holds, and the device starts capture on `connected`.

```quint
pure def lawConnectedPrecedesTurnsAndAcceptedAudio(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  val sent = a.frames.concat(a.relay.pending)
  val connected = SttFrame({ kind: SttConnected })
  relayWellFormed(r) implies (
    (sent.some(f => isTurnFrame(f)) implies (a.relay.sttConnected or a.relay.phase == RelayEnded))
    and (a.frames.includes(connected) implies (not(r.sttConnected) or r.pending.includes(connected)))
    and ((a.relay.sttConnected and not(r.sttConnected) and a.relay.phase != RelayEnded) implies sent.includes(connected))
    and ((acceptsAudio(a.relay) and not(acceptsAudio(r))) implies a.frames.includes(connected)))
}
```

### While live, each utterance is answered in the order of its life

`prepare`, or the first `tts` of an id, opens it with one `tts_prepared`;
`finish` moves an open one to finishing; `cancel` cancels any id, and nothing
more is sent for it. A frame for a cancelled id, and `finish` for a done one,
is ignored, since a cancel or the provider's end may overtake queued phrases;
`prepare` or `tts` for a finishing or done id, and `finish` twice or unseen,
break the protocol. A flush is acknowledged only after audio forwarded since
the last one. The provider may complete before `finish` (develop
`speech-relay-session.ts:1142-1145`), so the plan's "`complete` follows
`finish`" is replaced; `completedBeforeFinish` tells the session to mark that
TTS settlement uncertain.

```quint
pure def completedBeforeFinish(r: Relay, input: RelayInput): bool =
  match input { | ProviderCompleted(p) => r.phase == RelayLive and stageIs(r, p.id, UtteranceOpen) | _ => false }
pure def lawUtteranceFramesFollowItsStage(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  relayWellFormed(r) implies (
    (a.frames.includes(PreparedFrame({ id: id })) implies (not(seen(r, id)) and stageIs(a.relay, id, UtteranceOpen)))
    and (a.frames.includes(FlushedFrame({ id: id })) implies (heardOf(r, id) and not(heardOf(a.relay, id))))
    and (a.frames.includes(CompleteFrame({ id: id })) implies (speaking(r, id) and stageIs(a.relay, id, UtteranceDone))))
}
pure def opensId(input: RelayInput, id: str): bool = match input { | ClientPrepare(p) => p.id == id | ClientSpeak(p) => p.id == id | _ => false }
pure def lawLiveAnswersEachUtteranceEdge(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  (relayWellFormed(r) and r.phase == RelayLive) implies (
    ((opensId(input, id) and not(seen(r, id)) and roomFor(r, id)) implies a.frames == List(PreparedFrame({ id: id })))
    and ((input == ProviderAudio({ id: id }) and speaking(r, id)) implies a.frames == List(AudioFrame({ id: id })))
    and ((input == ProviderFlushed({ id: id }) and speaking(r, id) and heardOf(r, id)) implies a.frames == List(FlushedFrame({ id: id })))
    and ((input == ProviderCompleted({ id: id }) and speaking(r, id)) implies a.frames == List(CompleteFrame({ id: id }))))
}
pure def lawNothingIsSentForACancelledUtterance(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  (relayWellFormed(r) and stageIs(r, id, UtteranceCancelled)) implies (stageIs(a.relay, id, UtteranceCancelled)
    and not(a.frames.includes(PreparedFrame({ id: id })) or a.frames.includes(AudioFrame({ id: id }))
      or a.frames.includes(FlushedFrame({ id: id })) or a.frames.includes(CompleteFrame({ id: id }))))
}
```

### A renewed window is announced with extended exactly when the hello asked for it

```quint
pure def lawExtendedOnlyForAHelloThatAsked(r: Relay, input: RelayInput): bool =
  relayWellFormed(r) implies (relayStep(r, input).frames.includes(ExtendedFrame) iff (r.phase == RelayLive and r.extend and input == WindowRenewed))
```

### Every end is one error and the close code of its cause, except a stop the device asked for

A live `stop` closes with 1000 and no error. Otherwise: `unauthorized`
(4401) for a wrong token, no hello within 5 s or a refused credential;
`unavailable` (4402) for refused funding; `closed` (4410) when the session is
over; `protocol` (1008) for a protocol break, a 65th new id in a window
included; `unavailable` (1008) for an outage, a transcript over 16384 chars
or a 65th held edge included. An ended relay answers nothing. Develop closed
a missing hello with 1008 and no error, answered a repeated hello or a bad
frame after it with `unavailable`, and had no `closed`; the Android bridge
reads no close code and needs no change.

```quint
pure def lawEveryEndIsOneErrorThenItsCloseOrAStop(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  val stopped = a.frames == List(CloseFrame({ closeCode: normalClose }))
  relayWellFormed(r) implies (
    (a.frames.some(f => isCloseFrame(f)) iff endsNow(r, a))
    and (stopped implies (input == ClientStop and r.phase == RelayLive))
    and (endsNow(r, a) implies (stopped or (a.frames.length() == 2 and isErrorFrame(a.frames.nthOr(0, ReadyFrame))
      and isCloseFrame(a.frames.nthOr(1, ReadyFrame)) and a.frames.nthOr(1, ReadyFrame) != CloseFrame({ closeCode: normalClose })))))
}
pure def breaksTheLiveProtocol(input: RelayInput): bool = match input { | ClientHello(h) => true | ClientBadAudio => true | ClientViolation => true | _ => false }
pure def lawEachEndNamesItsCause(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  (relayWellFormed(r) and r.phase != RelayEnded) implies (
    ((input == CredentialRefused or (input == HelloTimedOut and r.phase == RelayAwaitingHello)) implies endedAs(a, RelayUnauthorized, unauthorizedClose))
    and (input == SessionOver implies endedAs(a, RelayClosed, sessionClosedClose))
    and (input == ProviderFailed implies endedAs(a, RelayUnavailable, violationClose))
    and ((r.phase == RelayOpening and isClientFrame(input)) implies endedAs(a, RelayUnavailable, violationClose))
    and ((r.phase == RelayLive and breaksTheLiveProtocol(input)) implies endedAs(a, RelayProtocol, violationClose)))
}
pure def lawFullCapsEndTheRelay(r: Relay, id: str, kind: SttEventKind, transcriptChars: CharCount): bool = {
  val stt = relayStep(r, ProviderStt({ kind: kind, transcriptChars: transcriptChars }))
  relayWellFormed(r) implies (
    ((r.phase == RelayLive and not(seen(r, id)) and r.utterances.length() == maxUtterancesPerWindow * r.windows)
      implies endedAs(relayStep(r, ClientPrepare({ id: id })), RelayProtocol, violationClose))
    and ((r.phase == RelayOpening and r.pending.length() == maxPendingFrames and kind != SttConnected) implies endedAs(stt, RelayUnavailable, violationClose))
    and (((r.phase == RelayOpening or r.phase == RelayLive) and kind != SttConnected and transcriptChars > maxTranscriptChars)
      implies endedAs(stt, RelayUnavailable, violationClose)))
}
```

### A refused window closes as funding with 4402, never as unauthorized

```quint
pure def lawRefusedFundingClosesAsFundingNeverUnauthorized(r: Relay, funding: Shortfall): bool = {
  val a = relayStep(r, FundingRefused({ funding: funding }))
  r.phase != RelayEnded implies (a.frames == List(
    ErrorFrame({ code: RelayUnavailable, reason: if (r.errorReasons) FundingReason({ funding: funding }) else NoRelayReason }),
    CloseFrame({ closeCode: fundingClose })))
}
```

### A reason is shown only to a hello that asked, and only for funding

The reason is `insufficient_credits` or `allowance_exhausted`.

```quint
pure def hasReason(f: ServerFrame): bool = match f { | ErrorFrame(e) => e.reason != NoRelayReason | _ => false }
pure def isFundingRefusal(input: RelayInput): bool = match input { | FundingRefused(f) => true | _ => false }
pure def lawAReasonIsShownOnlyForFundingToAHelloThatAsked(r: Relay, input: RelayInput): bool =
  relayWellFormed(r) implies (relayStep(r, input).frames.some(f => hasReason(f)) implies (r.errorReasons and isFundingRefusal(input)))
```
