# Cloud speech

The device client of cloud speech: one relay session for live talk, and
batch requests that transcribe or synthesize. Consent nonces, minting,
windows, budgets and the wire are the cloud's
(`spec/cloud/services/speechRelay.md`). HTTP, the socket, PCM, tokens and
clocks stay in the Java shell (`voice-io`), which reports what it observed.

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
type DeviceCause = NoDeviceCause | DevicePaused | PlaybackStuck | MicrophoneLost | CallBeforeLive | FocusUnavailable
type CloudSpeech = { credential: int, bound: int, phase: Phase, audioStarted: bool, capture: Capture, generation: int, turn: Turn, reply: Reply, batches: List[BatchRequest], endedBy: DeviceCause, focusPaused: bool }
type SpeechNotice = AskConsent | ReserveLiveCapture | ReleaseLiveCapture | RevokeSession | CancelUtterance({ utteranceId: str })
  | ReportRefusedKey({ version: int, reason: RefusalReason, on: C::RejectedOn }) | SessionFailed({ failure: Cr::Failure, beforeAudio: bool, wait: WaitTime })
  | Heard({ final: bool, capture: int }) | ReplySettled({ utteranceId: str, completed: bool }) | BatchSettled({ requestId: int, verdict: BatchVerdict })
type SpeechStep = { state: CloudSpeech, out: List[SpeechNotice] }
pure val initial: CloudSpeech = { credential: 0, bound: 0, phase: Idle, audioStarted: false, capture: Muted, generation: 0, turn: NoTurn, reply: NoReply, batches: List(), endedBy: NoDeviceCause, focusPaused: false }
pure val consentDeadline: Millis = 30 * millisPerSecond
pure def speechStep(out: List[SpeechNotice], s: CloudSpeech): SpeechStep = { state: s, out: out }
pure def noticeIf(c: bool, n: SpeechNotice): List[SpeechNotice] = if (c) List(n) else List()
pure def isOpen(p: Phase): bool = match p { | Idle => false | Closed(c) => false | _ => true }
pure def asksOf(p: Phase): int = match p { | AwaitingConsent(a) => a.asks | _ => 0 }
pure def waitedOf(p: Phase): Millis = match p { | AwaitingConsent(a) => a.waitedMs | _ => 0 }
pure def canBegin(s: CloudSpeech): bool = s.credential >= 1 and not(isOpen(s.phase))
pure def begin(s: CloudSpeech): SpeechStep = { state: { ...initial, credential: s.credential, bound: s.credential, batches: s.batches, phase: AwaitingConsent({ asks: 1, waitedMs: 0 }) }, out: List(AskConsent) }
pure def canConsentDismissed(s: CloudSpeech): bool = asksOf(s.phase) >= 1
pure def consentDismissed(s: CloudSpeech): SpeechStep = if (asksOf(s.phase) == 1)
  { state: { ...s, phase: AwaitingConsent({ asks: 2, waitedMs: waitedOf(s.phase) }) }, out: List(AskConsent) } else speechStep(List(), { ...s, phase: Closed({ ending: NotConsented }) })
pure def canConsentClock(s: CloudSpeech, waitMs: Millis): bool = asksOf(s.phase) >= 1 and waitMs > 0
pure def consentClock(s: CloudSpeech, waitMs: Millis): CloudSpeech = if (waitedOf(s.phase) + waitMs >= consentDeadline) { ...s, phase: Closed({ ending: NotConsented }) }
  else { ...s, phase: AwaitingConsent({ asks: asksOf(s.phase), waitedMs: waitedOf(s.phase) + waitMs }) }
pure val waitMsValues = Set(10000, 30000)
pure def canConsentGiven(s: CloudSpeech): bool = asksOf(s.phase) >= 1
pure def consentGiven(s: CloudSpeech): CloudSpeech = { ...s, phase: Minting }
pure def alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(s: CloudSpeech): bool = asksOf(s.phase) >= 1 implies (asksOf(s.phase) <= 2 and waitedOf(s.phase) >= 0 and waitedOf(s.phase) < consentDeadline)
pure def sometimesAskedAgain(s: CloudSpeech): bool = asksOf(s.phase) == 2
pure def sometimesNotConsented(s: CloudSpeech): bool = s.phase == Closed({ ending: NotConsented })
```

### An open session and every waiting batch request run under the current key, and a key change ends them

The shell reports each change of `C::activeVersion` (0 when signed out or
expired). A new version, sign-out or expiry ends the open session as
`AccountIneligible` and fails each waiting batch request.

```quint
pure def keyGone(b: BatchRequest): BatchRequest = if (b.verdict == BatchPending) { ...b, verdict: BatchFailed({ failure: Cr::AccountIneligible, wait: NoWait }) } else b
pure def canCredentialChanged(s: CloudSpeech, version: int): bool = version >= 0 and version != s.credential
pure def credentialChanged(s: CloudSpeech, version: int): SpeechStep = { val rebound = { ...s, credential: version, batches: s.batches.listMap(b => keyGone(b)) }
  val notices = s.batches.select(b => b.verdict == BatchPending).listMap(b => BatchSettled({ requestId: b.requestId, verdict: keyGone(b).verdict }))
  if (isOpen(s.phase)) failWith(Cr::AccountIneligible, rebound, notices, NoWait) else { state: rebound, out: notices } }
pure val versionValues = Set(0, 1, 2)
pure val weight_credentialChanged = 1
pure def alwaysOpenWorkUsesTheCurrentKey(s: CloudSpeech): bool = (isOpen(s.phase) implies (s.bound == s.credential and s.bound >= 1))
  and s.batches.every(b => b.verdict == BatchPending implies (b.version == s.credential and b.version >= 1))
pure def sometimesKeyChangeEndedSession(s: CloudSpeech): bool = s.bound >= 1 and s.credential != s.bound and hasEnded(s.phase)
```

### Only a mint answer naming the deployment's own relay opens the socket, and a refused key is reported once and never retried

Consent and mint answer here as one; a wrong shape or a `wsUrl` off the
deployment origin is `Misdirected`. A `401` with a credential reason goes
to `C::rejected`; every refusal ends its request and passes on its retry
or reset time (a `429` or `402` limit). The consent request comes before any
paid admission and writes nothing before the cloud's rate limiter, so the
shell sends it once more, and only once: after its connection was dropped
(reset by the peer, or a pooled connection that ended before its answer,
OkHttp's "unexpected end of stream"), or after a `503` whose `Retry-After`
is at most 2 s, once that wait is over, when the wait and one more request
of 2 s still end before the startup deadline. A `503` without `Retry-After`
or a second refusal ends the request as before; a mint request is never
sent again. Before a session, the renderer may ask the shell to open its
connection to the deployment's own origin with `GET /api/health`, which
carries no key and asks no consent, so that the consent request, the mint
and the socket reuse it: at most once a minute for each origin, never while
voice is closed, in the background, in a session or on a sensitive
surface, bounded by 5 s and silent when it fails. The shell's content-free
startup timings mark each consent and mint request's start, headers, body
or failure, and a consent sent again. A session's marks up to `ready` are
kept apart from the later per-utterance marks, each with its own bound, so a
long session's utterances never evict how it started.

```quint
type CloudAnswer = Answered | Misdirected | Unreachable | Refused({ refusal: Refusal })
pure def refusalFailure(code: RefusalCode): Cr::Failure = { val status = statusOf(code)
  if (status == 401 or status == 402 or status == 403) Cr::AccountIneligible else if (status == 404) Cr::CapabilityUnavailable else if (status == 503) Cr::RemoteUnreachable else Cr::RequestFailed }
pure def failureOf(a: CloudAnswer): Cr::Failure = match a { | Answered => Cr::NoFailure | Misdirected => Cr::RequestFailed | Unreachable => Cr::RemoteUnreachable | Refused(r) => refusalFailure(r.refusal.code) }
pure def waitOf(a: CloudAnswer): WaitTime = match a { | Refused(r) => r.refusal.wait | _ => NoWait }
pure def keyReport(a: CloudAnswer, version: int): List[SpeechNotice] = match a { | Refused(r) => noticeIf(r.refusal.code == AuthenticationRequired
  and isCredentialReason(r.refusal.reason), ReportRefusedKey({ version: version, reason: r.refusal.reason, on: C::OtherRequest })) | _ => List() }
pure def canMinted(s: CloudSpeech): bool = s.phase == Minting
pure def minted(s: CloudSpeech, answer: CloudAnswer): SpeechStep = if (answer == Answered) speechStep(List(), { ...s, phase: Connecting })
  else failWith(failureOf(answer), s, keyReport(answer, s.credential), waitOf(answer))
pure val answerValues = Set(Answered, Misdirected, Unreachable, Refused({ refusal: { code: AuthenticationRequired, reason: CredentialExpired, wait: NoWait } }),
  Refused({ refusal: { code: RateLimited, reason: NoReason, wait: RetryAt({ retryAtMs: 5000 }) } }), Refused({ refusal: { code: AllowanceExhausted, reason: NoReason, wait: ResetsAt({ resetsAtMs: 9000 }) } }))
pure val weight_minted = 12
pure def keyReportVersion(n: SpeechNotice): int = match n { | ReportRefusedKey(k) => k.version | _ => -1 }
pure def closing(before: CloudSpeech, after: CloudSpeech): bool = isOpen(before.phase) and not(isOpen(after.phase))
pure def stepARefusedKeyIsReportedOnceAndEndsItsRequest(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool = out.select(n => keyReportVersion(n) != -1).length() <= 1
  and out.every(n => keyReportVersion(n) == -1 or (keyReportVersion(n) == before.credential and (closing(before, after) or via == "batchAnswered")))
```

### The device accepts relay frames only in protocol order, and any other frame ends the session

`ready` comes first, then `extended` at any time; `connected` makes the
session live, and turns and `complete` follow it (audio is `audioArrived`). An `error`, a closed
socket or a stalled startup or deadline (`relayLost`) ends the session.
Discovered by simulation: a protocol failure can only come from the current
relay. An idle device cannot report one by itself.

```quint
pure def mintedPhase(p: Phase): bool = p == Connecting or p == Ready or p == Live
pure def relayFailure(code: Rl::RelayErrorCode, reason: Rl::RelayReason): Cr::Failure = if (code == Rl::RelayUnauthorized or reason != Rl::NoRelayReason) Cr::AccountIneligible
  else if (code == Rl::RelayUnavailable) Cr::RemoteUnreachable else Cr::RequestFailed
pure def failRelay(failure: Cr::Failure, s: CloudSpeech): SpeechStep = failWith(failure, s, List(), NoWait)
pure def canFrameArrived(s: CloudSpeech): bool = mintedPhase(s.phase)
pure def frameArrived(s: CloudSpeech, frame: Rl::ServerFrame): SpeechStep = match frame {
  | ReadyFrame => if (s.phase == Connecting) speechStep(List(), { ...s, phase: Ready }) else failRelay(Cr::RequestFailed, s)
  | SttFrame(e) => if (e.kind == Rl::SttConnected) (if (s.phase == Ready) speechStep(List(), { ...s, phase: Live }) else if (s.phase == Live) speechStep(List(), s) else failRelay(Cr::RequestFailed, s))
      else if (s.phase == Live) onTurn(e.kind, s) else failRelay(Cr::RequestFailed, s)
  | ExtendedFrame => if (s.phase != Connecting) speechStep(List(), s) else failRelay(Cr::RequestFailed, s)
  | CompleteFrame(f) => if (s.phase == Live) onComplete(f.id, s) else failRelay(Cr::RequestFailed, s)
  | ErrorFrame(e) => failRelay(relayFailure(e.code, e.reason), s)
  | CloseFrame(c) => failRelay(Cr::RemoteUnreachable, s)
  | _ => if (s.phase == Live) speechStep(List(), s) else failRelay(Cr::RequestFailed, s)
}
pure val frameValues = Set(Rl::ReadyFrame, Rl::SttFrame({ kind: Rl::SttConnected }), Rl::SttFrame({ kind: Rl::StartOfTurn }), Rl::SttFrame({ kind: Rl::TurnResumed }), Rl::SttFrame({ kind: Rl::TranscriptUpdate }),
  Rl::SttFrame({ kind: Rl::EndOfTurn }), Rl::ExtendedFrame, Rl::CompleteFrame({ id: "u1" }), Rl::CompleteFrame({ id: "u2" }), Rl::ErrorFrame({ code: Rl::RelayUnavailable, reason: Rl::FundingReason({ funding: Rl::CreditsShort }) }))
pure val weight_frameArrived = 18
pure def canRelayLost(s: CloudSpeech): bool = mintedPhase(s.phase)
pure def relayLost(s: CloudSpeech): SpeechStep = failRelay(Cr::RemoteUnreachable, s)
pure def openingRank(p: Phase): int = match p { | AwaitingConsent(a) => 1 | Minting => 2 | Connecting => 3 | Ready => 4 | Live => 5 | _ => 0 }
pure def stepTheSessionOpensInOrder(before: CloudSpeech, after: CloudSpeech): bool = openingRank(after.phase) >= 2 implies (openingRank(before.phase) == openingRank(after.phase) or openingRank(before.phase) + 1 == openingRank(after.phase))
```

### Capture starts muted, and listens only once the microphone slot is granted with RECORD_AUDIO

Unmuting reserves the slot as a live capture; a refused slot ends the
session, as in develop. A start that is not muted and has `RECORD_AUDIO`
reserves the slot and opens the microphone at once, so the device's
start-up is off the path to listening: until capture listens, each frame it
reads is zeroed and dropped, and none is sent, kept or shown as a level.
Unmuting then answers from that held slot; a busy slot at the start leaves
unmuting to reserve it as before. A mute, a draft request, a focus pause or
a start that settles muted closes it, and every end of the session closes
it, freeing the slot before a failure is reported so that a fallback finds
it free. Each granted capture gets the next number; muting
releases the slot and keeps it, so a turn the capture began may finish.
Muting a session paused by a focus loss also ends the pause.

```quint
pure def canUnmute(s: CloudSpeech, recordAudio: bool): bool = s.phase == Live and s.capture == Muted and recordAudio and not(s.focusPaused)
pure def unmute(s: CloudSpeech, recordAudio: bool): SpeechStep = { state: { ...s, capture: Reserving }, out: List(ReserveLiveCapture) }
pure def canCaptureAnswered(s: CloudSpeech): bool = s.capture == Reserving
pure def captureAnswered(s: CloudSpeech, slot: M::Refusal): SpeechStep = if (slot == M::NoRefusal) speechStep(List(), { ...s, capture: Listening, generation: s.generation + 1, audioStarted: true })
  else failWith(Cr::CapabilityUnavailable, { ...s, capture: Muted }, List(), NoWait)
pure val slotValues = Set(M::NoRefusal, M::SlotBusy)
pure def canMute(s: CloudSpeech): bool = s.capture != Muted or s.focusPaused
pure def mute(s: CloudSpeech): SpeechStep = { state: { ...s, capture: Muted, focusPaused: false }, out: noticeIf(s.capture != Muted, ReleaseLiveCapture) }
pure def sometimesListening(s: CloudSpeech): bool = s.phase == Live and s.capture == Listening
```

### The speaker is muted for the whole session without ending voice, and only an open session whose bridge can mute it applies the mute

`setOutputMuted(muted)` asks the open session's bridge
(`setCloudSpeechOutputMuted`) to play replies at no volume. It changes
neither the capture nor the reply: a muted reply still plays, reports its
first audio and settles completed, and every later reply of the session
starts muted until the owner unmutes. Before the session is open, or on a
bridge without the method, the request is refused as
`output-mute-unavailable` and nothing changes. Muting the speaker is not
muting the capture (above). The volume a muted or unmuted reply plays at
is [speech output](./speechOutput.md)'s.

```quint
type SpeakerMuteAnswer = SpeakerMuteApplied | SpeakerMuteUnavailable
pure def speakerMuteAnswer(sessionOpened: bool, bridgeMutesSpeaker: bool): SpeakerMuteAnswer =
  if (sessionOpened and bridgeMutesSpeaker) SpeakerMuteApplied else SpeakerMuteUnavailable
pure def lawASpeakerMuteNeedsAnOpenSessionWhoseBridgeCanMute(sessionOpened: bool, bridgeMutesSpeaker: bool): bool =
  (speakerMuteAnswer(sessionOpened, bridgeMutesSpeaker) == SpeakerMuteApplied) iff (sessionOpened and bridgeMutesSpeaker)
```

### A provider speech edge belongs to the capture live when it began, and a retired capture owns none

A turn that starts while muted belongs to no capture, and a turn's text is
published only for the newest capture and only if it began in it, so speech
heard while the agent talked never becomes the next turn.

```quint
pure def turnOwner(t: Turn): int = match t { | TurnOf(x) => x.capture | NoTurn => -1 }
pure def ownedTurn(s: CloudSpeech): bool = turnOwner(s.turn) >= 1 and turnOwner(s.turn) == s.generation
pure def onTurn(kind: Rl::SttEventKind, s: CloudSpeech): SpeechStep = if (kind == Rl::StartOfTurn or kind == Rl::TurnResumed) speechStep(List(), if (s.turn == NoTurn) { ...s, turn: TurnOf({ capture: if (s.capture == Listening) s.generation else 0 }) } else s)
  else { state: if (kind == Rl::EndOfTurn) { ...s, turn: NoTurn } else s, out: noticeIf(ownedTurn(s), Heard({ final: kind == Rl::EndOfTurn, capture: s.generation })) }
pure def heardCapture(n: SpeechNotice): int = match n { | Heard(h) => h.capture | _ => -1 }
pure def stepOnlyTheCaptureATurnBeganInPublishesIt(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool = out.every(n => heardCapture(n) == -1 or (heardCapture(n) >= 1 and heardCapture(n) == before.generation and turnOwner(before.turn) == heardCapture(n)))
pure def alwaysOnlyALiveSessionCaptures(s: CloudSpeech): bool = s.generation >= 0 and turnOwner(s.turn) <= s.generation
  and (s.phase != Live implies (s.capture == Muted and s.turn == NoTurn and s.reply == NoReply and not(s.focusPaused)))
  and (s.capture == Listening implies (s.generation >= 1 and s.audioStarted))
  and (s.focusPaused implies (s.capture == Muted and s.reply == NoReply))
pure def sometimesTurnWithoutCapture(s: CloudSpeech): bool = s.phase == Live and s.turn == TurnOf({ capture: 0 })
pure val weight_unmute = 6
pure val weight_captureAnswered = 8
pure val weight_mute = 3
pure val weight_begin = 8
pure val weight_consentGiven = 8
pure def sometimesMutedCaptureFinishesItsTurn(s: CloudSpeech): bool = s.capture == Muted and ownedTurn(s)
```

### A confirmed mute whose turn has not ended in 2.5 seconds replaces the session with a fresh muted one, and the old session's late text is dropped

Muting waits up to 2.5 s for the bridge to confirm the mute and for a turn
that began before it to end. A mute the bridge does not confirm in that
time is refused as `mute-unconfirmed`, and no other session is opened. A
confirmed mute whose turn has not ended cannot attribute that turn's text
safely: the device stops the session, waits until the stop is confirmed,
and starts a fresh session under the same key, muted from the start and
with the speaker mute it had. The unfinished turn ends with nothing heard
for the capture it began in, anything the old session reports afterwards
is dropped. A capture requested during replacement waits for the fresh
muted session before it unmutes it. A reply still
playing cannot move to another session, so a mute that would replace the
session then is refused as `capture-unsettled`. Stopping voice while the
old session closes joins that stop and opens nothing.

```quint
type MuteSettlement = MuteSettled | ReplaceSession | MuteUnconfirmed | CaptureUnsettled
pure val muteSettleMs: Millis = 2500
pure def muteSettlement(confirmed: bool, turnEnded: bool, replyPlaying: bool): MuteSettlement =
  if (not(confirmed)) MuteUnconfirmed else if (turnEnded) MuteSettled else if (replyPlaying) CaptureUnsettled else ReplaceSession
pure def lawOnlyAConfirmedMuteThatLostItsTurnWithNoReplyPlayingReplacesTheSession(confirmed: bool, turnEnded: bool, replyPlaying: bool): bool =
  (muteSettlement(confirmed, turnEnded, replyPlaying) == ReplaceSession) iff (confirmed and not(turnEnded) and not(replyPlaying))
pure def lawAnUnconfirmedMuteNeverSettles(turnEnded: bool, replyPlaying: bool): bool =
  muteSettlement(false, turnEnded, replyPlaying) == MuteUnconfirmed
```

### A reply plays at a pace from 50 to 200 percent, one at a time, and never ahead of the audio received

`speak` sends the reply's text and its audio plays through `O`. Audio for
another id is ignored; audio after the relay's `complete` ends the session.

```quint
pure val minPace = 50
pure val maxPace = 200
pure def replyId(r: Reply): str = match r { | Playing(x) => x.utteranceId | NoReply => "" }
pure def canSpeak(s: CloudSpeech, utteranceId: str, pace: int): bool = s.phase == Live and s.reply == NoReply and not(s.focusPaused) and utteranceId != "" and pace >= minPace and pace <= maxPace
pure def speak(s: CloudSpeech, utteranceId: str, pace: int): CloudSpeech = { ...s, reply: Playing({ utteranceId: utteranceId, pace: pace, receivedMs: 0, playedMs: 0, completed: false }) }
pure val utteranceIdValues = Set("u1", "u2")
pure val paceValues = Set(50, 200, 250)
pure def canAudioArrived(s: CloudSpeech, utteranceId: str, audioMs: Millis): bool = s.phase == Live and audioMs > 0
pure def audioArrived(s: CloudSpeech, utteranceId: str, audioMs: Millis): SpeechStep = { val r = s.reply  match r {
  | Playing(x) => if (x.utteranceId != utteranceId) speechStep(List(), s) else if (x.completed) failRelay(Cr::RequestFailed, s)
      else speechStep(List(), { ...s, audioStarted: true, reply: Playing({ ...x, receivedMs: x.receivedMs + audioMs }) })
  | NoReply => speechStep(List(), s) } }
pure val audioMsValues = Set(40, 100)
pure def alwaysAReplyNeverPlaysAheadOfItsAudio(s: CloudSpeech): bool = { val r = s.reply  match r { | NoReply => true | Playing(x) => x.utteranceId != ""
  and x.pace >= minPace and x.pace <= maxPace and x.playedMs >= 0 and x.playedMs <= x.receivedMs and (x.completed implies x.playedMs < x.receivedMs) } }
pure val weight_speak = 6
pure val weight_audioArrived = 3
```

### A reply settles once: completed when all its audio has played, or cancelled

`complete` (never before audio) settles the reply once all its audio has
played. Cancelling or a focus refusal from `O` settles it uncompleted and
tells the relay; a call starting (`O::StopCapture`) ends the session.

```quint
pure def settleReply(id: str, completed: bool, s: CloudSpeech): SpeechStep = { state: { ...s, reply: NoReply }, out: List(ReplySettled({ utteranceId: id, completed: completed })) }
pure def onComplete(id: str, s: CloudSpeech): SpeechStep = { val r = s.reply  match r {
  | Playing(x) => if (x.utteranceId != id) speechStep(List(), s) else if (x.receivedMs == 0) failRelay(Cr::RequestFailed, s)
      else if (x.playedMs == x.receivedMs) settleReply(id, true, s) else speechStep(List(), { ...s, reply: Playing({ ...x, completed: true }) })
  | NoReply => speechStep(List(), s) } }
pure def canPlayed(s: CloudSpeech, playedMs: Millis): bool = { val r = s.reply  match r { | Playing(x) => playedMs > 0 and x.playedMs + playedMs <= x.receivedMs | NoReply => false } }
pure def played(s: CloudSpeech, playedMs: Millis): SpeechStep = { val r = s.reply  match r {
  | Playing(x) => if (x.completed and x.playedMs + playedMs == x.receivedMs) settleReply(x.utteranceId, true, s)
      else speechStep(List(), { ...s, reply: Playing({ ...x, playedMs: x.playedMs + playedMs }) })
  | NoReply => speechStep(List(), s) } }
pure val playedMsValues = Set(20, 40, 60)
pure val weight_played = 6
pure def canCancelReply(s: CloudSpeech): bool = s.reply != NoReply
pure def cancelReply(s: CloudSpeech): SpeechStep = { val id = replyId(s.reply)  { state: { ...s, reply: NoReply }, out: List(CancelUtterance({ utteranceId: id }), ReplySettled({ utteranceId: id, completed: false })) } }
pure def canOutputNotice(s: CloudSpeech, notice: O::OutputNotice): bool = s.phase == Live and (notice == O::PauseListening implies s.reply == NoReply)
pure def outputNotice(s: CloudSpeech, notice: O::OutputNotice): SpeechStep = if (notice == O::StopCapture) failRelay(Cr::CapabilityUnavailable, s)
  else if ((notice == O::RefusedFocusDenied or notice == O::RefusedCallActive or notice == O::RefusedFocusPaused) and s.reply != NoReply) cancelReply(s)
  else if (notice == O::PauseListening and not(s.focusPaused)) { state: { ...s, capture: Muted, focusPaused: true }, out: noticeIf(s.capture != Muted, ReleaseLiveCapture) }
  else if (notice == O::ResumeListening and s.focusPaused) { state: { ...s, capture: Reserving, focusPaused: false }, out: List(ReserveLiveCapture) }
  else speechStep(List(), s)
pure val noticeValues = Set(O::StopCapture, O::RefusedFocusDenied, O::PauseListening, O::ResumeListening)
pure def isReplySettled(n: SpeechNotice): bool = match n { | ReplySettled(x) => true | _ => false }
pure def stepAReplySettlesOnce(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool = out.select(n => isReplySettled(n)).length() == (if (replyId(before.reply) != "" and replyId(after.reply) != replyId(before.reply)) 1 else 0)
pure def sometimesCompletedReplyStillPlaying(s: CloudSpeech): bool = { val r = s.reply  match r { | Playing(x) => x.completed and x.playedMs > 0 | NoReply => false } }
```

### Every end of a session releases the microphone, settles the reply, revokes the session and reports a failure once

Only the person's stop and declined consent end without a failure. A
failure says whether audio had started (capture granted or reply audio
received): before it core routing may re-route; after it nothing falls
back silently. An end while minting revokes what the mint may return.

```quint
pure def revokeOwed(p: Phase): bool = p == Minting or mintedPhase(p)
pure def failureOfEnding(e: Ending): Cr::Failure = match e { | FailedBeforeAudio(f) => f.failure | FailedAfterAudio(f) => f.failure | _ => Cr::NoFailure }
pure def endingOf(p: Phase): Ending = match p { | Closed(c) => c.ending | _ => Stopped }
pure def closeWith(ending: Ending, s: CloudSpeech, first: List[SpeechNotice], wait: WaitTime): SpeechStep = { val id = replyId(s.reply)  val failure = failureOfEnding(ending)
  { state: { ...s, phase: Closed({ ending: ending }), capture: Muted, turn: NoTurn, reply: NoReply, focusPaused: false },
    out: first.concat(noticeIf(s.capture != Muted, ReleaseLiveCapture)).concat(noticeIf(id != "", ReplySettled({ utteranceId: id, completed: false })))
      .concat(noticeIf(revokeOwed(s.phase), RevokeSession)).concat(noticeIf(failure != Cr::NoFailure, SessionFailed({ failure: failure, beforeAudio: not(s.audioStarted), wait: wait }))) } }
pure def failWith(failure: Cr::Failure, s: CloudSpeech, first: List[SpeechNotice], wait: WaitTime): SpeechStep =
  closeWith(if (s.audioStarted) FailedAfterAudio({ failure: failure }) else FailedBeforeAudio({ failure: failure }), s, first, wait)
pure def canStop(s: CloudSpeech): bool = isOpen(s.phase)
pure def stop(s: CloudSpeech): SpeechStep = closeWith(Stopped, s, List(), NoWait)
pure def failedBefore(n: SpeechNotice): int = match n { | SessionFailed(f) => if (f.beforeAudio) 1 else 0 | _ => -1 }
pure def stepAnEndReleasesRevokesAndReportsOnce(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool = {
  val failedNow = closing(before, after) and failureOfEnding(endingOf(after.phase)) != Cr::NoFailure
  out.select(n => failedBefore(n) != -1).length() == (if (failedNow) 1 else 0)
  and out.every(n => failedBefore(n) == -1 or (failedBefore(n) == 1) == not(before.audioStarted))
  and (closing(before, after) implies ((before.capture == Listening implies out.includes(ReleaseLiveCapture)) and (revokeOwed(before.phase) implies out.includes(RevokeSession)))) }
pure def failedAfterAudio(e: Ending): bool = match e { | FailedAfterAudio(f) => true | _ => false }
pure def failedBeforeAudio(e: Ending): bool = match e { | FailedBeforeAudio(f) => true | _ => false }
pure def hasEnded(p: Phase): bool = p != Idle and not(isOpen(p))
pure def alwaysAnEndingSaysWhetherAudioStarted(s: CloudSpeech): bool =
  (s.audioStarted implies (s.phase == Live or (hasEnded(s.phase) and (endingOf(s.phase) == Stopped or failedAfterAudio(endingOf(s.phase))))))
  and ((hasEnded(s.phase) and failedAfterAudio(endingOf(s.phase))) implies s.audioStarted)
  and ((failedBeforeAudio(endingOf(s.phase)) or failedAfterAudio(endingOf(s.phase))) implies failureOfEnding(endingOf(s.phase)) != Cr::NoFailure)
pure def sometimesFailedBeforeAudio(s: CloudSpeech): bool = failedBeforeAudio(endingOf(s.phase)) and hasEnded(s.phase)
pure def sometimesFailedAfterAudio(s: CloudSpeech): bool = failedAfterAudio(endingOf(s.phase)) and hasEnded(s.phase)
```

### A device that can no longer hold an open session ends it as a failure that names its cause

Leaving the foreground or closing (`DevicePaused`), a reply's speaker that
fails or stalls (`PlaybackStuck`), a microphone lost while capture is on
(`MicrophoneLost`), a call starting before the session is live
(`CallBeforeLive`) and audio focus refused when the live session opens its
microphone or lost for good (`FocusUnavailable`, `audio-focus-lost`) each
end the open session as `CapabilityUnavailable`,
closing it as every other failure does. A call once the session is live is
`O::StopCapture`. The cause is kept until the next session begins.

```quint
pure def deviceFailure(cause: DeviceCause): Cr::Failure = Cr::CapabilityUnavailable
pure def canDeviceEnded(s: CloudSpeech, cause: DeviceCause): bool = match cause {
  | DevicePaused => isOpen(s.phase)
  | PlaybackStuck => s.phase == Live
  | MicrophoneLost => s.phase == Live and s.capture != Muted
  | CallBeforeLive => isOpen(s.phase) and s.phase != Live
  | FocusUnavailable => s.phase == Live
  | NoDeviceCause => false
}
pure def deviceEnded(s: CloudSpeech, cause: DeviceCause): SpeechStep = { val ended = failWith(deviceFailure(cause), s, List(), NoWait)
  { state: { ...ended.state, endedBy: cause }, out: ended.out } }
pure val causeValues = Set(DevicePaused, PlaybackStuck, MicrophoneLost, CallBeforeLive, FocusUnavailable)
pure def alwaysADeviceEndIsAFailure(s: CloudSpeech): bool = s.endedBy != NoDeviceCause implies
  (hasEnded(s.phase) and failureOfEnding(endingOf(s.phase)) == Cr::CapabilityUnavailable)
pure def sometimesCallEndedBeforeLive(s: CloudSpeech): bool = s.endedBy == CallBeforeLive and hasEnded(s.phase)
pure def sometimesPlaybackStuckAfterAudio(s: CloudSpeech): bool = s.endedBy == PlaybackStuck and failedAfterAudio(endingOf(s.phase))
```

### A transient focus loss pauses listening and speaking until focus returns

The session holds audio focus while it speaks or its microphone is open
(`O::openListening`). When another app takes focus for a while, the reply
stops, interrupted (`audio-focus-lost`), the microphone closes after the
silence tail that ends the provider's turn, and the session stays open but
paused (`focus-paused`): it neither listens nor speaks, and a reply is
refused as `audio-focus-paused`. When focus returns (`focus-resumed`) the
microphone opens again; muting meanwhile ends the pause and gives focus up.
A session that only speaks holds focus only while it does, so a loss stops
its reply and nothing else. Only a permanent loss or a call ends the
session.

```quint
pure def sometimesFocusPaused(s: CloudSpeech): bool = s.phase == Live and s.focusPaused and s.turn != NoTurn
pure def sometimesFocusUnavailable(s: CloudSpeech): bool = s.endedBy == FocusUnavailable and failedAfterAudio(endingOf(s.phase))
pure val eval_witness_sometimesFocusUnavailable = (
  ("credentialChanged", 1),
  "begin",
  "consentGiven",
  ("minted", Answered),
  ("frameArrived", Rl::ReadyFrame),
  ("frameArrived", Rl::SttFrame({ kind: Rl::SttConnected })),
  ("unmute", true),
  ("captureAnswered", M::NoRefusal),
  ("outputNotice", O::PauseListening),
  ("outputNotice", O::ResumeListening),
  ("captureAnswered", M::NoRefusal),
  ("deviceEnded", FocusUnavailable)
)
```

## Story: Transcribe a recording or hear a reply with one cloud request

> As a person dictating a note or listening to a reply without a live
> session, I want each cloud request to give one answer or one reason it
> failed, so that nothing is transcribed or spoken twice.

### Each batch transcription or synthesis settles once, and a refusal keeps its retry time

Its answer, its cancellation or a key change settles a request sent under
the active key, and a settled request never changes.

```quint
pure def pending(s: CloudSpeech, requestId: int): bool = s.batches.some(b => b.requestId == requestId and b.verdict == BatchPending)
pure def canBatchRequested(s: CloudSpeech, requestId: int, direction: SpeechDirection): bool = s.credential >= 1 and requestId >= 1 and not(s.batches.some(b => b.requestId == requestId))
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
pure def stepABatchRequestSettlesOnce(before: CloudSpeech, via: str, after: CloudSpeech, out: List[SpeechNotice]): bool = before.batches.every(b => after.batches.some(a => a.requestId == b.requestId and (b.verdict != BatchPending implies a.verdict == b.verdict))
    and out.select(n => settledId(n) == b.requestId).length() == (if (b.verdict == BatchPending and not(pending(after, b.requestId))) 1 else 0))
pure def alwaysBatchRequestsAreDistinct(s: CloudSpeech): bool = s.batches.every(b => b.requestId >= 1 and s.batches.select(x => x.requestId == b.requestId).length() == 1)
pure def sometimesBatchRateLimited(s: CloudSpeech): bool = s.batches.some(b => b.verdict == BatchFailed({ failure: Cr::RequestFailed, wait: RetryAt({ retryAtMs: 5000 }) }))
pure def sometimesBatchDoneAndCancelled(s: CloudSpeech): bool = s.batches.some(b => b.verdict == BatchDone) and s.batches.some(b => b.verdict == BatchCancelled)
```
