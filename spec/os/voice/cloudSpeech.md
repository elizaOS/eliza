# Cloud speech

The device client of cloud speech: one streaming relay session for live
talk, and single batch requests that transcribe or synthesize. Consent
nonces, minting, windows, budgets, settlement and the wire belong to the
cloud (`spec/cloud/services/speechRelay.md`, whose server frames this
machine reads). HTTP, the socket, JSON, PCM, tokens and clocks stay in the
Java shell (`voice-io`), which reports what it observed and acts on the
notices. Source: develop's `SpeechStreamBridgePlugin.java`.

## Story: Talk to the agent through the cloud speech relay

> As a person talking to my agent, I want my phone to stream my voice to
> the cloud only after I agreed, only under my own signed-in key, and to
> stop cleanly, so that I never pay for speech I did not ask for, never
> hear a stale reply, and always learn why talking stopped.

### Consent is asked at most twice and lapses 30 seconds after the first ask

One dismissal asks again; a second, or no answer 30 s after the first
ask, ends the session unconsented. Only consent leads to minting.

```quint
import types.* from "../../cloud/shared/types"
import speechRelay as Rl from "../../cloud/services/speechRelay"
import credential as C from "../signIn/credential"
import microphone as M from "./microphone"
import speechOutput as O from "./speechOutput"
import capabilityRouting as Cr from "../../core/capabilityRouting"
type Ending = Stopped | NotConsented | FailedBeforeAudio({ failure: Cr::Failure }) | FailedAfterAudio({ failure: Cr::Failure })
type Phase = Idle | AwaitingConsent({ asks: int, waitedMs: Millis }) | Minting | Connecting | Ready | Live | Closed({ ending: Ending })
type Capture = Muted | Reserving | Listening
type Turn = NoTurn | TurnOf({ capture: int })
type Reply = NoReply | Playing({ utteranceId: str, pace: int, receivedMs: Millis, playedMs: Millis, completed: bool })
type BatchVerdict = BatchPending | BatchDone | BatchCancelled | BatchFailed({ failure: Cr::Failure, wait: WaitTime })
type BatchRequest = { requestId: int, direction: SpeechDirection, version: int, verdict: BatchVerdict }
type CloudSpeech = { credential: int, bound: int, phase: Phase, extendOffered: bool, audioStarted: bool, capture: Capture, generation: int, turn: Turn, reply: Reply, batches: List[BatchRequest] }
type SpeechNotice = AskConsent | ReserveLiveCapture | ReleaseLiveCapture | RevokeSession | CancelUtterance({ utteranceId: str })
  | ReportRefusedKey({ version: int, reason: RefusalReason, on: C::RejectedOn }) | SessionFailed({ failure: Cr::Failure, beforeAudio: bool, wait: WaitTime })
  | Heard({ final: bool, capture: int }) | ReplySettled({ utteranceId: str, completed: bool }) | BatchSettled({ requestId: int, verdict: BatchVerdict })
type SpeechStep = { state: CloudSpeech, out: List[SpeechNotice] }
pure val initial: CloudSpeech = { credential: 0, bound: 0, phase: Idle, extendOffered: false, audioStarted: false, capture: Muted, generation: 0, turn: NoTurn, reply: NoReply, batches: List() }
pure val consentDeadline: Millis = 30 * millisPerSecond
pure def quietStep(s: CloudSpeech): SpeechStep = { state: s, out: List() }
pure def isOpen(p: Phase): bool = match p { | Idle => false | Closed(c) => false | _ => true }
pure def asksOf(p: Phase): int = match p { | AwaitingConsent(a) => a.asks | _ => 0 }
pure def waitedOf(p: Phase): Millis = match p { | AwaitingConsent(a) => a.waitedMs | _ => 0 }
pure def canBegin(s: CloudSpeech): bool = s.credential >= 1 and not(isOpen(s.phase))
pure def begin(s: CloudSpeech): SpeechStep =
  { state: { ...initial, credential: s.credential, bound: s.credential, batches: s.batches, phase: AwaitingConsent({ asks: 1, waitedMs: 0 }) }, out: List(AskConsent) }
pure def canConsentDismissed(s: CloudSpeech): bool = asksOf(s.phase) >= 1
pure def consentDismissed(s: CloudSpeech): SpeechStep =
  if (asksOf(s.phase) == 1) { state: { ...s, phase: AwaitingConsent({ asks: 2, waitedMs: waitedOf(s.phase) }) }, out: List(AskConsent) }
  else quietStep({ ...s, phase: Closed({ ending: NotConsented }) })
pure def canConsentClock(s: CloudSpeech, waitMs: Millis): bool = asksOf(s.phase) >= 1 and waitMs > 0
pure def consentClock(s: CloudSpeech, waitMs: Millis): CloudSpeech =
  if (waitedOf(s.phase) + waitMs >= consentDeadline) { ...s, phase: Closed({ ending: NotConsented }) }
  else { ...s, phase: AwaitingConsent({ asks: asksOf(s.phase), waitedMs: waitedOf(s.phase) + waitMs }) }
pure val waitMsValues = Set(10000, 30000)
pure def canConsentGiven(s: CloudSpeech): bool = asksOf(s.phase) >= 1
pure def consentGiven(s: CloudSpeech): CloudSpeech = { ...s, phase: Minting }
pure def alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(s: CloudSpeech): bool =
  asksOf(s.phase) >= 1 implies (asksOf(s.phase) <= 2 and waitedOf(s.phase) >= 0 and waitedOf(s.phase) < consentDeadline)
pure def sometimesAskedAgain(s: CloudSpeech): bool = asksOf(s.phase) == 2
pure def sometimesNotConsented(s: CloudSpeech): bool = s.phase == Closed({ ending: NotConsented })
pure val weight_begin = 3
pure val weight_consentGiven = 3
```

### An open session and every waiting batch request run under the current key, and a key change ends them

The shell reports `C::activeVersion` (0 when signed out or expired)
whenever it changes; a session binds the version it started with. A new
version, sign-out or expiry ends the open session as `AccountIneligible`
and fails each batch request still waiting.

```quint
pure def keyGone(b: BatchRequest): BatchRequest = if (b.verdict == BatchPending) { ...b, verdict: BatchFailed({ failure: Cr::AccountIneligible, wait: NoWait }) } else b
pure def canCredentialChanged(s: CloudSpeech, version: int): bool = version >= 0 and version != s.credential
pure def credentialChanged(s: CloudSpeech, version: int): SpeechStep = {
  val rebound = { ...s, credential: version, batches: s.batches.listMap(b => keyGone(b)) }
  val notices = s.batches.select(b => b.verdict == BatchPending).listMap(b => BatchSettled({ requestId: b.requestId, verdict: keyGone(b).verdict }))
  if (isOpen(s.phase)) failWith(Cr::AccountIneligible, rebound, notices, NoWait) else { state: rebound, out: notices }
}
pure val versionValues = Set(0, 1, 2)
pure val weight_credentialChanged = 2
pure def alwaysOpenWorkUsesTheCurrentKey(s: CloudSpeech): bool =
  (isOpen(s.phase) implies (s.bound == s.credential and s.bound >= 1))
  and s.batches.every(b => b.verdict == BatchPending implies (b.version == s.credential and b.version >= 1))
pure def sometimesKeyChangeEndedSession(s: CloudSpeech): bool = s.bound >= 1 and s.credential != s.bound and hasEnded(s.phase)
```

### Only a mint answer naming the deployment's own relay opens the socket, and a refused key is reported once and never retried

The consent and mint calls answer here as one. An answer whose shape is
wrong (version 1, expiry within one window) or whose `wsUrl` is not the
deployment origin's relay is `Misdirected`. A `401` with a credential
reason goes to the credential (`C::rejected`, `OtherRequest`); every
refusal ends its request, and its retry or reset time reaches the caller.

```quint
type CloudAnswer = Answered | Misdirected | Unreachable | Refused({ refusal: Refusal })
pure def refusalFailure(code: RefusalCode): Cr::Failure = { val status = statusOf(code)
  if (status == 401 or status == 402 or status == 403) Cr::AccountIneligible else if (status == 404) Cr::CapabilityUnavailable else if (status == 503) Cr::RemoteUnreachable else Cr::RequestFailed }
pure def failureOf(a: CloudAnswer): Cr::Failure = match a { | Answered => Cr::NoFailure | Misdirected => Cr::RequestFailed | Unreachable => Cr::RemoteUnreachable | Refused(r) => refusalFailure(r.refusal.code) }
pure def waitOf(a: CloudAnswer): WaitTime = match a { | Refused(r) => r.refusal.wait | _ => NoWait }
pure def keyReport(a: CloudAnswer, version: int): List[SpeechNotice] = match a {
  | Refused(r) => if (r.refusal.code == AuthenticationRequired and isCredentialReason(r.refusal.reason)) List(ReportRefusedKey({ version: version, reason: r.refusal.reason, on: C::OtherRequest })) else List()
  | _ => List() }
pure def canMinted(s: CloudSpeech): bool = s.phase == Minting
pure def minted(s: CloudSpeech, answer: CloudAnswer, extendOffered: bool): SpeechStep =
  if (answer == Answered) quietStep({ ...s, phase: Connecting, extendOffered: extendOffered })
  else failWith(failureOf(answer), s, keyReport(answer, s.credential), waitOf(answer))
pure val answerValues = Set(Answered, Misdirected, Unreachable, Refused({ refusal: { code: AuthenticationRequired, reason: CredentialExpired, wait: NoWait } }),
  Refused({ refusal: { code: RateLimited, reason: NoReason, wait: RetryAt({ retryAtMs: 5000 }) } }), Refused({ refusal: { code: AllowanceExhausted, reason: NoReason, wait: ResetsAt({ resetsAtMs: 9000 }) } }))
pure val weight_minted = 4
pure def keyReportVersion(n: SpeechNotice): int = match n { | ReportRefusedKey(k) => k.version | _ => -1 }
pure def closing(before: CloudSpeech, after: CloudSpeech): bool = isOpen(before.phase) and not(isOpen(after.phase))
pure def stepARefusedKeyIsReportedOnceAndEndsItsRequest(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool =
  out.select(n => keyReportVersion(n) != -1).length() <= 1
  and out.every(n => keyReportVersion(n) == -1 or (keyReportVersion(n) == before.credential and (closing(before, after) or via == "batchAnswered")))
```

### The device accepts relay frames only in protocol order, and any other frame ends the session

`ready` comes once, before anything but an `error`; `connected` makes the
session live, and turns and `complete` follow it. `extended` is accepted
after `ready` only when the mint offered renewal. An `error`, a closed
socket, a passed deadline or a stalled startup (`relayLost`) ends it.

```quint
pure def mintedPhase(p: Phase): bool = p == Connecting or p == Ready or p == Live
pure def relayFailure(code: Rl::RelayErrorCode, reason: Rl::RelayReason): Cr::Failure =
  if (code == Rl::RelayUnauthorized or reason != Rl::NoRelayReason) Cr::AccountIneligible else if (code == Rl::RelayUnavailable) Cr::RemoteUnreachable else Cr::RequestFailed
pure def protocolEnd(s: CloudSpeech): SpeechStep = failWith(Cr::RequestFailed, s, List(), NoWait)
pure def canFrameArrived(s: CloudSpeech): bool = mintedPhase(s.phase)
pure def frameArrived(s: CloudSpeech, frame: Rl::ServerFrame): SpeechStep = match frame {
  | ReadyFrame => if (s.phase == Connecting) quietStep({ ...s, phase: Ready }) else protocolEnd(s)
  | SttFrame(e) => if (e.kind == Rl::SttConnected) (if (s.phase == Ready) quietStep({ ...s, phase: Live }) else if (s.phase == Live) quietStep(s) else protocolEnd(s))
      else if (s.phase == Live) onTurn(e.kind, s) else protocolEnd(s)
  | ExtendedFrame => if (s.phase != Connecting and s.extendOffered) quietStep(s) else protocolEnd(s)
  | CompleteFrame(f) => if (s.phase == Live) onComplete(f.id, s) else protocolEnd(s)
  | ErrorFrame(e) => failWith(relayFailure(e.code, e.reason), s, List(), NoWait)
  | CloseFrame(c) => failWith(Cr::RemoteUnreachable, s, List(), NoWait)
  | _ => if (s.phase == Live) quietStep(s) else protocolEnd(s)
}
pure val frameValues = Set(Rl::ReadyFrame, Rl::SttFrame({ kind: Rl::SttConnected }), Rl::SttFrame({ kind: Rl::StartOfTurn }), Rl::SttFrame({ kind: Rl::TranscriptUpdate }),
  Rl::SttFrame({ kind: Rl::EndOfTurn }), Rl::ExtendedFrame, Rl::CompleteFrame({ id: "u1" }), Rl::ErrorFrame({ code: Rl::RelayUnavailable, reason: Rl::FundingReason({ funding: Rl::CreditsShort }) }))
pure val weight_frameArrived = 10
pure def canRelayLost(s: CloudSpeech): bool = mintedPhase(s.phase)
pure def relayLost(s: CloudSpeech): SpeechStep = failWith(Cr::RemoteUnreachable, s, List(), NoWait)
pure def stepTheSessionOpensInOrder(before: CloudSpeech, after: CloudSpeech): bool =
  (after.phase == Minting implies (before.phase == Minting or asksOf(before.phase) >= 1))
  and (after.phase == Connecting implies (before.phase == Connecting or before.phase == Minting))
  and (after.phase == Ready implies (before.phase == Ready or before.phase == Connecting))
  and (after.phase == Live implies (before.phase == Live or before.phase == Ready))
```

### Capture starts muted, and listens only once the microphone slot is granted with RECORD_AUDIO

Unmuting reserves the slot as a live capture (`M::reserve`) and the shell
reports the slot's answer; a refused slot ends the session, as in develop.
Each granted capture gets the next number. Muting releases the slot and
keeps the number, so a turn the capture began may still finish.

```quint
pure def canUnmute(s: CloudSpeech, recordAudio: bool): bool = s.phase == Live and s.capture == Muted and recordAudio
pure def unmute(s: CloudSpeech, recordAudio: bool): SpeechStep = { state: { ...s, capture: Reserving }, out: List(ReserveLiveCapture) }
pure def canCaptureAnswered(s: CloudSpeech): bool = s.capture == Reserving
pure def captureAnswered(s: CloudSpeech, slot: M::Refusal): SpeechStep =
  if (slot == M::NoRefusal) quietStep({ ...s, capture: Listening, generation: s.generation + 1, audioStarted: true })
  else failWith(Cr::CapabilityUnavailable, { ...s, capture: Muted }, List(), NoWait)
pure val slotValues = Set(M::NoRefusal, M::SlotBusy)
pure def canMute(s: CloudSpeech): bool = s.capture != Muted
pure def mute(s: CloudSpeech): SpeechStep = { state: { ...s, capture: Muted }, out: List(ReleaseLiveCapture) }
pure val weight_unmute = 3
pure val weight_captureAnswered = 3
pure def sometimesListening(s: CloudSpeech): bool = s.phase == Live and s.capture == Listening
```

### A provider speech edge belongs to the capture live when it began, and a retired capture owns none

A turn that starts while muted belongs to no capture. A turn's text is
published only for the capture it began in, and only while that capture is
the newest, so speech heard while the agent talked never becomes the next
turn. Outside a live session nothing captures, hears or plays.

```quint
pure def turnOwner(t: Turn): int = match t { | TurnOf(x) => x.capture | NoTurn => -1 }
pure def ownedTurn(s: CloudSpeech): bool = turnOwner(s.turn) >= 1 and turnOwner(s.turn) == s.generation
pure def onTurn(kind: Rl::SttEventKind, s: CloudSpeech): SpeechStep =
  if (kind == Rl::StartOfTurn or kind == Rl::TurnResumed) quietStep(if (s.turn == NoTurn) { ...s, turn: TurnOf({ capture: if (s.capture == Listening) s.generation else 0 }) } else s)
  else if (kind == Rl::EndOfTurn) { state: { ...s, turn: NoTurn }, out: if (ownedTurn(s)) List(Heard({ final: true, capture: s.generation })) else List() }
  else { state: s, out: if (ownedTurn(s)) List(Heard({ final: false, capture: s.generation })) else List() }
pure def heardCapture(n: SpeechNotice): int = match n { | Heard(h) => h.capture | _ => -1 }
pure def stepOnlyTheCaptureATurnBeganInPublishesIt(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool =
  out.every(n => heardCapture(n) == -1 or (heardCapture(n) >= 1 and heardCapture(n) == before.generation and turnOwner(before.turn) == heardCapture(n)))
pure def alwaysOnlyALiveSessionCaptures(s: CloudSpeech): bool =
  s.generation >= 0 and turnOwner(s.turn) <= s.generation
  and (s.phase != Live implies (s.capture == Muted and s.turn == NoTurn and s.reply == NoReply))
  and (s.capture == Listening implies (s.generation >= 1 and s.audioStarted))
pure def sometimesTurnWithoutCapture(s: CloudSpeech): bool = s.phase == Live and s.turn == TurnOf({ capture: 0 })
pure def sometimesMutedCaptureFinishesItsTurn(s: CloudSpeech): bool = s.capture == Muted and ownedTurn(s)
```

### A reply plays at a pace from 50 to 200 percent, one at a time, and never ahead of the audio received

`speak` sends the reply's text (the shell splits it into phrases) and its
audio plays through `O`. Audio for another or a cancelled id is ignored;
audio after the relay's `complete` breaks the protocol.

```quint
pure val minPace = 50
pure val maxPace = 200
pure def replyId(r: Reply): str = match r { | Playing(x) => x.utteranceId | NoReply => "" }
pure def canSpeak(s: CloudSpeech, utteranceId: str, pace: int): bool =
  s.phase == Live and s.reply == NoReply and utteranceId != "" and pace >= minPace and pace <= maxPace
pure def speak(s: CloudSpeech, utteranceId: str, pace: int): CloudSpeech =
  { ...s, reply: Playing({ utteranceId: utteranceId, pace: pace, receivedMs: 0, playedMs: 0, completed: false }) }
pure val utteranceIdValues = Set("u1", "u2")
pure val paceValues = Set(50, 200, 250)
pure def canAudioArrived(s: CloudSpeech, utteranceId: str, audioMs: Millis): bool = s.phase == Live and audioMs > 0
pure def audioArrived(s: CloudSpeech, utteranceId: str, audioMs: Millis): SpeechStep = { val r = s.reply  match r {
  | Playing(x) => if (x.utteranceId != utteranceId) quietStep(s) else if (x.completed) protocolEnd(s)
      else quietStep({ ...s, audioStarted: true, reply: Playing({ ...x, receivedMs: x.receivedMs + audioMs }) })
  | NoReply => quietStep(s) } }
pure val audioMsValues = Set(40, 100)
pure def wellFormedReply(r: Reply): bool = match r {
  | Playing(x) => x.utteranceId != "" and x.pace >= minPace and x.pace <= maxPace and x.playedMs >= 0 and x.playedMs <= x.receivedMs
      and (x.completed implies x.playedMs < x.receivedMs)
  | NoReply => true }
pure def alwaysAReplyNeverPlaysAheadOfItsAudio(s: CloudSpeech): bool = wellFormedReply(s.reply)
pure val weight_speak = 3
pure val weight_audioArrived = 3
```

### A reply settles once: completed when all its audio has played, or cancelled

The relay's `complete` marks the reply complete (without any audio it
breaks the protocol); it settles when the played audio reaches what
arrived. Cancelling, or a focus refusal from `O`, settles it uncompleted
and tells the relay; a call starting (`O::StopCapture`) ends the session.

```quint
pure def settleReply(id: str, completed: bool, s: CloudSpeech): SpeechStep = { state: { ...s, reply: NoReply }, out: List(ReplySettled({ utteranceId: id, completed: completed })) }
pure def onComplete(id: str, s: CloudSpeech): SpeechStep = { val r = s.reply  match r {
  | Playing(x) => if (x.utteranceId != id) quietStep(s) else if (x.receivedMs == 0) protocolEnd(s)
      else if (x.playedMs == x.receivedMs) settleReply(id, true, s) else quietStep({ ...s, reply: Playing({ ...x, completed: true }) })
  | NoReply => quietStep(s) } }
pure def canPlayed(s: CloudSpeech, playedMs: Millis): bool = { val r = s.reply  match r { | Playing(x) => playedMs > 0 and x.playedMs + playedMs <= x.receivedMs | NoReply => false } }
pure def played(s: CloudSpeech, playedMs: Millis): SpeechStep = { val r = s.reply  match r {
  | Playing(x) => if (x.completed and x.playedMs + playedMs == x.receivedMs) settleReply(x.utteranceId, true, s)
      else quietStep({ ...s, reply: Playing({ ...x, playedMs: x.playedMs + playedMs }) })
  | NoReply => quietStep(s) } }
pure val playedMsValues = Set(40, 60)
pure val weight_played = 3
pure def canCancelReply(s: CloudSpeech): bool = s.reply != NoReply
pure def cancelReply(s: CloudSpeech): SpeechStep = { val after = settleReply(replyId(s.reply), false, s)
  { state: after.state, out: List(CancelUtterance({ utteranceId: replyId(s.reply) })).concat(after.out) } }
pure def canOutputNotice(s: CloudSpeech, notice: O::OutputNotice): bool = s.phase == Live
pure def outputNotice(s: CloudSpeech, notice: O::OutputNotice): SpeechStep =
  if (notice == O::StopCapture) failWith(Cr::CapabilityUnavailable, s, List(), NoWait)
  else if ((notice == O::RefusedFocusDenied or notice == O::RefusedCallActive) and s.reply != NoReply) cancelReply(s)
  else quietStep(s)
pure val noticeValues = Set(O::StopCapture, O::RefusedFocusDenied)
pure def isReplySettled(n: SpeechNotice): bool = match n { | ReplySettled(x) => true | _ => false }
pure def stepAReplySettlesOnce(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool =
  out.select(n => isReplySettled(n)).length() == (if (replyId(before.reply) != "" and replyId(after.reply) != replyId(before.reply)) 1 else 0)
pure def sometimesCompletedReplyStillPlaying(s: CloudSpeech): bool = { val r = s.reply  match r { | Playing(x) => x.completed and x.playedMs > 0 | NoReply => false } }
```

### Every end of a session releases the microphone, settles the reply, revokes the session and reports a failure once

Only the person's stop and declined consent end without a failure. A
failure says whether audio had started (capture granted or reply audio
received): before audio core routing may re-route; after it the device
never falls back on its own. The shell revokes after releasing microphone
and speaker; an end while minting revokes what the mint may still return.

```quint
pure def revokeOwed(p: Phase): bool = p == Minting or mintedPhase(p)
pure def failureOfEnding(e: Ending): Cr::Failure = match e { | FailedBeforeAudio(f) => f.failure | FailedAfterAudio(f) => f.failure | _ => Cr::NoFailure }
pure def endingOf(p: Phase): Ending = match p { | Closed(c) => c.ending | _ => Stopped }
pure def closeWith(ending: Ending, s: CloudSpeech, first: List[SpeechNotice], wait: WaitTime): SpeechStep = {
  val id = replyId(s.reply)
  val failure = failureOfEnding(ending)
  { state: { ...s, phase: Closed({ ending: ending }), capture: Muted, turn: NoTurn, reply: NoReply, extendOffered: false },
    out: first.concat(if (s.capture != Muted) List(ReleaseLiveCapture) else List())
      .concat(if (id != "") List(ReplySettled({ utteranceId: id, completed: false })) else List())
      .concat(if (revokeOwed(s.phase)) List(RevokeSession) else List())
      .concat(if (failure != Cr::NoFailure) List(SessionFailed({ failure: failure, beforeAudio: not(s.audioStarted), wait: wait })) else List()) }
}
pure def failWith(failure: Cr::Failure, s: CloudSpeech, first: List[SpeechNotice], wait: WaitTime): SpeechStep =
  closeWith(if (s.audioStarted) FailedAfterAudio({ failure: failure }) else FailedBeforeAudio({ failure: failure }), s, first, wait)
pure def canStop(s: CloudSpeech): bool = isOpen(s.phase)
pure def stop(s: CloudSpeech): SpeechStep = closeWith(Stopped, s, List(), NoWait)
pure def failedBefore(n: SpeechNotice): int = match n { | SessionFailed(f) => if (f.beforeAudio) 1 else 0 | _ => -1 }
pure def stepAnEndReleasesRevokesAndReportsOnce(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool = {
  val failedNow = closing(before, after) and failureOfEnding(endingOf(after.phase)) != Cr::NoFailure
  out.select(n => failedBefore(n) != -1).length() == (if (failedNow) 1 else 0)
  and out.every(n => failedBefore(n) == -1 or (failedBefore(n) == 1) == not(before.audioStarted))
  and (closing(before, after) implies ((before.capture == Listening implies out.includes(ReleaseLiveCapture)) and (revokeOwed(before.phase) implies out.includes(RevokeSession))))
}
pure def failedAfterAudio(e: Ending): bool = match e { | FailedAfterAudio(f) => true | _ => false }
pure def failedBeforeAudio(e: Ending): bool = match e { | FailedBeforeAudio(f) => true | _ => false }
pure def hasEnded(p: Phase): bool = p != Idle and not(isOpen(p))
pure def alwaysAnEndingSaysWhetherAudioStarted(s: CloudSpeech): bool =
  (s.audioStarted implies (s.phase == Live or (hasEnded(s.phase) and (endingOf(s.phase) == Stopped or failedAfterAudio(endingOf(s.phase))))))
  and ((hasEnded(s.phase) and failedAfterAudio(endingOf(s.phase))) implies s.audioStarted)
  and ((failedBeforeAudio(endingOf(s.phase)) or failedAfterAudio(endingOf(s.phase))) implies failureOfEnding(endingOf(s.phase)) != Cr::NoFailure)
pure def sometimesFailedBeforeAudio(s: CloudSpeech): bool = failedBeforeAudio(endingOf(s.phase)) and hasEnded(s.phase)
pure def sometimesFailedAfterAudio(s: CloudSpeech): bool = failedAfterAudio(endingOf(s.phase)) and hasEnded(s.phase)
pure def sometimesStoppedAfterTalking(s: CloudSpeech): bool = s.audioStarted and s.phase == Closed({ ending: Stopped })
```

## Story: Transcribe a recording or hear a reply with one cloud request

> As a person dictating a note or listening to a reply without a live
> session, I want each cloud request to give one answer or one reason it
> failed, so that nothing is transcribed or spoken twice.

### Each batch transcription or synthesis settles once, and a refusal keeps its retry time

A request is sent under the active key; its answer, its cancellation or a
key change settles it, and a settled request never changes. The shell
replays a cache-warming `503` itself before it reports an answer.

```quint
pure def pending(s: CloudSpeech, requestId: int): bool = s.batches.some(b => b.requestId == requestId and b.verdict == BatchPending)
pure def canBatchRequested(s: CloudSpeech, requestId: int, direction: SpeechDirection): bool =
  s.credential >= 1 and requestId >= 1 and not(s.batches.some(b => b.requestId == requestId))
pure def batchRequested(s: CloudSpeech, requestId: int, direction: SpeechDirection): CloudSpeech =
  { ...s, batches: s.batches.append({ requestId: requestId, direction: direction, version: s.credential, verdict: BatchPending }) }
pure def settleBatch(requestId: int, verdict: BatchVerdict, s: CloudSpeech): SpeechStep =
  { state: { ...s, batches: s.batches.listMap(b => if (b.requestId == requestId) { ...b, verdict: verdict } else b) }, out: List(BatchSettled({ requestId: requestId, verdict: verdict })) }
pure def verdictOf(a: CloudAnswer): BatchVerdict = if (a == Answered) BatchDone else BatchFailed({ failure: failureOf(a), wait: waitOf(a) })
pure def canBatchAnswered(s: CloudSpeech, requestId: int): bool = pending(s, requestId)
pure def batchAnswered(s: CloudSpeech, requestId: int, answer: CloudAnswer): SpeechStep = { val after = settleBatch(requestId, verdictOf(answer), s)
  { state: after.state, out: keyReport(answer, s.credential).concat(after.out) } }
pure def canBatchCancelled(s: CloudSpeech, requestId: int): bool = pending(s, requestId)
pure def batchCancelled(s: CloudSpeech, requestId: int): SpeechStep = settleBatch(requestId, BatchCancelled, s)
pure val requestIdValues = Set(1, 2)
pure def settledId(n: SpeechNotice): int = match n { | BatchSettled(b) => b.requestId | _ => 0 }
pure def stepABatchRequestSettlesOnce(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool =
  before.batches.every(b => after.batches.some(a => a.requestId == b.requestId and (b.verdict != BatchPending implies a.verdict == b.verdict))
    and out.select(n => settledId(n) == b.requestId).length() == (if (b.verdict == BatchPending and not(pending(after, b.requestId))) 1 else 0))
pure def alwaysBatchRequestsAreDistinct(s: CloudSpeech): bool = s.batches.every(b => b.requestId >= 1 and s.batches.select(x => x.requestId == b.requestId).length() == 1)
pure def sometimesBatchRateLimited(s: CloudSpeech): bool = s.batches.some(b => b.verdict == BatchFailed({ failure: Cr::RequestFailed, wait: RetryAt({ retryAtMs: 5000 }) }))
pure def sometimesBatchDoneAndCancelled(s: CloudSpeech): bool = s.batches.some(b => b.verdict == BatchDone) and s.batches.some(b => b.verdict == BatchCancelled)
```
