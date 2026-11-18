# Voice session

The voice turn logic of the browser-safe voice controller, exported from
`@elizaos/agent/voice` as `VoiceSession` and, for a full-duplex session,
`createLiveVoiceSession`. One session listens to the person, decides when
an utterance is finished, sends it once as a `VOICE_DM` turn, plays the
reply and, when the person cuts the reply short, reports what of it they
heard. The audio itself (capture, WAV, playback, recorded dictation) is
[client audio](./clientAudio.md); the turn, abort and heard routes are the
conversation turns of the agent. Microphone, speech recognition, the
end-of-turn scorer, the turn transport and the heard route reach the
session through injected ports; timers are the shell's and each timer event
carries the utterance epoch it was started for.

Times are whole milliseconds, text lengths whole UTF-16 units and overlap
a whole percent. The words of a transcript arrive already counted, and
its overlap with the reply already computed (`voice/echo-filter.ts`).

## Story: Send my words once I finish speaking

> As a person talking to the assistant, I want what I say sent once I have
> finished, not while I pause mid-sentence, and never twice.

### A session owns one microphone capture and reopens it only after the turn

Start opens the capture in a mode, conversation or dictation, and a
duplex: a half-duplex session closes the microphone for each turn and
reopens it once the turn has ended; a full-duplex one keeps it open, so
that the person can cut in. A capture that opens after Stop is closed
again at once. A capture that fails to open or to close ends the session
with an error. Stop ends the session at once, retires the current
utterance and turn, and closes an open capture; a new session starts only
once the capture is closed.

```quint
type InputMode = ConversationMode | DictationMode
type Duplex = HalfDuplex | FullDuplex
type CaptureState = CaptureClosed | CaptureOpening | CaptureOpen | CaptureClosing
type Utterance = NoUtterance | Hearing | AwaitingFinal | GapWaiting | AskingEndOfTurn | WaitingLongGap
type TurnStage = NoTurn | AwaitingClose | ReadyToSend | AwaitingReply | Playing
type SubmitCause = NoSubmit | EndOfTurnSubmit | LongGapSubmit
type TurnEnd = NoEnd | ReplyPlayed | ReplyCut | TurnAborted | ReplyBroke | TurnFailed
type HeardPhase = HeardReady | HeardInFlight | HeardRetry | HeardSettled
type HeardOutcome = HeardPending | HeardRecorded | HeardUnchanged | HeardConflict | HeardMissing | HeardUnavailable | HeardRejected
type HeardReceipt = { reply: int, phase: HeardPhase, attempts: int, outcome: HeardOutcome, nothingHeard: bool }
type VoiceSession = { running: bool, ready: bool, failed: bool, mode: InputMode, duplex: Duplex, capture: CaptureState,
  utterance: Utterance, epoch: int, hasText: bool, turn: TurnStage, cause: SubmitCause, closeConfirmed: bool, sent: int,
  bargeIn: bool, reply: int, segments: int, played: int, lastEnd: TurnEnd, receipts: List[HeardReceipt], drafts: int }
pure val initial: VoiceSession = { running: false, ready: false, failed: false, mode: ConversationMode, duplex: HalfDuplex,
  capture: CaptureClosed, utterance: NoUtterance, epoch: 0, hasText: false, turn: NoTurn, cause: NoSubmit, closeConfirmed: false,
  sent: 0, bargeIn: false, reply: 0, segments: 0, played: 0, lastEnd: NoEnd, receipts: List(), drafts: 0 }
pure def halted(failed: bool, s: VoiceSession): VoiceSession = {
  val cut = cutTurn(if (s.turn == Playing) ReplyCut else if (s.turn == NoTurn) s.lastEnd else TurnAborted, s)
  { ...cut, running: false, failed: failed, utterance: NoUtterance, hasText: false, epoch: s.epoch + 1 }
}
pure def canStart(s: VoiceSession): bool = not(s.running) and s.capture == CaptureClosed
pure def start(s: VoiceSession, mode: InputMode, duplex: Duplex): VoiceSession =
  { ...s, running: true, ready: false, failed: false, mode: mode, duplex: duplex, capture: CaptureOpening, utterance: NoUtterance,
    hasText: false, turn: NoTurn, cause: NoSubmit, closeConfirmed: false, bargeIn: false, segments: 0, played: 0 }
pure def canCaptureOpened(s: VoiceSession): bool = s.capture == CaptureOpening
pure def captureOpened(s: VoiceSession, ok: bool): VoiceSession =
  if (not(s.running)) { ...s, capture: if (ok) CaptureClosing else CaptureClosed }
  else if (ok) { ...s, capture: CaptureOpen, ready: true }
  else { ...halted(true, s), capture: CaptureClosed }
pure def canCaptureClosed(s: VoiceSession): bool = s.capture == CaptureClosing
pure def captureClosed(s: VoiceSession, ok: bool): VoiceSession =
  if (not(ok)) { ...halted(s.running, s), capture: CaptureClosed }
  else { ...s, capture: CaptureClosed, closeConfirmed: s.closeConfirmed or s.turn == AwaitingClose,
    turn: if (s.turn == AwaitingClose) ReadyToSend else s.turn }
pure def canReopenCapture(s: VoiceSession): bool = s.running and s.turn == NoTurn and s.capture == CaptureClosed
pure def reopenCapture(s: VoiceSession): VoiceSession = { ...s, capture: CaptureOpening }
pure def canStop(s: VoiceSession): bool = s.running
pure def stop(s: VoiceSession): VoiceSession = { ...halted(false, s), capture: if (s.capture == CaptureOpen) CaptureClosing else s.capture }
pure def alwaysAnOpenMicrophoneBelongsToARunningSession(s: VoiceSession): bool =
  (s.capture == CaptureOpen implies s.running) and (s.failed implies not(s.running)) and
  (s.utterance != NoUtterance implies s.running) and (s.turn != NoTurn implies (s.running and s.mode == ConversationMode))
pure def alwaysTheHeldMicrophoneReopensOnlyAfterTheTurn(s: VoiceSession): bool =
  (s.duplex == HalfDuplex and s.running and (s.capture == CaptureOpen or s.capture == CaptureOpening)) implies s.turn == NoTurn
pure def sometimesAFailedCaptureEndsTheSession(s: VoiceSession): bool = s.failed and s.capture == CaptureClosed
```

### New speech starts a new utterance and retires every answer asked for the old one

Speech may start while the microphone is open and no utterance is being
heard: between turns, during a pending gap or end-of-turn query, or, in a
full-duplex session, while a reply is pending or playing (a barge-in
candidate, below). Each start advances the utterance epoch, so a gap timer
or an end-of-turn answer started for an earlier epoch is refused and
changes nothing; Stop advances it too. The utterance's text is the shell's
and grows with each accepted final transcript.

```quint
pure def canSpeechStarted(s: VoiceSession): bool =
  s.running and s.capture == CaptureOpen and
  (s.utterance == NoUtterance or s.utterance == GapWaiting or s.utterance == AskingEndOfTurn or s.utterance == WaitingLongGap) and
  (s.turn == NoTurn or s.turn == AwaitingReply or s.turn == Playing)
pure def speechStarted(s: VoiceSession): VoiceSession = { ...s, utterance: Hearing, epoch: s.epoch + 1, bargeIn: s.bargeIn or s.turn != NoTurn }
pure def canSpeechEnded(s: VoiceSession): bool = s.running and s.utterance == Hearing
pure def speechEnded(s: VoiceSession): VoiceSession = { ...s, utterance: AwaitingFinal }
pure def gapPending(u: Utterance): bool = u == GapWaiting or u == AskingEndOfTurn or u == WaitingLongGap
pure def alwaysAGapWaitsForTextAndNoTurn(s: VoiceSession): bool =
  s.epoch >= 0 and (gapPending(s.utterance) implies (s.turn == NoTurn and s.hasText and s.mode == ConversationMode))
pure def stepNewSpeechAdvancesTheEpoch(before: VoiceSession, via: str, after: VoiceSession): bool =
  (via == "speechStarted" implies after.epoch == before.epoch + 1) and after.epoch >= before.epoch
```

### The end-of-turn query scores 1 to 4,096 units and only a finished answer submits early

Once speech has ended and its final transcript is accepted, the 300 ms
short gap, counted from the speech end, starts one end-of-turn query for
the utterance: its text with whitespace collapsed, never audio, through
the local inference route. Text of no units or of more than 4,096 is not
sent, never truncated, and the utterance waits for the long gap. The query
has a 600 ms deadline, so it is answered before the 1,200 ms long gap.
Only an explicit complete score is finished and submits the utterance at
once; an incomplete score is continue; a scorer that says it is
unavailable or a reply of any other shape is unavailable; a failed
request is an error and a missed deadline a timeout. Every answer but
finished waits for the long gap.

```quint
type EndpointVerdict = DecisionFinished | DecisionContinue | DecisionUnavailable | DecisionError | DecisionTimeout
type EndOfTurnReply = ScoredComplete | ScoredIncomplete | ScorerUnavailable | ReplyMalformed | ScoringFailed | ReplyLate
pure val shortGapMs = 300
pure val longGapMs = 1200
pure val endOfTurnDeadlineMs = 600
pure val endOfTurnMaxUnits = 4096
pure def endOfTurnSendable(units: int): bool = units >= 1 and units <= endOfTurnMaxUnits
pure def endOfTurnVerdict(units: int, answer: EndOfTurnReply): EndpointVerdict =
  if (not(endOfTurnSendable(units))) DecisionUnavailable
  else match answer {
    | ScoredComplete => DecisionFinished
    | ScoredIncomplete => DecisionContinue
    | ScorerUnavailable => DecisionUnavailable
    | ReplyMalformed => DecisionUnavailable
    | ScoringFailed => DecisionError
    | ReplyLate => DecisionTimeout
  }
pure def endOfTurnInTime(answerMs: int): bool = answerMs <= endOfTurnDeadlineMs
pure def canShortGapElapsed(s: VoiceSession, epoch: int): bool = s.running and s.utterance == GapWaiting and epoch == s.epoch
pure def shortGapElapsed(s: VoiceSession, epoch: int, units: int): VoiceSession =
  { ...s, utterance: if (endOfTurnSendable(units)) AskingEndOfTurn else WaitingLongGap }
pure def canEndOfTurnAnswered(s: VoiceSession, epoch: int): bool =
  s.running and s.utterance == AskingEndOfTurn and epoch == s.epoch and (s.duplex == FullDuplex or s.capture == CaptureOpen)
pure def endOfTurnAnswered(s: VoiceSession, epoch: int, verdict: EndpointVerdict): VoiceSession =
  if (verdict == DecisionFinished) submitted(EndOfTurnSubmit, s) else { ...s, utterance: WaitingLongGap }
pure val unitsValues = Set(0, 1, 4096, 4097)
pure val answerMsValues = Set(0, 600, 601)
pure val epochValues = Set(0, 1, 2, 3)
pure val askingSession: VoiceSession = { ...initial, running: true, ready: true, capture: CaptureOpen, utterance: AskingEndOfTurn, hasText: true }
pure def lawOverlongTextIsNeverScored(units: int, answer: EndOfTurnReply): bool =
  units > endOfTurnMaxUnits implies endOfTurnVerdict(units, answer) == DecisionUnavailable
pure def lawOnlyACompleteScoreFinishes(units: int, answer: EndOfTurnReply): bool =
  endOfTurnVerdict(units, answer) == DecisionFinished implies (answer == ScoredComplete and endOfTurnSendable(units))
pure def lawOnlyAFinishedAnswerSubmitsEarly(verdict: EndpointVerdict): bool =
  (endOfTurnAnswered(askingSession, 0, verdict).turn != NoTurn) iff verdict == DecisionFinished
pure def lawTheQueryIsAnsweredBeforeTheLongGap(answerMs: int): bool =
  endOfTurnInTime(answerMs) implies shortGapMs + answerMs < longGapMs
pure def sometimesSubmittedByTheEndOfTurn(s: VoiceSession): bool = s.cause == EndOfTurnSubmit and s.turn == AwaitingReply
```

### The 1,200 ms long gap always submits

Silence for the long gap, counted from the speech end, submits the
utterance whatever the end-of-turn query said or whether it has answered;
an answer that arrives later is refused. A pause shorter than the long gap
never submits by itself. A half-duplex submission starts closing the
microphone; a full-duplex one is ready to send at once.

```quint
pure def submitted(cause: SubmitCause, s: VoiceSession): VoiceSession =
  { ...s, utterance: NoUtterance, cause: cause, closeConfirmed: false,
    turn: if (s.duplex == HalfDuplex) AwaitingClose else ReadyToSend,
    capture: if (s.duplex == HalfDuplex) CaptureClosing else s.capture }
pure def canLongGapElapsed(s: VoiceSession, epoch: int): bool =
  s.running and gapPending(s.utterance) and epoch == s.epoch and (s.duplex == FullDuplex or s.capture == CaptureOpen)
pure def longGapElapsed(s: VoiceSession, epoch: int): VoiceSession = submitted(LongGapSubmit, s)
pure def silenceSubmits(pauseMs: int): bool = pauseMs >= longGapMs
pure val pauseMsValues = Set(0, 300, 1199, 1200, 2000)
pure def lawAPauseUnderTheLongGapContinues(pauseMs: int): bool = pauseMs < longGapMs implies not(silenceSubmits(pauseMs))
pure def stepASubmissionNamesItsCause(before: VoiceSession, via: str, after: VoiceSession): bool =
  (before.turn == NoTurn and after.turn != NoTurn) implies
    ((via == "endOfTurnAnswered" and after.cause == EndOfTurnSubmit) or (via == "longGapElapsed" and after.cause == LongGapSubmit))
pure def sometimesSubmittedByTheLongGap(s: VoiceSession): bool = s.cause == LongGapSubmit and s.turn == AwaitingReply
```

### A turn is sent once, and a held session sends it only after the capture confirmed its close

A submitted turn goes out exactly once as a `VOICE_DM` message with the
screen's `metadata.voiceUi`; it is never resent, not even when a barge-in
or Stop aborts it. In a half-duplex session it is sent only after the
microphone capture confirmed its close, so the turn holds the whole
recording; a close that fails ends the session and sends nothing.

```quint
pure def canSendTurn(s: VoiceSession): bool = s.running and s.turn == ReadyToSend
pure def sendTurn(s: VoiceSession): VoiceSession = { ...s, turn: AwaitingReply, sent: s.sent + 1, hasText: false }
pure def turnSent(t: TurnStage): bool = t == AwaitingReply or t == Playing
pure def alwaysAHeldTurnWaitsForTheClose(s: VoiceSession): bool =
  s.sent >= 0 and
  (s.turn == AwaitingClose implies (s.duplex == HalfDuplex and s.capture == CaptureClosing)) and
  ((s.duplex == HalfDuplex and (s.turn == ReadyToSend or turnSent(s.turn))) implies s.closeConfirmed)
pure def stepATurnIsSentOnce(before: VoiceSession, via: str, after: VoiceSession): bool =
  after.sent != before.sent implies (via == "sendTurn" and before.turn == ReadyToSend and after.sent == before.sent + 1)
pure def sometimesAFullDuplexTurnIsSent(s: VoiceSession): bool = s.duplex == FullDuplex and s.turn == AwaitingReply and s.sent > 0
```

## Story: Send only what I meant

> As a person talking with the microphone open, I want the assistant to
> answer what I said, not its own voice, my filler words or a draft I am
> still dictating.

### Filler, sound annotations and the assistant's own echo are never a turn

A final transcript with no words, with only filler words such as "um" and
"uh", or that is only a sound annotation such as *music*, is not a turn.
While the reply plays, and for 1,500 ms after its playback ended (or, when
the transcript's start is unknown, while the reply is at most 3,000 ms
old), a transcript of 2 or more words of which at least 70 percent appear
in the reply is the assistant's own echo and is not a turn; a capture that
cancels the device's own playback hears no echo after playback ends. A
one-word answer is never echo. Whether the reply plays is the session's
own state. A rejected transcript joins nothing; an accepted one joins the
utterance, which then waits for its gaps.

```quint
type HeardTurn = { words: int, onlyFiller: bool, overlapPercent: int, agentSpeaking: bool,
  startKnown: bool, startedAfterReplyEndMs: int, replyAgeMs: int, echoCancelled: bool }
pure val echoOverlapPercent = 70
pure val echoTailMs = 1500
pure val echoReplyAgeMs = 3000
pure def echoWindowOpen(heard: HeardTurn): bool =
  heard.agentSpeaking or (not(heard.echoCancelled) and
    (if (heard.startKnown) heard.startedAfterReplyEndMs <= echoTailMs else heard.replyAgeMs <= echoReplyAgeMs))
pure def isEcho(heard: HeardTurn): bool = echoWindowOpen(heard) and heard.words >= 2 and heard.overlapPercent >= echoOverlapPercent
pure def turnAccepted(heard: HeardTurn): bool = heard.words > 0 and not(heard.onlyFiller) and not(isEcho(heard))
pure def canFinalTranscript(s: VoiceSession): bool = s.running and s.utterance == AwaitingFinal
pure def finalTranscript(s: VoiceSession, heard: HeardTurn): VoiceSession = {
  val accepted = turnAccepted({ ...heard, agentSpeaking: s.turn == Playing })
  if (s.mode == DictationMode) { ...s, utterance: NoUtterance, drafts: s.drafts + (if (accepted) 1 else 0) }
  else if (s.bargeIn and accepted) { ...cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s), utterance: GapWaiting, hasText: true }
  else if (s.bargeIn) { ...s, bargeIn: false, utterance: NoUtterance }
  else if (accepted or s.hasText) { ...s, utterance: GapWaiting, hasText: true }
  else { ...s, utterance: NoUtterance }
}
pure val spokenTurn: HeardTurn = { words: 3, onlyFiller: false, overlapPercent: 0, agentSpeaking: false,
  startKnown: true, startedAfterReplyEndMs: 5000, replyAgeMs: 9000, echoCancelled: false }
pure val heardValues = Set(spokenTurn, { ...spokenTurn, words: 0 }, { ...spokenTurn, onlyFiller: true },
  { ...spokenTurn, overlapPercent: 80 }, { ...spokenTurn, overlapPercent: 80, startedAfterReplyEndMs: 1000 },
  { ...spokenTurn, overlapPercent: 80, startedAfterReplyEndMs: 1000, echoCancelled: true },
  { ...spokenTurn, words: 1, overlapPercent: 100, agentSpeaking: true }, { ...spokenTurn, overlapPercent: 80, startKnown: false, replyAgeMs: 2000 })
pure def lawFillerIsNeverATurn(heard: HeardTurn): bool = (heard.words == 0 or heard.onlyFiller) implies not(turnAccepted(heard))
pure def lawEchoWhileTheReplyPlaysIsDropped(heard: HeardTurn): bool =
  (heard.agentSpeaking and heard.words >= 2 and heard.overlapPercent >= echoOverlapPercent) implies not(turnAccepted(heard))
pure def lawEchoInTheTailIsDropped(heard: HeardTurn): bool =
  (not(heard.echoCancelled) and heard.startKnown and heard.startedAfterReplyEndMs <= echoTailMs and heard.words >= 2 and heard.overlapPercent >= echoOverlapPercent)
    implies not(turnAccepted(heard))
pure def lawAOneWordAnswerIsKept(heard: HeardTurn): bool = (heard.words == 1 and not(heard.onlyFiller)) implies turnAccepted(heard)
pure def sometimesAnUtteranceWaitsForItsGap(s: VoiceSession): bool = s.utterance == GapWaiting and s.sent > 0
```

### Dictation never submits by itself

In dictation each accepted final transcript becomes draft text the person
reviews and sends themselves; the session starts no gap, no end-of-turn
query and no turn. An automatic voice submission is never an approval.

```quint
pure def alwaysDictationNeverSubmits(s: VoiceSession): bool =
  s.drafts >= 0 and (s.mode == DictationMode implies (s.turn == NoTurn and not(s.hasText) and not(gapPending(s.utterance))))
pure def sometimesDictationDrafts(s: VoiceSession): bool = s.running and s.mode == DictationMode and s.drafts > 0
```

### Barge-in is confirmed by an accepted transcript or a 700 ms hold

In a full-duplex session, speech while a reply is pending or playing is
only a candidate: the reply keeps playing and the phase keeps showing.
The candidate is confirmed when its final transcript passes the gate
above, or when the speech has been held for 700 ms; a rejected transcript
(noise, filler, echo) drops the candidate and leaves the reply running. A
confirmed barge-in stops the reply at once, aborts a pending turn through
the turn abort route, and the new speech becomes the next utterance.
Partial transcripts never confirm one, so a sound annotation that is still
arriving cuts nothing.

```quint
pure val bargeInHoldMs = 700
pure def bargeInHoldConfirms(heldMs: int): bool = heldMs >= bargeInHoldMs
pure def canBargeInHeld(s: VoiceSession, heldMs: int): bool =
  s.running and s.bargeIn and (s.utterance == Hearing or s.utterance == AwaitingFinal) and bargeInHoldConfirms(heldMs)
pure def bargeInHeld(s: VoiceSession, heldMs: int): VoiceSession = cutTurn(if (s.turn == Playing) ReplyCut else TurnAborted, s)
pure val heldMsValues = Set(0, 699, 700, 1500)
pure def alwaysACandidateNeedsAReply(s: VoiceSession): bool =
  s.bargeIn implies (s.duplex == FullDuplex and turnSent(s.turn))
pure def lawAShortHoldConfirmsNothing(heldMs: int): bool = heldMs < bargeInHoldMs implies not(bargeInHoldConfirms(heldMs))
pure def sometimesABargeInCutsTheReply(s: VoiceSession): bool = s.duplex == FullDuplex and s.lastEnd == ReplyCut and s.utterance != NoUtterance
pure def sometimesABargeInAbortsAPendingTurn(s: VoiceSession): bool = s.duplex == FullDuplex and s.lastEnd == TurnAborted and s.running
```

## Story: Report what of an interrupted reply I heard

> As a person who cut the assistant short, I want its history of the reply
> to hold what I actually heard, so that it does not assume I heard the
> rest.

### A reply is heard segment by segment in order

A sent turn's reply arrives with its speech segments; one with none ends
the turn at once. Segments are heard in order, each counted once when it
has played, and the reply has played when the last one has. A turn that
fails, or a segment that fails to play, ends the turn and keeps the stored
reply whole. When a turn ends, a half-duplex session reopens the
microphone.

```quint
pure def canReplyStarted(s: VoiceSession): bool = s.running and s.turn == AwaitingReply
pure def replyStarted(s: VoiceSession, segments: int): VoiceSession =
  if (segments > 0) { ...s, turn: Playing, reply: s.reply + 1, segments: segments, played: 0 }
  else { ...s, turn: NoTurn, reply: s.reply + 1, bargeIn: false, lastEnd: ReplyPlayed }
pure def canSegmentPlayed(s: VoiceSession): bool = s.running and s.turn == Playing and s.played < s.segments
pure def segmentPlayed(s: VoiceSession): VoiceSession =
  if (s.played + 1 < s.segments) { ...s, played: s.played + 1 }
  else { ...s, turn: NoTurn, segments: 0, played: 0, bargeIn: false, lastEnd: ReplyPlayed }
pure def canPlaybackBroke(s: VoiceSession): bool = s.running and s.turn == Playing
pure def playbackBroke(s: VoiceSession): VoiceSession = { ...s, turn: NoTurn, segments: 0, played: 0, bargeIn: false, lastEnd: ReplyBroke }
pure def canReplyFailed(s: VoiceSession): bool = s.running and s.turn == AwaitingReply
pure def replyFailed(s: VoiceSession): VoiceSession = { ...s, turn: NoTurn, bargeIn: false, lastEnd: TurnFailed }
pure val segmentsValues = Set(0, 1, 2)
pure def alwaysOnlyAPlayingReplyHasSegments(s: VoiceSession): bool =
  s.reply >= 0 and
  (if (s.turn == Playing) (s.reply >= 1 and s.played >= 0 and s.played < s.segments) else (s.segments == 0 and s.played == 0))
pure def sometimesAReplyPlaysWhole(s: VoiceSession): bool = s.lastEnd == ReplyPlayed and s.reply > 0 and s.running
```

### Cutting a playing reply short reserves one report for it

A confirmed barge-in or Stop while a reply plays cuts it with part of it
unheard, and reserves exactly one heard report for that reply: the text of
the segments that played, or nothing heard when none had. The report is
keyed by the reply and kept until it settles, so a later reply never
replaces it. A reply that played whole, failed to play or was never
started reports nothing.

```quint
pure def cutTurn(ending: TurnEnd, s: VoiceSession): VoiceSession =
  { ...s, turn: NoTurn, bargeIn: false, segments: 0, played: 0,
    lastEnd: if (s.turn == NoTurn) s.lastEnd else ending,
    receipts: if (s.turn == Playing) s.receipts.append({ reply: s.reply, phase: HeardReady, attempts: 0, outcome: HeardPending, nothingHeard: s.played == 0 }) else s.receipts }
pure def alwaysOneReportPerReply(s: VoiceSession): bool =
  s.receipts.every(r => r.reply >= 1 and r.reply <= s.reply and s.receipts.select(q => q.reply == r.reply).length() == 1) and
  (s.turn == Playing implies s.receipts.every(r => r.reply < s.reply))
pure def sometimesNothingHeardIsReported(s: VoiceSession): bool = s.receipts.some(r => r.nothingHeard and r.phase == HeardSettled)
```

### A report is posted at most twice, the second 1,500 ms after a lost or busy answer, and its outcomes stay distinct

The report is `POST /api/conversations/:id/messages/:messageId/heard` with
`{heardText}` or `{nothingHeard: true}`. A `200` answer for the same reply
is recorded or unchanged; `409` is a conflict (the text is not a prefix of
the reply) and final; `404` is missing; no answer, `429` and any `5xx` are
unavailable; anything else, a `200` of any other shape included, is
rejected. A missing or unavailable first answer is posted once more,
1,500 ms later; every other answer, and any second one, settles the report
for good. Recorded, unchanged, conflict, missing, unavailable and rejected
stay distinct.

```quint
type HeardResult = ResultRecorded | ResultUnchanged | ResultOther
type HeardWire = WireRecorded | WireUnchanged | WireConflict | WireMissing | WireTransient | WireRejected
pure val heardRetryMs = 1500
pure def heardWireOf(status: int, result: HeardResult): HeardWire =
  if (status == 200) (match result { | ResultRecorded => WireRecorded | ResultUnchanged => WireUnchanged | ResultOther => WireRejected })
  else if (status == 409) WireConflict
  else if (status == 404) WireMissing
  else if (status == 0 or status == 429 or status >= 500) WireTransient
  else WireRejected
pure def heardRetryable(wire: HeardWire): bool = wire == WireMissing or wire == WireTransient
pure def heardOutcomeOf(wire: HeardWire): HeardOutcome = match wire {
  | WireRecorded => HeardRecorded | WireUnchanged => HeardUnchanged | WireConflict => HeardConflict
  | WireMissing => HeardMissing | WireTransient => HeardUnavailable | WireRejected => HeardRejected }
pure def settleHeard(r: HeardReceipt, wire: HeardWire): HeardReceipt =
  if (heardRetryable(wire) and r.attempts == 1) { ...r, phase: HeardRetry } else { ...r, phase: HeardSettled, outcome: heardOutcomeOf(wire) }
pure def dueToPost(r: HeardReceipt, reply: int, waitedMs: int): bool =
  r.reply == reply and (r.phase == HeardReady or (r.phase == HeardRetry and waitedMs >= heardRetryMs))
pure def canDispatchHeard(s: VoiceSession, reply: int, waitedMs: int): bool = s.receipts.some(r => dueToPost(r, reply, waitedMs))
pure def dispatchHeard(s: VoiceSession, reply: int, waitedMs: int): VoiceSession =
  { ...s, receipts: s.receipts.listMap(r => if (dueToPost(r, reply, waitedMs)) { ...r, phase: HeardInFlight, attempts: r.attempts + 1 } else r) }
pure def canHeardAnswered(s: VoiceSession, reply: int): bool = s.receipts.some(r => r.reply == reply and r.phase == HeardInFlight)
pure def heardAnswered(s: VoiceSession, reply: int, wire: HeardWire): VoiceSession =
  { ...s, receipts: s.receipts.listMap(r => if (r.reply == reply and r.phase == HeardInFlight) settleHeard(r, wire) else r) }
pure val replyValues = Set(1, 2)
pure val waitedMsValues = Set(0, 1499, 1500)
pure val statusValues = Set(0, 200, 400, 404, 409, 429, 500, 503)
pure def alwaysAReportIsPostedAtMostTwice(s: VoiceSession): bool =
  s.receipts.every(r => r.attempts >= 0 and r.attempts <= 2 and
    (r.phase == HeardReady implies r.attempts == 0) and (r.phase == HeardRetry implies r.attempts == 1) and
    (r.phase == HeardInFlight implies r.attempts > 0) and (r.phase == HeardSettled implies r.attempts > 0) and
    ((r.phase == HeardSettled) iff (r.outcome != HeardPending)))
pure def lawAConflictIsFinal(status: int, result: HeardResult): bool =
  status == 409 implies not(heardRetryable(heardWireOf(status, result)))
pure def lawOnlyTheSameReplyRecords(status: int, result: HeardResult): bool =
  heardWireOf(status, result) == WireRecorded implies (status == 200 and result == ResultRecorded)
pure def sometimesTheSecondReportSettles(s: VoiceSession): bool = s.receipts.some(r => r.phase == HeardSettled and r.attempts == 2)
pure def sometimesAReportIsRecorded(s: VoiceSession): bool = s.receipts.some(r => r.outcome == HeardRecorded and not(r.nothingHeard))
```

## Story: Show which phase the voice session is in

> As a person in a voice conversation, I want to see whether the assistant
> is starting, listening, thinking or speaking, and when it stopped or
> failed.

### The shown phase follows the session state

The phase is never kept apart from the session: idle when it is not
running, error when it ended by a failure, starting until the microphone
first opened, speaking while a reply plays (a barge-in candidate
included), thinking from submission until the reply starts, and listening
otherwise. Voice turns go on the `VOICE_DM` channel.

```quint
type ShownPhase = PhaseIdle | PhaseStarting | PhaseListening | PhaseThinking | PhaseSpeaking | PhaseError
pure val voiceChannelType = "VOICE_DM"
pure def shownPhase(s: VoiceSession): ShownPhase =
  if (not(s.running)) (if (s.failed) PhaseError else PhaseIdle)
  else if (not(s.ready)) PhaseStarting
  else if (s.turn == Playing) PhaseSpeaking
  else if (s.turn == NoTurn) PhaseListening
  else PhaseThinking
pure def sometimesShowsStarting(s: VoiceSession): bool = shownPhase(s) == PhaseStarting
pure def sometimesShowsListening(s: VoiceSession): bool = shownPhase(s) == PhaseListening and s.utterance == Hearing
pure def sometimesShowsThinking(s: VoiceSession): bool = shownPhase(s) == PhaseThinking
pure def sometimesShowsSpeaking(s: VoiceSession): bool = shownPhase(s) == PhaseSpeaking and s.played > 0
pure def sometimesShowsSpeakingThroughACandidate(s: VoiceSession): bool = shownPhase(s) == PhaseSpeaking and s.bargeIn
pure def sometimesShowsIdleAfterStop(s: VoiceSession): bool = shownPhase(s) == PhaseIdle and s.sent > 0
pure def sometimesShowsError(s: VoiceSession): bool = shownPhase(s) == PhaseError
```
