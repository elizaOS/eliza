# Voice endpoint decisions and interruption receipts

The voice endpoint decides when a spoken utterance is sent. The
[speech stream](./speechStream.md) owns the native cancellation signal,
[audio playback](./playback.md) the sentences the person heard, and
[heard receipts](./heardReceipts.md) amend an interrupted reply's history.

## Story: Submit one utterance after the person finishes speaking

> As a person speaking to the assistant, I want my words sent once I have
> finished, not while I pause mid-sentence.

### One live utterance owns the short-gap answer and the long-gap fallback

After VAD speech-end and final transcript, the short gap may start a
single endpoint query. Resident finished or continue settles its query.
A resident rejection is unavailable when Cloud is configured and an
error otherwise. An optional cloud endpoint stage needs both its host
enable switch and an authenticated client. Its gate may refuse this turn. It
sends text without audio at a maximum of 2,000 UTF-16 units, with a
default 300 ms stage deadline distinct from the overall endpoint
deadline. It checks the full selected context and returns an explicit
unavailable result when a bounded provider cannot accept it. The session then uses its long gap.
The provider result must have the exact turn kind and a boolean complete
value. If supplied, the probability must be finite, within zero and
one and consistent with the 0.5 threshold. Encoding and provider payload
validation are port refinements.

A scored finished submits before the long gap. Continue, unavailable,
timeout and error wait for the long gap. The long gap can win while
the endpoint is outstanding. Resumed speech retires the observed
utterance's query and aborts its signal. The model projects one utterance
generation, with deadline events admitted by its timer owner.

```quint
type EndpointVerdict = DecisionFinished | DecisionContinue | DecisionUnavailable | DecisionError | DecisionTimeout
type UtterancePhase = UtterancePending | WaitingLocalEndpoint | CloudCandidate | WaitingCloudEndpoint | WaitingLongGap | UtteranceSubmitted | UtteranceRetired
type SubmitCause = NoVoiceSubmit | SemanticVoiceSubmit | GapVoiceSubmit
type EndpointTurn = { phase: UtterancePhase, cause: SubmitCause, cloudAsked: bool, semantic: EndpointVerdict }
pure val initial: EndpointTurn = { phase: UtterancePending, cause: NoVoiceSubmit, cloudAsked: false, semantic: DecisionUnavailable }
pure def canAskEndpoint(t: EndpointTurn): bool = t.phase == UtterancePending
pure def askEndpoint(t: EndpointTurn, localAvailable: bool, cloudConfigured: bool): EndpointTurn =
  { ...t, phase: if (localAvailable) WaitingLocalEndpoint else if (cloudConfigured) CloudCandidate else WaitingLongGap }
pure def canReadLocalEndpoint(t: EndpointTurn): bool = t.phase == WaitingLocalEndpoint
pure def readLocalEndpoint(t: EndpointTurn, localVerdict: EndpointVerdict, cloudConfigured: bool): EndpointTurn =
  if (localVerdict == DecisionFinished) { ...t, phase: UtteranceSubmitted, cause: SemanticVoiceSubmit, semantic: localVerdict }
  else { ...t, phase: if ((localVerdict == DecisionUnavailable or localVerdict == DecisionError) and cloudConfigured) CloudCandidate else WaitingLongGap, semantic: localVerdict }
pure def canAskCloudEndpoint(t: EndpointTurn): bool = t.phase == CloudCandidate
pure def askCloudEndpoint(t: EndpointTurn, portAdmitted: bool, transcriptUnits: int, completeContextFits: bool): EndpointTurn =
  if (portAdmitted and transcriptUnits > 0 and transcriptUnits <= 2000 and completeContextFits)
    { ...t, phase: WaitingCloudEndpoint, cloudAsked: true }
  else { ...t, phase: WaitingLongGap, semantic: DecisionUnavailable }
pure def canReadCloudEndpoint(t: EndpointTurn): bool = t.phase == WaitingCloudEndpoint
pure def readCloudEndpoint(t: EndpointTurn, cloudVerdict: EndpointVerdict): EndpointTurn =
  if (cloudVerdict == DecisionFinished) { ...t, phase: UtteranceSubmitted, cause: SemanticVoiceSubmit, semantic: cloudVerdict }
  else { ...t, phase: WaitingLongGap, semantic: cloudVerdict }
pure def canLongGapSubmit(t: EndpointTurn): bool = t.phase != UtteranceSubmitted and t.phase != UtteranceRetired
pure def longGapSubmit(t: EndpointTurn): EndpointTurn =
  { ...t, phase: UtteranceSubmitted, cause: GapVoiceSubmit, semantic: if (t.phase == WaitingLocalEndpoint or t.phase == WaitingCloudEndpoint) DecisionTimeout else t.semantic }
pure def canResumeSpeech(t: EndpointTurn): bool = canLongGapSubmit(t)
pure def resumeSpeech(t: EndpointTurn): EndpointTurn = { ...t, phase: UtteranceRetired }
pure val transcriptUnitsValues = Set(0, 1, 2000, 2001)
pure def alwaysSubmissionHasCause(t: EndpointTurn): bool = (t.phase == UtteranceSubmitted) == (t.cause != NoVoiceSubmit)
pure def alwaysSemanticSubmitFinished(t: EndpointTurn): bool = t.cause == SemanticVoiceSubmit implies t.semantic == DecisionFinished
pure def stepFinalUtteranceCannotSendAgain(before: EndpointTurn, after: EndpointTurn): bool =
  (before.phase == UtteranceSubmitted or before.phase == UtteranceRetired) implies before == after
pure def sometimesSemanticAfterCloud(t: EndpointTurn): bool = t.cause == SemanticVoiceSubmit and t.cloudAsked
pure def sometimesTimeoutUsesGap(t: EndpointTurn): bool = t.cause == GapVoiceSubmit and t.semantic == DecisionTimeout
pure def sometimesSpeechRetired(t: EndpointTurn): bool = t.phase == UtteranceRetired
```

### The resident's end-of-turn route scores text only, at most 4,096 characters

The local endpoint is `POST /api/asr/local-inference/end-of-turn` on the
resident ([on-device speech](./localSpeech.md)). Its body is the
utterance's transcript with whitespace collapsed, never audio; the route
never starts voice or loads a model. An empty transcript is not sent, and
one longer than 4,096 characters is never sent either, since the route
refuses it with 400 rather than truncating it; both read as unavailable.
A reply that the scorer is unavailable, with a reason from its closed set,
or a reply of any other shape is unavailable. Only an explicit available
score with a boolean complete value can finish or continue the utterance,
and a scoring failure (502) or a lost request is an error.

```quint
type EndOfTurnReply = ScoredComplete | ScoredIncomplete | ScorerUnavailable | ReplyMalformed | ScoringFailed
pure def endOfTurnSendable(transcriptChars: int): bool = transcriptChars >= 1 and transcriptChars <= 4096
pure def endOfTurnVerdict(transcriptChars: int, reply: EndOfTurnReply): EndpointVerdict =
  if (not(endOfTurnSendable(transcriptChars))) DecisionUnavailable
  else if (reply == ScoredComplete) DecisionFinished
  else if (reply == ScoredIncomplete) DecisionContinue
  else if (reply == ScoringFailed) DecisionError
  else DecisionUnavailable
pure val transcriptCharsValues = Set(0, 1, 4096, 4097)
pure def lawOverlongTranscriptNeverScored(transcriptChars: int, reply: EndOfTurnReply): bool =
  transcriptChars > 4096 implies endOfTurnVerdict(transcriptChars, reply) == DecisionUnavailable
pure def lawOnlyACompleteScoreFinishes(transcriptChars: int, reply: EndOfTurnReply): bool =
  endOfTurnVerdict(transcriptChars, reply) == DecisionFinished implies reply == ScoredComplete and endOfTurnSendable(transcriptChars)
```

### A pause shorter than the long gap never ends the utterance by itself

The host configures both gaps as engineering settings, with no setting
shown to the person: by default a 300 ms short gap and a 1,200 ms long
gap, both measured from the speech end, and a long gap never shorter than
the short one. Silence ends an utterance only once it lasts the long gap;
a scored finished from the endpoint can end it sooner. A host that must
keep a two-second pause inside an utterance sets a long gap above two
seconds.

```quint
type GapTiming = { shortGapMs: int, longGapMs: int }
pure val defaultGapTiming: GapTiming = { shortGapMs: 300, longGapMs: 1200 }
pure def gapTimingValid(timing: GapTiming): bool = timing.shortGapMs >= 0 and timing.longGapMs >= timing.shortGapMs
pure def silenceSubmits(timing: GapTiming, pauseMs: int): bool = gapTimingValid(timing) and pauseMs >= timing.longGapMs
pure val timingValues = Set(defaultGapTiming, { shortGapMs: 300, longGapMs: 2500 }, { shortGapMs: 900, longGapMs: 600 })
pure val pauseMsValues = Set(0, 300, 1199, 1200, 2000, 2500)
pure def lawPauseUnderLongGapContinues(timing: GapTiming, pauseMs: int): bool =
  pauseMs < timing.longGapMs implies not(silenceSubmits(timing, pauseMs))
pure def lawTwoSecondPauseKeptUnderLongerGap(timing: GapTiming): bool =
  timing.longGapMs > 2000 implies not(silenceSubmits(timing, 2000))
```

### A submission's diagnostics carry only enums and numbers

Each submission reports which path took it and the last semantic outcome
of the utterance, and whether the cloud stage was asked. The report holds
no transcript or reply text.

```quint
type TurnDiagnostic = { cause: SubmitCause, outcome: EndpointVerdict, cloudStageAsked: bool }
pure def turnDiagnostic(t: EndpointTurn): TurnDiagnostic = { cause: t.cause, outcome: t.semantic, cloudStageAsked: t.cloudAsked }
pure val endpointTurnValues = Set(initial, { ...initial, phase: UtteranceSubmitted, cause: GapVoiceSubmit, semantic: DecisionTimeout })
pure def lawDiagnosticNamesTheSubmittingPath(endpointTurn: EndpointTurn): bool =
  turnDiagnostic(endpointTurn).cause == endpointTurn.cause and turnDiagnostic(endpointTurn).outcome == endpointTurn.semantic
```
