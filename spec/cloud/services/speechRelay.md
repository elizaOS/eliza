# Speech relay protocol

The wire on the one socket of a minted speech session: develop's wire (plan
decision D41), from `packages/host/src/voice/speech-relay-{wire,session}.ts`
on the pinned branch and `packages/cloud/api/src/speech-relay-coordinator.ts`.
The Android speech bridge is its client.

This library has no state. `relayStep` is the relay's answer to one input: a
device frame, or an edge the session or a provider reports; the shell sends
an answer's frames before it reads the next input. The session machine
(`./speechSession`) holds one `Relay` per socket and owns consent, windows,
budgets and settlement: a frame that breaks a budget reaches the relay as
`ClientViolation`. The device client (`spec/os/voice/cloudSpeech.md`) speaks
the same frames. JSON, bytes, token digests, string lengths, the id pattern
and provider calls stay in the codec (`src/client/relay-frames.ts`).

## Story: Speak the relay protocol on one socket

> As a device connected to a minted speech session, I want one greeting that
> proves the session token, the audio format announced once, each utterance
> prepared once, its flushes and its end acknowledged in order, and every end
> of the socket named, so that I can tell an exhausted account from a bad
> token, an outage or my own mistake.

### The wire is version 1 with 16 kHz mono PCM16 and bounded frames

Control frames are JSON of at most 8192 UTF-8 bytes. The device sends
`{t: "hello", token, errorReasons?: true, extend?: true}` (token 1 to 6144
chars, no other key; develop's `timings` flag is gone), `{t: "prepare" |
"finish" | "cancel", id}`, `{t: "tts", id, text, flush?}` (text 1 to 1024
chars, not blank), `{t: "stop"}`, and binary PCM16 LE chunks (even, 2 to 3200
bytes). The relay sends `{t: "ready", version: 1, sampleRate: 16000,
channels: 1, expiresAt}`, `{t: "stt", event: {type, transcript?}}`
(transcript at most 16384 chars), `{t: "tts_prepared" | "flush_complete" |
"complete", id}`, `{t: "extended", expiresAt}`, `{t: "error", code,
reason?}`, and binary `[1, idLength, id, PCM16]` with PCM even and at most
65536 bytes. An id matches `[A-Za-z0-9_-]{1,64}`. A device frame out of
these bounds is a `ClientViolation`.

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
pure def validHelloToken(chars: CharCount): bool = chars >= 1 and chars <= maxHelloTokenChars
pure def validTtsText(chars: CharCount, blank: bool): bool = chars >= 1 and chars <= maxTtsTextChars and not(blank)
pure def validUtteranceId(chars: int): bool = chars >= 1 and chars <= maxUtteranceIdChars
pure def validDownlinkAudio(idChars: int, pcmBytes: int): bool = validUtteranceId(idChars) and validPcm(pcmBytes, maxDownlinkPcmBytes)
```

### A relay awaits a hello, opens, is live or has ended, and knows the stage of every utterance it has seen

While opening, the session admits the first window and starts the
providers; their edges are held (at most 64) and sent right after `ready`.
Each utterance is open, finishing, cancelled or done, and remembers whether
audio was forwarded since its last acknowledged flush. A live relay counts
its windows; a session names at most 64 utterance ids per window. The codec
maps a checked device frame to its input (the shell compares the token's
digest; an uplink chunk that is not `validPcm` is `ClientViolation`) and
each frame below to its wire form. A well-formed relay holds only `stt`
frames, and turn events only after `connected`, while opening; every step
keeps a relay well formed.

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
  | ClientStop | ClientAudio | ClientViolation
  | HelloTimedOut | Admitted | WindowRenewed | ProviderStt({ kind: SttEventKind, transcriptChars: CharCount })
  | ProviderAudio({ id: str }) | ProviderFlushed({ id: str }) | ProviderCompleted({ id: str })
  | ProviderFailed | FundingRefused({ funding: Shortfall }) | CredentialRefused | SessionOver
type RelayAnswer = { relay: Relay, frames: List[ServerFrame] }
pure val maxPendingFrames = 64
pure val maxUtterancesPerWindow = 64
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
pure def quiet(r: Relay): RelayAnswer = { relay: r, frames: List() }
pure def answer(r: Relay, frame: ServerFrame): RelayAnswer = { relay: r, frames: List(frame) }
pure def isSttFrame(f: ServerFrame): bool = match f { | SttFrame(e) => true | _ => false }
pure def isTurnFrame(f: ServerFrame): bool = match f { | SttFrame(e) => e.kind != SttConnected | _ => false }
pure def relayWellFormed(r: Relay): bool =
  r.utterances.every(u => r.utterances.select(v => v.id == u.id).length() == 1)
  and (r.phase == RelayAwaitingHello implies (not(r.errorReasons) and not(r.extend) and not(r.sttConnected) and r.windows == 0 and r.utterances == List()))
  and (r.phase == RelayOpening implies (r.windows == 0 and r.utterances == List() and r.pending.length() <= maxPendingFrames))
  and r.pending.every(f => isSttFrame(f)) and (r.pending.some(f => isTurnFrame(f)) implies r.sttConnected)
  and (r.phase != RelayOpening implies r.pending == List())
  and (r.phase == RelayLive implies (r.windows >= 1 and r.utterances.length() <= maxUtterancesPerWindow * r.windows))
pure def lawStepKeepsTheRelayWellFormed(r: Relay, input: RelayInput): bool =
  relayWellFormed(relayAtUpgrade) and (relayWellFormed(r) implies relayWellFormed(relayStep(r, input).relay))
```

### Every end of a socket is one error and a close code for its cause, except a stop the device asked for, and only funding carries a reason

A live device's `stop` closes with 1000 and no error. Any other end sends
one `error`, then closes: `unauthorized` (4401) for a wrong token, no hello
within 5 s, or a refused credential; `unavailable` (4402) when funding
refused a window; `closed` (4410) when the session is over (deadline passed
unrenewed, owner revoked it, account deleting); `protocol` (1008) for a
frame that breaks the protocol, a budget or the id cap; `unavailable` (1008)
for a provider or service outage. An ended relay answers nothing. Funding
is never `unauthorized`: its `error` is `unavailable` with the reason
`insufficient_credits` or `allowance_exhausted` only for a hello that sent
`errorReasons`, and no other end carries a reason. Develop sent only
`insufficient_credits`; plan decision D19 adds the daily allowance, and the
device client accepts both.

```quint
pure val normalClose = 1000
pure val violationClose = 1008
pure val unauthorizedClose = 4401
pure val fundingClose = 4402
pure val sessionClosedClose = 4410
type EndCause = CauseUnauthorized | CauseProtocol | CauseOutage | CauseFunding({ funding: Shortfall }) | CauseSessionOver
pure def errorCodeOf(cause: EndCause): RelayErrorCode = match cause {
  | CauseUnauthorized => RelayUnauthorized | CauseProtocol => RelayProtocol | CauseSessionOver => RelayClosed | _ => RelayUnavailable
}
pure def closeCodeOf(cause: EndCause): int = match cause {
  | CauseUnauthorized => unauthorizedClose | CauseFunding(f) => fundingClose | CauseSessionOver => sessionClosedClose | _ => violationClose
}
pure def reasonShown(r: Relay, cause: EndCause): RelayReason = match cause {
  | CauseFunding(f) => if (r.errorReasons) FundingReason({ funding: f.funding }) else NoRelayReason
  | _ => NoRelayReason
}
pure def endWith(r: Relay, cause: EndCause): RelayAnswer =
  { relay: { ...r, phase: RelayEnded, pending: List() }, frames: List(ErrorFrame({ code: errorCodeOf(cause), reason: reasonShown(r, cause) }), CloseFrame({ closeCode: closeCodeOf(cause) })) }
pure def isServerEnding(input: RelayInput): bool = match input { | FundingRefused(f) => true | CredentialRefused => true | SessionOver => true | ProviderFailed => true | _ => false }
pure def serverEnding(r: Relay, input: RelayInput): RelayAnswer = match input {
  | FundingRefused(f) => endWith(r, CauseFunding({ funding: f.funding }))
  | CredentialRefused => endWith(r, CauseUnauthorized)
  | SessionOver => endWith(r, CauseSessionOver)
  | ProviderFailed => endWith(r, CauseOutage)
  | _ => quiet(r)
}
pure def isClientFrame(input: RelayInput): bool = match input {
  | ClientHello(h) => true | ClientPrepare(p) => true | ClientSpeak(p) => true | ClientFinish(p) => true | ClientCancel(p) => true
  | ClientStop => true | ClientAudio => true | ClientViolation => true | _ => false
}
pure def isErrorFrame(f: ServerFrame): bool = match f { | ErrorFrame(e) => true | _ => false }
pure def isCloseFrame(f: ServerFrame): bool = match f { | CloseFrame(c) => true | _ => false }
pure def endsNow(r: Relay, a: RelayAnswer): bool = r.phase != RelayEnded and a.relay.phase == RelayEnded
pure def lawEveryEndIsOneErrorThenItsCloseOrAStop(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  val stopped = a.frames == List(CloseFrame({ closeCode: normalClose }))
  relayWellFormed(r) implies (
    (a.frames.some(f => isCloseFrame(f)) iff endsNow(r, a))
    and (stopped implies (input == ClientStop and r.phase == RelayLive))
    and (endsNow(r, a) implies (stopped or (a.frames.length() == 2 and isErrorFrame(a.frames.nthOr(0, ReadyFrame))
      and isCloseFrame(a.frames.nthOr(1, ReadyFrame)) and a.frames.nthOr(1, ReadyFrame) != CloseFrame({ closeCode: normalClose })))))
}
pure def hasReason(f: ServerFrame): bool = match f { | ErrorFrame(e) => e.reason != NoRelayReason | _ => false }
pure def isFundingRefusal(input: RelayInput): bool = match input { | FundingRefused(f) => true | _ => false }
pure def lawAReasonIsShownOnlyForFundingToAHelloThatAsked(r: Relay, input: RelayInput): bool =
  relayWellFormed(r) implies (relayStep(r, input).frames.some(f => hasReason(f)) implies (r.errorReasons and isFundingRefusal(input)))
pure def lawRefusedFundingClosesAsFundingNeverUnauthorized(r: Relay, funding: Shortfall): bool = {
  val a = relayStep(r, FundingRefused({ funding: funding }))
  r.phase != RelayEnded implies (a.frames == List(
    ErrorFrame({ code: RelayUnavailable, reason: if (r.errorReasons) FundingReason({ funding: funding }) else NoRelayReason }),
    CloseFrame({ closeCode: fundingClose })))
}
pure val idValues = Set("u1", "u2")
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
  ClientFinish({ id: "u1" }), ClientFinish({ id: "u2" }), ClientCancel({ id: "u1" }), ClientCancel({ id: "u4" }), ClientStop, ClientAudio, ClientViolation,
  HelloTimedOut, Admitted, WindowRenewed, ProviderStt({ kind: SttConnected, transcriptChars: 0 }), ProviderStt({ kind: EndOfTurn, transcriptChars: 12 }),
  ProviderStt({ kind: TranscriptUpdate, transcriptChars: 20000 }), ProviderAudio({ id: "u1" }), ProviderAudio({ id: "u2" }), ProviderFlushed({ id: "u1" }),
  ProviderFlushed({ id: "u2" }), ProviderCompleted({ id: "u1" }), ProviderCompleted({ id: "u2" }),
  ProviderFailed, FundingRefused({ funding: AllowanceShort }), FundingRefused({ funding: CreditsShort }), CredentialRefused, SessionOver)
```

### Only a hello carrying the session token opens the relay, and ready, then the held edges, is sent once the first window is admitted

The first frame must be a hello whose token matches the session's digest;
its `errorReasons` and `extend` flags hold for the socket. Binary audio
first is `unavailable`; anything else first is `unauthorized`. The session
then admits the first window and starts the providers, and only then is
`ready` sent, once, followed by the edges held while opening (so an early
`connected` follows `ready` at once). As in develop, a device frame sent
while the relay is opening is refused as `unavailable`.

```quint
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
  | HelloTimedOut => endWith(r, CauseUnauthorized)
  | _ => if (isServerEnding(input)) serverEnding(r, input) else if (isClientFrame(input)) endWith(r, CauseUnauthorized) else quiet(r)
}
pure def whileOpening(r: Relay, input: RelayInput): RelayAnswer = match input {
  | Admitted => { relay: { ...r, phase: RelayLive, windows: 1, pending: List() }, frames: List(ReadyFrame).concat(r.pending) }
  | ProviderStt(e) => onStt(r, e.kind, e.transcriptChars)
  | _ => if (isServerEnding(input)) serverEnding(r, input) else if (isClientFrame(input)) endWith(r, CauseOutage) else quiet(r)
}
pure def isTokenHello(input: RelayInput): bool = match input { | ClientHello(h) => h.tokenMatches | _ => false }
pure def lawOnlyTheSessionTokenOpensTheRelay(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  (r.phase == RelayAwaitingHello and a.relay.phase != RelayEnded and a.relay.phase != RelayAwaitingHello) implies (isTokenHello(input) and a.relay.phase == RelayOpening and a.frames == List())
}
pure def lawReadyThenHeldEdgesOnlyWhenTheOpeningIsAdmitted(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  relayWellFormed(r) implies (
    (a.frames.includes(ReadyFrame) iff (r.phase == RelayOpening and input == Admitted))
    and ((r.phase == RelayOpening and input == Admitted) implies a.frames == List(ReadyFrame).concat(r.pending))
    and (r.phase != RelayLive implies a.frames.every(f => f == ReadyFrame or isErrorFrame(f) or isCloseFrame(f) or (input == Admitted and r.pending.includes(f)))))
}
```

### While live, frames follow the life of each utterance

`prepare`, or the first `tts` of an id, opens the utterance and is answered
with one `tts_prepared`; a new id beyond 64 per window breaks the protocol.
A `tts` for an open utterance adds text (its `flush` goes to the provider).
`finish` moves an open utterance to finishing. `cancel` cancels any id, and
nothing more is sent for it. A frame for a cancelled id, and `finish` for a
done one, is ignored (a cancel or the provider's end may overtake queued
phrases); `prepare` or `tts` for a finishing or done id, and `finish` twice
or for an unseen id, break the protocol. Provider audio is forwarded for an open or
finishing utterance; a flush is acknowledged only when audio was forwarded
since the last acknowledgement; the provider's completion of an open or
finishing utterance is answered with `complete` and ends it. As in develop,
completion may come before `finish`; the session then marks that TTS
settlement uncertain. A renewed window is announced only to a hello with
`extend`.

```quint
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
pure def lawUtteranceFramesFollowItsStage(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  relayWellFormed(r) implies (
    (a.frames.includes(PreparedFrame({ id: id })) implies (not(seen(r, id)) and stageIs(a.relay, id, UtteranceOpen)))
    and (a.frames.includes(FlushedFrame({ id: id })) implies (heardOf(r, id) and not(heardOf(a.relay, id))))
    and (a.frames.includes(CompleteFrame({ id: id })) implies (speaking(r, id) and stageIs(a.relay, id, UtteranceDone))))
}
pure def lawNothingIsSentForACancelledUtterance(r: Relay, input: RelayInput, id: str): bool = {
  val a = relayStep(r, input)
  (relayWellFormed(r) and stageIs(r, id, UtteranceCancelled)) implies (stageIs(a.relay, id, UtteranceCancelled)
    and not(a.frames.includes(PreparedFrame({ id: id })) or a.frames.includes(AudioFrame({ id: id }))
      or a.frames.includes(FlushedFrame({ id: id })) or a.frames.includes(CompleteFrame({ id: id }))))
}
```

### Turn events and accepted uplink audio follow connected, and extended goes only to a hello that asked

`connected` is sent once, and a turn event before it is never sent. A
transcript over 16384 chars is a provider failure and is never sent. The
shell forwards uplink audio to the provider only while `acceptsAudio` holds,
and drops it otherwise (the device starts capture on `connected`).

```quint
pure def acceptsAudio(r: Relay): bool = r.phase == RelayLive and r.sttConnected
pure def lawConnectedPrecedesTurnsAndAcceptedAudio(r: Relay, input: RelayInput): bool = {
  val a = relayStep(r, input)
  val sent = a.frames.concat(a.relay.pending)
  relayWellFormed(r) implies (
    (sent.some(f => isTurnFrame(f)) implies (a.relay.sttConnected or a.relay.phase == RelayEnded))
    and (a.frames.includes(SttFrame({ kind: SttConnected })) implies (not(r.sttConnected) or r.pending.includes(SttFrame({ kind: SttConnected }))))
    and ((a.relay.sttConnected and not(r.sttConnected) and a.relay.phase != RelayEnded) implies sent.includes(SttFrame({ kind: SttConnected }))))
}
pure def lawNoTranscriptOverTheLimitIsSent(r: Relay, kind: SttEventKind, transcriptChars: CharCount): bool = {
  val a = relayStep(r, ProviderStt({ kind: kind, transcriptChars: transcriptChars }))
  (kind != SttConnected and transcriptChars > maxTranscriptChars) implies (not(a.frames.some(f => isSttFrame(f))) and a.relay.pending.length() <= r.pending.length())
}
pure def lawExtendedOnlyForAHelloThatAsked(r: Relay, input: RelayInput): bool =
  relayWellFormed(r) implies (relayStep(r, input).frames.includes(ExtendedFrame) implies r.extend)
```
