# Voice session

The voice turn logic of the browser-safe voice controller, exported from
`@elizaos/agent/voice` as `VoiceSession` and, for a full-duplex session,
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
capture that fails to open or close ends the session with an error. Stop
ends the session, retires the utterance and the turn, and closes an open
capture; a new session starts only once the capture is closed.

```quint
import turns as T from "../conversation/turns"
type InputMode = ConversationMode | DictationMode
type Duplex = HalfDuplex | FullDuplex
type SessionLife = Idle | Starting | Live | Failed
type CaptureState = CaptureClosed | CaptureOpening | CaptureOpen | CaptureClosing
type Utterance = NoUtterance | Hearing | AwaitingFinal | GapWaiting | AskingEndOfTurn | WaitingLongGap
type TurnStage = NoTurn | AwaitingClose | ReadyToSend | AwaitingReply | Playing
type SubmitCause = NoSubmit | EndOfTurnSubmit | LongGapSubmit
type TurnEnd = NoEnd | ReplyPlayed | ReplyCut | TurnAborted | ReplyBroke | TurnFailed
type ReportOutcome = ReportAnswered({ verdict: T::HeardVerdict }) | ReportUnavailable | ReportRejected
type ReportPhase = ReportDue | ReportPosting | ReportSettled({ outcome: ReportOutcome })
type HeardReceipt = { reply: int, attempts: int, phase: ReportPhase, nothingHeard: bool }
type VoiceSession = { life: SessionLife, mode: InputMode, duplex: Duplex, capture: CaptureState, utterance: Utterance,
  epoch: int, hasText: bool, turn: TurnStage, cause: SubmitCause, sent: int, bargeIn: bool, reply: int,
  segments: int, played: int, lastEnd: TurnEnd, receipts: List[HeardReceipt], drafts: int }
pure val initial: VoiceSession = { life: Idle, mode: ConversationMode, duplex: HalfDuplex, capture: CaptureClosed,
  utterance: NoUtterance, epoch: 0, hasText: false, turn: NoTurn, cause: NoSubmit, sent: 0, bargeIn: false, reply: 0,
  segments: 0, played: 0, lastEnd: NoEnd, receipts: List(), drafts: 0 }
pure def isRunning(life: SessionLife): bool = life == Starting or life == Live
pure def halted(life: SessionLife, s: VoiceSession): VoiceSession =
  { ...cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s), life: life, utterance: NoUtterance, hasText: false, epoch: s.epoch + 1 }
pure def canStart(s: VoiceSession): bool = not(isRunning(s.life)) and s.capture == CaptureClosed
pure def start(s: VoiceSession, mode: InputMode, duplex: Duplex): VoiceSession =
  { ...s, life: Starting, mode: mode, duplex: duplex, capture: CaptureOpening, cause: NoSubmit }
pure def canCaptureOpened(s: VoiceSession): bool = s.capture == CaptureOpening
pure def captureOpened(s: VoiceSession): VoiceSession =
  if (isRunning(s.life)) { ...s, capture: CaptureOpen, life: Live } else { ...s, capture: CaptureClosing }
pure def canCaptureClosed(s: VoiceSession): bool = s.capture == CaptureClosing
pure def captureClosed(s: VoiceSession): VoiceSession = { ...s, capture: CaptureClosed, turn: if (s.turn == AwaitingClose) ReadyToSend else s.turn }
pure def canCaptureFailed(s: VoiceSession): bool = s.capture == CaptureOpening or s.capture == CaptureClosing
pure def captureFailed(s: VoiceSession): VoiceSession = { ...halted(if (isRunning(s.life)) Failed else s.life, s), capture: CaptureClosed }
pure def canReopenCapture(s: VoiceSession): bool = isRunning(s.life) and s.turn == NoTurn and s.capture == CaptureClosed
pure def reopenCapture(s: VoiceSession): VoiceSession = { ...s, capture: CaptureOpening }
pure def canStop(s: VoiceSession): bool = isRunning(s.life)
pure def stop(s: VoiceSession): VoiceSession = { ...halted(Idle, s), capture: if (s.capture == CaptureOpen) CaptureClosing else s.capture }
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

Once the final transcript is accepted, a 300 ms short gap starts one query
for the utterance's text with whitespace collapsed, never audio, through
the local inference route; text of no units or over 4,096 is not sent,
never truncated. The query's 600 ms deadline ends before the long gap.
Complete submits at once; incomplete, unavailable, a reply of another
shape, a failed request and a missed deadline wait. Silence for the long
gap, counted from the speech end, submits whatever the query said, and a
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

The turn goes out as a `VOICE_DM` message with the screen's
`metadata.voiceUi`, so it holds the whole recording; it is never resent,
not even when a barge-in or Stop aborts it. A close that fails ends the
session and sends nothing.

```quint
pure val voiceChannelType = "VOICE_DM"
pure def canSendTurn(s: VoiceSession): bool = s.turn == ReadyToSend
pure def sendTurn(s: VoiceSession): VoiceSession = { ...s, turn: AwaitingReply, sent: s.sent + 1 }
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
  else if (s.bargeIn and accepted) { ...cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s), utterance: GapWaiting, hasText: true }
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
the reply keeps playing. An accepted final transcript or a 700 ms hold
confirms it: the reply stops, a pending turn is aborted through the turn
abort route, and the speech becomes the next utterance. A rejected
transcript drops the candidate. Partial transcripts confirm nothing.

```quint
pure val bargeInHoldMs = 700
pure def canBargeInHeld(s: VoiceSession, heldMs: int): bool =
  s.bargeIn and (s.utterance == Hearing or s.utterance == AwaitingFinal) and heldMs >= bargeInHoldMs
pure def bargeInHeld(s: VoiceSession, heldMs: int): VoiceSession = cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s)
pure val heldMsValues = Set(0, 699, 700)
pure def alwaysACandidateInterruptsASentTurn(s: VoiceSession): bool =
  s.bargeIn implies (s.duplex == FullDuplex and (s.turn == AwaitingReply or s.turn == Playing))
pure def sometimesABargeInCutsTheReply(s: VoiceSession): bool = s.lastEnd == ReplyCut and s.utterance != NoUtterance
pure def sometimesABargeInAbortsAPendingTurn(s: VoiceSession): bool = s.lastEnd == TurnAborted and isRunning(s.life)
```

## Story: Report what of an interrupted reply I heard

> As a person who cut the assistant short, I want its history of the reply
> to hold what I actually heard, so that it does not assume I heard the
> rest.

### A reply plays segment by segment, and a cut or broken one reserves one report

A reply with no speech segments ends the turn at once; each segment plays
once, in order. A failed turn ends it. A barge-in or Stop while the reply
plays, or a segment that fails after some played, reserves exactly one
report for that reply: the text of the played segments, or nothing heard
when none had (a failure before any played reports nothing and keeps the
stored reply whole). The report is keyed by the reply and kept until it
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

Idle when not running, error after a failure, starting until the
microphone first opened, speaking while a reply plays (a barge-in
candidate included), thinking from submission until the reply starts, and
listening otherwise.

```quint
type ShownPhase = PhaseIdle | PhaseStarting | PhaseListening | PhaseThinking | PhaseSpeaking | PhaseError
pure def shownPhase(s: VoiceSession): ShownPhase =
  if (s.life == Idle) PhaseIdle else if (s.life == Failed) PhaseError else if (s.life == Starting) PhaseStarting
  else if (s.turn == Playing) PhaseSpeaking else if (s.turn == NoTurn) PhaseListening else PhaseThinking
pure def sometimesShowsThinking(s: VoiceSession): bool = shownPhase(s) == PhaseThinking
pure def sometimesShowsSpeakingThroughACandidate(s: VoiceSession): bool = shownPhase(s) == PhaseSpeaking and s.bargeIn
pure def sometimesShowsIdleAfterStop(s: VoiceSession): bool = shownPhase(s) == PhaseIdle and s.sent > 0
```
