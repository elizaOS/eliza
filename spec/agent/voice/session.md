# Voice session

The voice turn logic of the browser-safe voice controller, exported from
the `@elizaos/agent` root as `VoiceSession` and, for a full-duplex session,
`createLiveVoiceSession`. A session listens, decides when an utterance is
finished, sends it once as a `VOICE_DM` [turn](../conversation/turns.md),
plays the reply and, when the person cuts the reply short, reports what of
it they heard. Audio itself is [client audio](./clientAudio.md).
Microphone, recognition, the end-of-turn scorer, the turn transport and
the heard route are injected ports; timers are the shell's, and each timer
event carries the utterance epoch it was started for. Times are whole
milliseconds; a transcript's words arrive counted and its overlap with the
reply computed, in whole percent (`voice/echo-filter.ts`).

## Story: Send my words once I finish speaking

> As a person talking to the assistant, I want what I say sent once I have
> finished, not while I pause mid-sentence, and never twice.

### A session owns one microphone capture, and a half-duplex session reopens it only after the turn

Start opens the capture for conversation or dictation, half or full
duplex. A half-duplex session closes the microphone for each turn and
reopens it once the turn has ended; a full-duplex one keeps it open so the
person can cut in. A capture that opens after Stop is closed at once. A
capture that fails to open or close ends the session with an error; one
that failed to close may still hold the microphone, so it stays
unreleased. Stop ends the session, retires the utterance and the turn, and
closes an open capture; a new session starts only once the capture is
closed.

```quint
import turns as T from "../conversation/turns"
type InputMode = ConversationMode | DictationMode
type Duplex = HalfDuplex | FullDuplex
type SessionLife = Idle | Starting | Live | Failed
type CaptureState = CaptureClosed | CaptureOpening | CaptureOpen | CaptureClosing | CaptureUnreleased
type Utterance = NoUtterance | Hearing | AwaitingFinal | GapWaiting | AskingEndOfTurn | WaitingLongGap
type TurnStage = NoTurn | AwaitingClose | ReadyToSend | AwaitingReply | Playing
type SubmitCause = NoSubmit | EndOfTurnSubmit | LongGapSubmit
type TurnEnd = NoEnd | ReplyPlayed | ReplyCut | TurnAborted | ReplyBroke | TurnFailed
type ReportOutcome = ReportAnswered({ verdict: T::HeardVerdict }) | ReportUnavailable | ReportRejected
type ReportPhase = ReportDue | ReportPosting | ReportSettled({ outcome: ReportOutcome })
type HeardReceipt = { reply: int, attempts: int, phase: ReportPhase, nothingHeard: bool }
type StopReport = StopReportsHeard | StopReportsNone
type VoiceProfile = { shortGapMs: int, longGapMs: int, bargeInHoldMs: int, stopReport: StopReport }
type VoiceSession = { life: SessionLife, mode: InputMode, duplex: Duplex, capture: CaptureState, utterance: Utterance,
  epoch: int, hasText: bool, turn: TurnStage, cause: SubmitCause, sent: int, bargeIn: bool, reply: int,
  segments: int, played: int, lastEnd: TurnEnd, receipts: List[HeardReceipt], drafts: int, profile: VoiceProfile,
  rejoined: int, supersedes: int }
pure val initial: VoiceSession = { life: Idle, mode: ConversationMode, duplex: HalfDuplex, capture: CaptureClosed,
  utterance: NoUtterance, epoch: 0, hasText: false, turn: NoTurn, cause: NoSubmit, sent: 0, bargeIn: false, reply: 0,
  segments: 0, played: 0, lastEnd: NoEnd, receipts: List(), drafts: 0, profile: defaultVoiceProfile, rejoined: 0, supersedes: 0 }
pure def isRunning(life: SessionLife): bool = life == Starting or life == Live
pure def halted(life: SessionLife, s: VoiceSession): VoiceSession =
  { ...cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s), life: life, utterance: NoUtterance, hasText: false, epoch: s.epoch + 1, rejoined: 0 }
pure def canStart(s: VoiceSession, profile: VoiceProfile): bool = not(isRunning(s.life)) and s.capture == CaptureClosed and profileAdmitted(profile)
pure def start(s: VoiceSession, mode: InputMode, duplex: Duplex, profile: VoiceProfile): VoiceSession =
  { ...s, life: Starting, mode: mode, duplex: duplex, capture: CaptureOpening, cause: NoSubmit, profile: profile }
pure def canCaptureOpened(s: VoiceSession): bool = s.capture == CaptureOpening
pure def captureOpened(s: VoiceSession): VoiceSession =
  if (isRunning(s.life)) { ...s, capture: CaptureOpen, life: Live } else { ...s, capture: CaptureClosing }
pure def canCaptureClosed(s: VoiceSession): bool = s.capture == CaptureClosing
pure def captureClosed(s: VoiceSession): VoiceSession = { ...s, capture: CaptureClosed, turn: if (s.turn == AwaitingClose) ReadyToSend else s.turn }
pure def canCaptureFailed(s: VoiceSession): bool = s.capture == CaptureOpening or s.capture == CaptureClosing
pure def captureFailed(s: VoiceSession): VoiceSession =
  { ...halted(if (isRunning(s.life)) Failed else s.life, s), capture: if (s.capture == CaptureClosing) CaptureUnreleased else CaptureClosed }
pure def canReopenCapture(s: VoiceSession): bool = isRunning(s.life) and s.turn == NoTurn and s.capture == CaptureClosed
pure def reopenCapture(s: VoiceSession): VoiceSession = { ...s, capture: CaptureOpening }
pure def canStop(s: VoiceSession): bool = isRunning(s.life)
pure def stop(s: VoiceSession): VoiceSession =
  { ...halted(Idle, s), capture: if (s.capture == CaptureOpen) CaptureClosing else s.capture,
    receipts: if (s.profile.stopReport == StopReportsNone) s.receipts else halted(Idle, s).receipts }
pure val weight_captureOpened = 4
pure val weight_captureClosed = 4
pure def alwaysTheSessionOwnsItsCapture(s: VoiceSession): bool =
  (s.capture == CaptureOpen implies isRunning(s.life)) and
  (s.utterance != NoUtterance implies (isRunning(s.life) and s.capture == CaptureOpen)) and
  (s.turn != NoTurn implies (isRunning(s.life) and s.mode == ConversationMode))
pure def alwaysAHeldMicrophoneStaysClosedDuringItsTurn(s: VoiceSession): bool =
  (s.turn == AwaitingClose implies (s.duplex == HalfDuplex and s.capture == CaptureClosing)) and
  ((s.duplex == HalfDuplex and s.turn != NoTurn and s.turn != AwaitingClose) implies s.capture == CaptureClosed)
pure def sometimesAFailedCaptureEndsTheSession(s: VoiceSession): bool = s.life == Failed and s.capture == CaptureClosed
```

### A capture that failed to close is kept until it confirms its release, and no capture opens over it

Stop asks an unreleased capture to close again, and a close that fails
again keeps it unreleased; only its confirmed close lets a new session
start.

```quint
pure def canRetryRelease(s: VoiceSession): bool = s.capture == CaptureUnreleased
pure def retryRelease(s: VoiceSession): VoiceSession = { ...s, capture: CaptureClosing }
pure def alwaysAnUnreleasedCaptureEndedItsSession(s: VoiceSession): bool = s.capture == CaptureUnreleased implies not(isRunning(s.life))
pure def stepNothingOpensOverAnUnreleasedCapture(before: VoiceSession, after: VoiceSession): bool =
  before.capture == CaptureUnreleased implies (after.capture == CaptureUnreleased or after.capture == CaptureClosing)
pure def sometimesACaptureIsUnreleased(s: VoiceSession): bool = s.capture == CaptureUnreleased
```

### A session's timings and Stop report are the profile it started with: a short gap no longer than the long gap, a long gap of at most 10,000 ms, a hold of at most 5,000 ms, and 300, 1,200 and 700 ms with a heard report on Stop by default

The consumer chooses a `VoiceProfile` at Start, `{shortGapMs, longGapMs,
bargeInHoldMs, stopReport}`; a profile out of bounds refuses Start, and the
profile holds until the next Start. Every gap and hold rule below reads
its value from the session's profile. The default is the upstream session;
an open-microphone product may use no gaps, a shorter hold and no report
on Stop (`{0, 0, 400, StopReportsNone}`).

```quint
pure val maxLongGapMs = 10000
pure val maxBargeInHoldMs = 5000
pure val defaultVoiceProfile: VoiceProfile = { shortGapMs: 300, longGapMs: 1200, bargeInHoldMs: 700, stopReport: StopReportsHeard }
pure def profileAdmitted(p: VoiceProfile): bool =
  p.shortGapMs >= 0 and p.shortGapMs <= p.longGapMs and p.longGapMs <= maxLongGapMs and
  p.bargeInHoldMs >= 0 and p.bargeInHoldMs <= maxBargeInHoldMs
pure val profileValues = Set(defaultVoiceProfile,
  { shortGapMs: 0, longGapMs: 0, bargeInHoldMs: 400, stopReport: StopReportsNone },
  { shortGapMs: 500, longGapMs: 100, bargeInHoldMs: 700, stopReport: StopReportsHeard })
pure val pValues = Set(defaultVoiceProfile,
  { shortGapMs: 300, longGapMs: 1200, bargeInHoldMs: 700, stopReport: StopReportsNone },
  { shortGapMs: 0, longGapMs: 0, bargeInHoldMs: 400, stopReport: StopReportsNone },
  { shortGapMs: 500, longGapMs: 100, bargeInHoldMs: 700, stopReport: StopReportsHeard })
pure def alwaysTheProfileIsWithinItsBounds(s: VoiceSession): bool = profileAdmitted(s.profile)
pure def lawTheDefaultProfileIsTheUpstreamSession(p: VoiceProfile): bool =
  p == defaultVoiceProfile implies (p.shortGapMs == shortGapMs and p.longGapMs == longGapMs and p.bargeInHoldMs == bargeInHoldMs and p.stopReport == StopReportsHeard)
pure def stepTheProfileChangesOnlyAtStart(before: VoiceSession, via: str, after: VoiceSession): bool =
  after.profile != before.profile implies via == "start"
pure def sometimesAnOpenMicSession(s: VoiceSession): bool = isRunning(s.life) and s.profile.longGapMs == 0 and s.profile.stopReport == StopReportsNone
```

### New speech advances the utterance epoch, so an answer asked for an older utterance changes nothing

Speech starts while the microphone is open and no utterance is being
heard: between turns, during a pending gap or end-of-turn query, or, full
duplex, while a reply is pending or playing (a barge-in candidate). Stop
advances the epoch too.

```quint
pure def canSpeechStarted(s: VoiceSession): bool =
  s.capture == CaptureOpen and s.utterance != Hearing and s.utterance != AwaitingFinal and
  (s.turn == NoTurn or s.turn == AwaitingReply or s.turn == Playing)
pure def speechStarted(s: VoiceSession): VoiceSession = { ...s, utterance: Hearing, epoch: s.epoch + 1, bargeIn: s.bargeIn or s.turn != NoTurn }
pure def canSpeechEnded(s: VoiceSession): bool = s.utterance == Hearing
pure def speechEnded(s: VoiceSession): VoiceSession = { ...s, utterance: AwaitingFinal }
pure def gapPending(u: Utterance): bool = u == GapWaiting or u == AskingEndOfTurn or u == WaitingLongGap
pure def alwaysAGapWaitsForTextAndNoTurn(s: VoiceSession): bool =
  s.epoch >= 0 and (gapPending(s.utterance) implies (s.turn == NoTurn and s.hasText and s.mode == ConversationMode)) and
  (s.hasText implies (s.utterance != NoUtterance and s.turn == NoTurn)) and
  (((s.utterance == Hearing or s.utterance == AwaitingFinal) and s.turn != NoTurn) implies s.bargeIn)
pure def stepTheEpochOnlyAdvances(before: VoiceSession, via: str, after: VoiceSession): bool =
  after.epoch >= before.epoch and (via == "speechStarted" implies after.epoch == before.epoch + 1)
```

### Only a complete end-of-turn score submits before the 1,200 ms long gap, which always submits

Once the final transcript is accepted, the profile's short gap (300 ms by
default) starts one query
for the utterance's text with whitespace collapsed, never audio, through
the local inference route. The scorer receives only text of 1 to 4,096
units, with no truncation. A query has a 600 ms deadline. A complete
answer before the long gap submits at once. An incomplete or unavailable
answer, a reply of another
shape, a failed request and a missed deadline wait. Silence for the
profile's long gap (1,200 ms by default), counted from the speech end, submits whatever the query said, and a
later answer is refused. A half-duplex submission starts closing the
microphone; a full-duplex one is ready to send at once.

```quint
type EndOfTurnReply = ScoredComplete | ScoredIncomplete | ScorerUnavailable | ReplyMalformed | ScoringFailed | ReplyLate
pure val shortGapMs = 300
pure val longGapMs = 1200
pure val endOfTurnDeadlineMs = 600
pure val endOfTurnMaxUnits = 4096
pure def endOfTurnSendable(units: int): bool = units >= 1 and units <= endOfTurnMaxUnits
pure def canShortGapElapsed(s: VoiceSession, epoch: int): bool = s.utterance == GapWaiting and epoch == s.epoch
pure def shortGapElapsed(s: VoiceSession, epoch: int, units: int): VoiceSession =
  { ...s, utterance: if (endOfTurnSendable(units)) AskingEndOfTurn else WaitingLongGap }
pure def canEndOfTurnAnswered(s: VoiceSession, epoch: int): bool = s.utterance == AskingEndOfTurn and epoch == s.epoch
pure def endOfTurnAnswered(s: VoiceSession, epoch: int, answer: EndOfTurnReply): VoiceSession =
  if (answer == ScoredComplete) submitted(EndOfTurnSubmit, s) else { ...s, utterance: WaitingLongGap }
pure val unitsValues = Set(0, 1, 4096, 4097)
pure val epochValues = Set(0, 1, 2, 3)
pure val weight_speechStarted = 3
pure val weight_finalTranscript = 3
pure val weight_sendTurn = 3
pure val weight_replyStarted = 3
pure val gapSession: VoiceSession = { ...initial, life: Live, capture: CaptureOpen, utterance: GapWaiting, hasText: true }
pure def lawOnlySendableTextIsScored(units: int): bool =
  (shortGapElapsed(gapSession, 0, units).utterance == AskingEndOfTurn) iff (units >= 1 and units <= 4096)
pure def lawOnlyACompleteScoreSubmitsEarly(answer: EndOfTurnReply): bool =
  (endOfTurnAnswered({ ...gapSession, utterance: AskingEndOfTurn }, 0, answer).turn != NoTurn) iff answer == ScoredComplete
pure def sometimesSubmittedByTheEndOfTurn(s: VoiceSession): bool = s.cause == EndOfTurnSubmit and s.turn == AwaitingReply
pure def submitted(cause: SubmitCause, s: VoiceSession): VoiceSession =
  { ...s, utterance: NoUtterance, hasText: false, cause: cause,
    turn: if (s.duplex == HalfDuplex) AwaitingClose else ReadyToSend,
    capture: if (s.duplex == HalfDuplex) CaptureClosing else s.capture }
pure def canLongGapElapsed(s: VoiceSession, epoch: int): bool = gapPending(s.utterance) and epoch == s.epoch
pure def longGapElapsed(s: VoiceSession, epoch: int): VoiceSession = submitted(LongGapSubmit, s)
pure def stepASubmissionNamesItsCause(before: VoiceSession, via: str, after: VoiceSession): bool =
  (before.turn == NoTurn and after.turn != NoTurn) implies
    ((via == "endOfTurnAnswered" and after.cause == EndOfTurnSubmit) or (via == "longGapElapsed" and after.cause == LongGapSubmit))
pure def sometimesSubmittedByTheLongGap(s: VoiceSession): bool = s.cause == LongGapSubmit and s.turn == AwaitingReply
```

### A turn is sent once, and a half-duplex turn only after the capture confirmed its close

The turn goes out as a `VOICE_DM` message carrying the accepted transcript
and the screen's `metadata.voiceUi` when supplied. The request is never
resent, even when a barge-in or Stop aborts it. What a barge-in takes
back before its reply started goes out again only inside the next turn
(below). A close that fails ends the session and sends nothing.

```quint
pure val voiceChannelType = "VOICE_DM"
pure def canSendTurn(s: VoiceSession): bool = s.turn == ReadyToSend
pure def sendTurn(s: VoiceSession): VoiceSession = { ...s, turn: AwaitingReply, sent: s.sent + 1, supersedes: s.rejoined, rejoined: 0 }
pure def stepATurnIsSentOnce(before: VoiceSession, via: str, after: VoiceSession): bool =
  after.sent >= before.sent and
  (after.sent != before.sent implies (via == "sendTurn" and before.turn == ReadyToSend and after.sent == before.sent + 1))
pure def sometimesAFullDuplexTurnIsSent(s: VoiceSession): bool = s.duplex == FullDuplex and s.turn == AwaitingReply and s.sent > 0
```

## Story: Send only what I meant

> As a person talking with the microphone open, I want the assistant to
> answer what I said, not its own voice, my filler words or a draft I am
> still dictating.

### Filler, sound annotations and the assistant's own echo are never a turn

A transcript with no words, or only filler ("um", "uh") or a sound
annotation, is not a turn. While the reply plays, and 1,500 ms after its
playback ended (when the transcript's start is unknown, while the reply is
at most 3,000 ms old), 2 or more words with at least 70 % in the reply are
echo; a capture that cancels the device's playback hears no echo after it
ends. A one-word answer is never echo. Whether the reply plays is the
session's own state. An accepted transcript joins the utterance.

```quint
type HeardTurn = { words: int, onlyFiller: bool, overlapPercent: int, agentSpeaking: bool,
  startKnown: bool, startedAfterReplyEndMs: int, replyAgeMs: int, echoCancelled: bool }
pure val echoOverlapPercent = 70
pure val echoTailMs = 1500
pure val echoReplyAgeMs = 3000
pure def echoWindowOpen(heard: HeardTurn): bool =
  heard.agentSpeaking or (not(heard.echoCancelled) and
    (if (heard.startKnown) heard.startedAfterReplyEndMs <= echoTailMs else heard.replyAgeMs <= echoReplyAgeMs))
pure def isEcho(heard: HeardTurn): bool =
  heard.words >= 2 and heard.overlapPercent >= echoOverlapPercent and echoWindowOpen(heard)
pure def turnAccepted(heard: HeardTurn): bool = heard.words > 0 and not(heard.onlyFiller) and not(isEcho(heard))
pure def canFinalTranscript(s: VoiceSession): bool = s.utterance == AwaitingFinal
pure def finalTranscript(s: VoiceSession, heard: HeardTurn): VoiceSession = {
  val accepted = turnAccepted({ ...heard, agentSpeaking: s.turn == Playing })
  if (s.mode == DictationMode) { ...s, utterance: NoUtterance, drafts: s.drafts + (if (accepted) 1 else 0) }
  else if (s.bargeIn and accepted) bargedIn(GapWaiting, s)
  else if (s.bargeIn) { ...s, bargeIn: false, utterance: NoUtterance }
  else if (accepted or s.hasText) { ...s, utterance: GapWaiting, hasText: true }
  else { ...s, utterance: NoUtterance }
}
pure val spoken: HeardTurn = { words: 3, onlyFiller: false, overlapPercent: 0, agentSpeaking: false,
  startKnown: true, startedAfterReplyEndMs: 5000, replyAgeMs: 9000, echoCancelled: false }
pure val heardValues = Set(spoken, { ...spoken, words: 0 }, { ...spoken, onlyFiller: true }, { ...spoken, overlapPercent: 80 },
  { ...spoken, overlapPercent: 80, startedAfterReplyEndMs: 1000 }, { ...spoken, overlapPercent: 80, startedAfterReplyEndMs: 1000, echoCancelled: true },
  { ...spoken, words: 1, overlapPercent: 100, agentSpeaking: true }, { ...spoken, overlapPercent: 80, startKnown: false, replyAgeMs: 2000 })
pure def lawFillerIsNeverATurn(heard: HeardTurn): bool = (heard.words == 0 or heard.onlyFiller) implies not(turnAccepted(heard))
pure def lawEchoOfAPlayingReplyIsDropped(heard: HeardTurn): bool =
  (heard.agentSpeaking and heard.words >= 2 and heard.overlapPercent >= 70) implies not(turnAccepted(heard))
pure def lawAOneWordAnswerIsKept(heard: HeardTurn): bool = (heard.words == 1 and not(heard.onlyFiller)) implies turnAccepted(heard)
pure def sometimesAnUtteranceWaitsForItsGap(s: VoiceSession): bool = s.utterance == GapWaiting and s.hasText
```

### Without a scorer, how an utterance ends says how likely it is finished

`scoreEndOfTurnHeuristic` reads only the end of the transcript, first
match first: nothing said is 50 %; a trailing ellipsis 20 %; a final `!`
or `?` 95 %; a closing question tag ("right?", "okay?", "yeah") 85 %. A
final full stop is often the recogniser's, so it is set aside and the last
word decides: an amount left open (a digit and a comma, a currency sign,
or a number followed by "point") is 20 %; a full stop after a word that
can end a sentence is 95 %; a dangling conjunction ("and", "because") is
15 %; a dangling filler, article, preposition or auxiliary ("um", "the",
"to", "could") is 20 %; otherwise fewer than three words are 70 % and
anything longer 50 %. Only a finished sentence or a question tag scores
85 % or more, and only an unfinished ending scores 20 % or less.

```quint
type UtteranceEnding = NothingSaid | TrailsOff | AsksOrExclaims | QuestionTag | OpenAmount | FullStop
  | DanglingConjunction | DanglingWord | ShortPhrase | PlainPhrase
pure def endOfTurnPercent(ending: UtteranceEnding): int = match ending {
  | NothingSaid => 50 | TrailsOff => 20 | AsksOrExclaims => 95 | QuestionTag => 85 | OpenAmount => 20 | FullStop => 95
  | DanglingConjunction => 15 | DanglingWord => 20 | ShortPhrase => 70 | PlainPhrase => 50 }
pure def lawOnlyAFinishedSentenceOrAQuestionTagScoresComplete(ending: UtteranceEnding): bool =
  (endOfTurnPercent(ending) >= 85) iff (ending == AsksOrExclaims or ending == QuestionTag or ending == FullStop)
pure def lawOnlyAnUnfinishedEndingScoresTwentyOrLess(ending: UtteranceEnding): bool =
  (endOfTurnPercent(ending) <= 20) iff (ending == TrailsOff or ending == OpenAmount or ending == DanglingConjunction or ending == DanglingWord)
```

### The turn signal lets the agent speak only for an accepted, addressed turn that is not its own voice, and keeps the floor with the person while the utterance is likely unfinished

`buildVoiceTurnSignal` answers `{endOfTurnProbability, nextSpeaker,
agentShouldSpeak, source}` for a transcript. Without a wake word the agent
should speak only for a turn the gate above accepts, and not for a
bystander: a speaker attributed with at least 70 % confidence who is
neither the owner nor an enrolled speaker. A wake word is an explicit
address: it overrides the gate and the bystander for anything but a sound
annotation. A voice measured as the agent's own (at least the given
threshold, 70 % by default) while the echo window is open is never
answered. The next speaker is the agent only when it should speak and the
heuristic above is at least 40 %. The source names what decided:
`client-ambient+self-voice`, then `+wakeword`, then `+diarization` when a
speaker was attributed, else `client-ambient`.

```quint
type SignalSource = AmbientSource | DiarizedSource | WakeWordSource | SelfVoiceSource
type TurnSignalInput = { heard: HeardTurn, soundOnly: bool, wakeWord: bool, attributed: bool, bystander: bool, ownVoice: bool, finishedPercent: int }
type TurnSignal = { agentShouldSpeak: bool, agentNext: bool, source: SignalSource }
pure val turnSignalFloorPercent = 40
pure def turnSignal(given: TurnSignalInput): TurnSignal = {
  val selfVoice = given.ownVoice and echoWindowOpen(given.heard)
  val addressed = if (given.wakeWord) not(given.soundOnly) else (turnAccepted(given.heard) and not(given.bystander))
  val speaks = addressed and not(selfVoice)
  { agentShouldSpeak: speaks, agentNext: speaks and given.finishedPercent >= turnSignalFloorPercent,
    source: if (selfVoice) SelfVoiceSource else if (given.wakeWord) WakeWordSource else if (given.attributed) DiarizedSource else AmbientSource }
}
pure val ambient: TurnSignalInput = { heard: spoken, soundOnly: false, wakeWord: false, attributed: false, bystander: false, ownVoice: false, finishedPercent: 95 }
pure val givenValues = Set(ambient, { ...ambient, finishedPercent: 20 }, { ...ambient, heard: { ...spoken, onlyFiller: true } },
  { ...ambient, attributed: true, bystander: true }, { ...ambient, attributed: true, bystander: true, wakeWord: true },
  { ...ambient, wakeWord: true, soundOnly: true, heard: { ...spoken, words: 0 } }, { ...ambient, ownVoice: true },
  { ...ambient, ownVoice: true, heard: { ...spoken, agentSpeaking: true } }, { ...ambient, ownVoice: true, wakeWord: true, heard: { ...spoken, agentSpeaking: true } })
pure def lawWithoutAWakeWordOnlyAnAcceptedTurnFromNoBystanderIsAnswered(given: TurnSignalInput): bool =
  (not(given.wakeWord) and turnSignal(given).agentShouldSpeak) implies (turnAccepted(given.heard) and not(given.bystander))
pure def lawTheAgentsOwnVoiceIsNeverAnswered(given: TurnSignalInput): bool =
  (given.ownVoice and echoWindowOpen(given.heard)) implies (not(turnSignal(given).agentShouldSpeak) and turnSignal(given).source == SelfVoiceSource)
pure def lawAWakeWordIsAnsweredUnlessItIsOnlyASoundOrTheAgentsOwnVoice(given: TurnSignalInput): bool =
  (given.wakeWord and not(given.soundOnly) and not(given.ownVoice)) implies turnSignal(given).agentShouldSpeak
pure def lawTheFloorStaysWithThePersonWhileTheUtteranceIsLikelyUnfinished(given: TurnSignalInput): bool =
  turnSignal(given).agentNext iff (turnSignal(given).agentShouldSpeak and given.finishedPercent >= 40)
```

### Dictation never submits by itself

Each accepted transcript becomes draft text the person reviews and sends;
no gap, query or turn starts. A voice submission is never an approval.

```quint
pure def alwaysDictationNeverSubmits(s: VoiceSession): bool =
  s.drafts >= 0 and (s.mode == DictationMode implies (s.turn == NoTurn and not(s.hasText) and not(gapPending(s.utterance))))
pure def sometimesDictationDrafts(s: VoiceSession): bool = isRunning(s.life) and s.mode == DictationMode and s.drafts > 0
```

### A barge-in is confirmed only by an accepted transcript or a 700 ms hold

In full duplex, speech while a reply is pending or playing is a candidate:
the reply keeps playing. An accepted final transcript or a hold of the
profile's length (700 ms by default)
confirms it: the reply stops, a pending turn is aborted through the turn
abort route, and the speech becomes the next utterance, which carries the
text of a turn aborted before its reply started (below). A rejected
transcript drops the candidate. Partial transcripts confirm nothing.

```quint
pure val bargeInHoldMs = 700
pure def canBargeInHeld(s: VoiceSession, heldMs: int): bool =
  s.bargeIn and (s.utterance == Hearing or s.utterance == AwaitingFinal) and heldMs >= s.profile.bargeInHoldMs
pure def bargeInHeld(s: VoiceSession, heldMs: int): VoiceSession = bargedIn(s.utterance, s)
pure val heldMsValues = Set(0, 399, 400, 699, 700)
pure def alwaysACandidateInterruptsASentTurn(s: VoiceSession): bool =
  s.bargeIn implies (s.duplex == FullDuplex and (s.turn == AwaitingReply or s.turn == Playing))
pure def sometimesABargeInCutsTheReply(s: VoiceSession): bool = s.lastEnd == ReplyCut and s.utterance != NoUtterance
pure def sometimesABargeInAbortsAPendingTurn(s: VoiceSession): bool = s.lastEnd == TurnAborted and isRunning(s.life)
```

### A turn taken back before its reply started is carried into the utterance in progress, and the next turn names the one it replaces

With the microphone open a turn goes out at the first pause. When a
barge-in is confirmed while that turn still awaits its reply, the person
was not finished: the aborted turn's text is carried into the utterance in
progress, so the next turn sends the carried text joined with what was
said since, and names the aborted turn's `clientMessageId` in
the message port's `supersedes` field. The carried text is sent even when
the resumed speech turns out to be filler. Nothing of the aborted request
is spoken. A reply that has started
playing is cut and reported instead, and its speech becomes a turn of its
own; a Stop or a failed capture carries nothing.

```quint
pure def bargedIn(utterance: Utterance, s: VoiceSession): VoiceSession = {
  val pending = s.turn == AwaitingReply
  val cut = cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s)
  { ...cut, utterance: utterance, hasText: pending or utterance == GapWaiting, rejoined: if (pending) s.sent else cut.rejoined }
}
pure def alwaysACarriedTurnIsTheLastSentAndWaitsToGoOutAgain(s: VoiceSession): bool =
  s.sent >= 0 and s.rejoined >= 0 and s.supersedes >= 0 and
  ((s.turn == AwaitingReply or s.turn == Playing) implies s.sent >= 1) and
  (s.supersedes > 0 implies s.supersedes < s.sent) and
  (s.rejoined > 0 implies (s.rejoined == s.sent and s.duplex == FullDuplex and isRunning(s.life) and (s.hasText or s.turn == ReadyToSend)))
pure def stepATurnTakenBackBeforeItsReplyIsCarried(before: VoiceSession, via: str, after: VoiceSession): bool =
  (before.turn == AwaitingReply and after.turn == NoTurn and (via == "finalTranscript" or via == "bargeInHeld"))
    implies (after.hasText and after.rejoined == before.sent and after.rejoined >= 1)
pure def stepOnlyTheNextTurnNamesTheOneItReplaces(before: VoiceSession, via: str, after: VoiceSession): bool =
  (via == "sendTurn" implies (after.supersedes == before.rejoined and after.rejoined == 0)) and
  (via != "sendTurn" implies after.supersedes == before.supersedes) and
  ((via == "stop" or via == "captureFailed") implies after.rejoined == 0)
pure def sometimesATakenBackTurnGoesOutAgain(s: VoiceSession): bool = s.supersedes >= 1 and s.turn == AwaitingReply
pure val eval_witness_sometimesATakenBackTurnGoesOutAgain = (
  ("start", ConversationMode, FullDuplex, defaultVoiceProfile), "captureOpened", "speechStarted", "speechEnded", ("finalTranscript", spoken),
  ("longGapElapsed", 1), "sendTurn", "speechStarted", ("bargeInHeld", 700), "speechEnded", ("finalTranscript", spoken),
  ("longGapElapsed", 2), "sendTurn")
```

## Story: Report what of an interrupted reply I heard

> As a person who cut the assistant short, I want its history of the reply
> to hold what I actually heard, so that it does not assume I heard the
> rest.

### A reply plays segment by segment, and a cut or broken one reserves one report

A reply with no speech segments ends the turn at once; each segment plays
once, in order. A failed turn ends it. A barge-in while the reply plays,
a Stop while it plays when the profile reports on Stop, or a segment that fails after some played, reserves exactly one
report for that reply with the text of the played segments or a
`nothingHeard` marker. A playback failure before any segment played
reserves no report and leaves the stored reply whole. The report is keyed by the reply and kept until it
settles. A half-duplex session then reopens the microphone.

```quint
pure def reserved(s: VoiceSession): List[HeardReceipt] =
  s.receipts.append({ reply: s.reply, attempts: 0, phase: ReportDue, nothingHeard: s.played == 0 })
pure def cutTurn(ending: TurnEnd, s: VoiceSession): VoiceSession =
  { ...s, turn: NoTurn, bargeIn: false, segments: 0, played: 0, lastEnd: if (s.turn == NoTurn) s.lastEnd else ending,
    receipts: if (s.turn == Playing) reserved(s) else s.receipts }
pure def canReplyStarted(s: VoiceSession): bool = s.turn == AwaitingReply
pure def replyStarted(s: VoiceSession, segments: int): VoiceSession =
  if (segments > 0) { ...s, turn: Playing, reply: s.reply + 1, segments: segments, played: 0 }
  else { ...s, turn: NoTurn, reply: s.reply + 1, bargeIn: false, lastEnd: ReplyPlayed }
pure def canSegmentPlayed(s: VoiceSession): bool = s.turn == Playing
pure def segmentPlayed(s: VoiceSession): VoiceSession =
  if (s.played + 1 < s.segments) { ...s, played: s.played + 1 }
  else { ...s, turn: NoTurn, segments: 0, played: 0, bargeIn: false, lastEnd: ReplyPlayed }
pure def canPlaybackBroke(s: VoiceSession): bool = s.turn == Playing
pure def playbackBroke(s: VoiceSession): VoiceSession =
  { ...s, turn: NoTurn, segments: 0, played: 0, bargeIn: false, lastEnd: ReplyBroke, receipts: if (s.played > 0) reserved(s) else s.receipts }
pure def canReplyFailed(s: VoiceSession): bool = s.turn == AwaitingReply
pure def replyFailed(s: VoiceSession): VoiceSession = { ...s, turn: NoTurn, bargeIn: false, lastEnd: TurnFailed }
pure val segmentsValues = Set(0, 1, 2)
pure def alwaysOneReportPerPlayedReply(s: VoiceSession): bool =
  s.reply >= 0 and (if (s.turn == Playing) (s.reply >= 1 and s.played >= 0 and s.played < s.segments) else (s.segments == 0 and s.played == 0)) and
  s.receipts.every(r => r.reply >= 1 and r.reply <= s.reply and s.receipts.select(q => q.reply == r.reply).length() == 1 and
    (s.turn == Playing implies r.reply < s.reply))
pure def sometimesAReplyPlaysWhole(s: VoiceSession): bool = s.lastEnd == ReplyPlayed and s.reply > 0
pure def sometimesABrokenReplyIsReported(s: VoiceSession): bool = s.lastEnd == ReplyBroke and s.receipts.length() > 0
pure def stepStopReportsOnlyWhenTheProfileAsks(before: VoiceSession, via: str, after: VoiceSession): bool =
  (via == "stop" and before.profile.stopReport == StopReportsNone) implies after.receipts == before.receipts
```

### A report is posted at most twice, the second 1,500 ms after a lost or missing answer, and its outcomes stay distinct

`POST /api/conversations/:id/messages/:messageId/heard` with `{heardText}`
or `{nothingHeard: true}`. A `200` naming the reply is the turn's recorded
or unchanged verdict, `409` its conflict and `404` its not-an-agent-reply;
no answer, `429` and `5xx` are unavailable; anything else, a `200` of any
other shape included, is rejected. A first `404` or unavailable is posted
once more 1,500 ms later; every other answer, and any second one, settles
the report.

```quint
type HeardBody = BodyRecorded | BodyUnchanged | BodyOther
pure val heardRetryMs = 1500
pure def reportOutcomeOf(status: int, body: HeardBody): ReportOutcome =
  if (status == 200) (match body { | BodyRecorded => ReportAnswered({ verdict: T::HeardRecorded })
    | BodyUnchanged => ReportAnswered({ verdict: T::HeardUnchanged }) | BodyOther => ReportRejected })
  else if (status == 409) ReportAnswered({ verdict: T::HeardConflict })
  else if (status == 404) ReportAnswered({ verdict: T::HeardNotAgentReply })
  else if (status == 0 or status == 429 or status >= 500) ReportUnavailable
  else ReportRejected
pure def retryable(o: ReportOutcome): bool = o == ReportUnavailable or o == ReportAnswered({ verdict: T::HeardNotAgentReply })
pure def dueToPost(r: HeardReceipt, reply: int, waitedMs: int): bool =
  r.reply == reply and r.phase == ReportDue and (r.attempts == 0 or waitedMs >= heardRetryMs)
pure def canDispatchHeard(s: VoiceSession, reply: int, waitedMs: int): bool = s.receipts.some(r => dueToPost(r, reply, waitedMs))
pure def dispatchHeard(s: VoiceSession, reply: int, waitedMs: int): VoiceSession =
  { ...s, receipts: s.receipts.listMap(r => if (dueToPost(r, reply, waitedMs)) { ...r, phase: ReportPosting, attempts: r.attempts + 1 } else r) }
pure def canHeardAnswered(s: VoiceSession, reply: int): bool = s.receipts.some(r => r.reply == reply and r.phase == ReportPosting)
pure def heardAnswered(s: VoiceSession, reply: int, status: int, body: HeardBody): VoiceSession = {
  val o = reportOutcomeOf(status, body)
  { ...s, receipts: s.receipts.listMap(r => if (r.reply == reply and r.phase == ReportPosting)
      { ...r, phase: if (retryable(o) and r.attempts == 1) ReportDue else ReportSettled({ outcome: o }) } else r) }
}
pure val replyValues = Set(1, 2)
pure val waitedMsValues = Set(1499, 1500)
pure val statusValues = Set(0, 200, 400, 404, 409, 429, 503)
pure val weight_dispatchHeard = 6
pure val weight_heardAnswered = 6
pure def alwaysAReportIsPostedAtMostTwice(s: VoiceSession): bool =
  s.receipts.every(r => r.attempts >= 0 and r.attempts <= 2 and (r.phase == ReportDue implies r.attempts <= 1) and
    (r.phase != ReportDue implies r.attempts >= 1))
pure def lawAConflictIsFinal(body: HeardBody): bool = not(retryable(reportOutcomeOf(409, body)))
pure def lawOnlyANamedReplyRecords(status: int, body: HeardBody): bool =
  reportOutcomeOf(status, body) == ReportAnswered({ verdict: T::HeardRecorded }) implies (status == 200 and body == BodyRecorded)
pure def sometimesTheSecondReportSettles(s: VoiceSession): bool =
  s.receipts.some(r => r.attempts == 2 and r.phase != ReportDue and r.phase != ReportPosting)
pure def sometimesNothingHeardIsRecorded(s: VoiceSession): bool =
  s.receipts.some(r => r.nothingHeard and r.phase == ReportSettled({ outcome: ReportAnswered({ verdict: T::HeardRecorded }) }))
```

## Story: Show which phase the voice session is in

> As a person in a voice conversation, I want to see whether the assistant
> is starting, listening, thinking or speaking, and when it stopped or
> failed.

### The shown phase is computed from the session state, never kept apart

Idle when not running, error after a failure or while a capture that
failed to close has not confirmed its release, starting until the
microphone first opened, speaking while a reply plays (a barge-in
candidate included), thinking from submission until the reply starts, and
listening otherwise.

```quint
type ShownPhase = PhaseIdle | PhaseStarting | PhaseListening | PhaseThinking | PhaseSpeaking | PhaseError
pure def shownPhase(s: VoiceSession): ShownPhase =
  if (s.capture == CaptureUnreleased or s.life == Failed) PhaseError else if (s.life == Idle) PhaseIdle else if (s.life == Starting) PhaseStarting
  else if (s.turn == Playing) PhaseSpeaking else if (s.turn == NoTurn) PhaseListening else PhaseThinking
pure def sometimesShowsThinking(s: VoiceSession): bool = shownPhase(s) == PhaseThinking
pure def sometimesShowsSpeakingThroughACandidate(s: VoiceSession): bool = shownPhase(s) == PhaseSpeaking and s.bargeIn
pure def sometimesShowsIdleAfterStop(s: VoiceSession): bool = shownPhase(s) == PhaseIdle and s.sent > 0
```
