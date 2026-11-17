# Realtime voice client state

The interface projects a realtime voice session for a consumer's renderer;
the decoder and socket owner establish the current session authority.
[Playback](./playback.md) owns the audible queue and its drain, the
interface's reducer owns turn presentation and ephemeral progress, and
[the voice session](../../agent/actions/voiceApproval.md) keeps approvals off the voice channel.

## Story: Show the current voice turn without reopening the microphone early

> As a person in a voice conversation, I want to see whether the assistant
> is listening, thinking or speaking, and the microphone to reopen only
> once it has finished.

### The shown phase follows the current turn, and only authoritative speaking end releases speaking

Connecting is a client action. A valid server ready event establishes
the session. Starting capture moves ready or complete to listening.
Interim words are transcribing; eager end-of-turn only updates trace
identity. A nonempty final commits the turn and shows thinking, unless
speech is already playing. An empty or whitespace-only final completes
the turn without a model request. First model text preserves speaking.
Progress or activity must match the current unretired trace while
thinking or speaking. A local interruption clears progress immediately
and blocks later progress for that trace. A matching terminal or usage
event clears progress without releasing audible speaking. Authoritative
speaking end and interruption settle playback presentation; the shell
can loop to listening after its local queue drains. Reply reconciliation,
navigation and overlap telemetry are separate effects.

```quint
type VoicePhase = VoiceIdle | VoiceConnecting | VoiceReady | VoiceListening | VoiceTranscribing | VoiceThinking | VoiceSpeaking | VoiceInterrupted | VoiceComplete
type ServerSignal = SignalReady | SignalPartial | SignalEagerEnd | SignalFinal | SignalFirstText | SignalStartsAudio | SignalEndsAudio | SignalInterrupted | SignalReplyComplete | SignalTerminal | SignalUsage | SignalProgress | SignalError | SignalTelemetry
type VoiceView = { phase: VoicePhase, sessionKnown: bool, trace: int, suppressedTrace: int, hasInterim: bool, hasFinal: bool, hasProgress: bool, hasError: bool }
pure val initial: VoiceView = { phase: VoiceIdle, sessionKnown: false, trace: 0, suppressedTrace: 0, hasInterim: false, hasFinal: false, hasProgress: false, hasError: false }
pure def canConnectVoice(v: VoiceView): bool = v.phase == VoiceIdle
pure def connectVoice(v: VoiceView): VoiceView = { ...v, phase: VoiceConnecting, hasError: false }
pure def canStartListening(v: VoiceView, queueDrained: bool): bool = queueDrained and (v.phase == VoiceReady or v.phase == VoiceComplete or v.phase == VoiceInterrupted)
pure def startListening(v: VoiceView, queueDrained: bool): VoiceView = { ...v, phase: VoiceListening, hasProgress: false }
pure def bargeInVoice(v: VoiceView): VoiceView = { ...v, phase: if (v.phase == VoiceSpeaking) VoiceListening else v.phase, hasProgress: false, suppressedTrace: v.trace }
pure def resetVoice(v: VoiceView): VoiceView = initial
pure def modelTextPhase(v: VoiceView): VoicePhase = if (v.phase == VoiceSpeaking) VoiceSpeaking else VoiceThinking
pure def canApplyVoiceSignal(v: VoiceView, signalTrace: int, fromCurrentSocket: bool): bool = fromCurrentSocket and signalTrace > 0 and v.phase != VoiceIdle
pure def applyVoiceSignal(v: VoiceView, signalTrace: int, fromCurrentSocket: bool, signal: ServerSignal, textPresent: bool): VoiceView =
  if (signal == SignalReady) { ...v, phase: VoiceReady, sessionKnown: true, trace: signalTrace, hasProgress: false, hasError: false }
  else if (signal == SignalPartial) { ...v, phase: VoiceTranscribing, trace: signalTrace, hasInterim: textPresent, hasProgress: false }
  else if (signal == SignalFinal and not(textPresent)) { ...v, phase: VoiceComplete, trace: signalTrace, hasInterim: false, hasFinal: false }
  else if (signal == SignalFinal) { ...v, phase: modelTextPhase(v), trace: signalTrace, hasInterim: false, hasFinal: true, hasProgress: false }
  else if (signal == SignalFirstText) { ...v, phase: modelTextPhase(v), trace: signalTrace }
  else if (signal == SignalStartsAudio) { ...v, phase: VoiceSpeaking, trace: signalTrace }
  else if (signal == SignalEndsAudio) { ...v, phase: VoiceComplete, trace: signalTrace, hasProgress: false }
  else if (signal == SignalInterrupted) { ...v, phase: VoiceInterrupted, trace: signalTrace, hasProgress: false }
  else if (signal == SignalReplyComplete) v
  else if (signal == SignalTerminal and v.trace == signalTrace) { ...v, phase: if (v.phase == VoiceSpeaking) VoiceSpeaking else VoiceComplete, hasProgress: false }
  else if (signal == SignalUsage and v.trace == signalTrace) { ...v, phase: if (v.phase == VoiceThinking) VoiceComplete else v.phase, hasProgress: false }
  else if (signal == SignalProgress and v.trace == signalTrace and v.suppressedTrace != signalTrace and (v.phase == VoiceThinking or v.phase == VoiceSpeaking)) { ...v, hasProgress: textPresent }
  else if (signal == SignalError) { ...v, hasError: true, hasProgress: false }
  else if (signal == SignalTelemetry or signal == SignalEagerEnd) { ...v, trace: signalTrace }
  else v
pure val signalTraceValues = Set(0, 1, 2, 3)
pure def alwaysTraceCoordinates(v: VoiceView): bool = v.trace >= 0 and v.suppressedTrace >= 0
pure def stepBargeInSuppressesCurrentProgress(before: VoiceView, via: str, after: VoiceView): bool =
  via == "bargeInVoice" implies after.suppressedTrace == before.trace and not(after.hasProgress)
pure def stepProgressNeedsCurrentUnsuppressedTrace(before: VoiceView, after: VoiceView): bool =
  not(before.hasProgress) and after.hasProgress implies
    (before.phase == VoiceThinking or before.phase == VoiceSpeaking) and after.trace == before.trace and
    before.suppressedTrace != before.trace
pure def lawTerminalDoesNotCutAudibleVoice(speakingView: VoiceView, signalTrace: int): bool =
  speakingView.phase == VoiceSpeaking implies
  applyVoiceSignal(speakingView, signalTrace, true, SignalUsage, false).phase == VoiceSpeaking and
  applyVoiceSignal(speakingView, signalTrace, true, SignalTerminal, false).phase == VoiceSpeaking
pure val speakingViewValues = Set({ ...initial, phase: VoiceSpeaking, trace: 1 })
pure def lawEmptyFinalHasNoModelLeg(speakingView: VoiceView, signalTrace: int): bool =
  applyVoiceSignal(speakingView, signalTrace, true, SignalFinal, false).phase == VoiceComplete
pure def sometimesVisibleVoiceProgress(v: VoiceView): bool = v.phase == VoiceThinking and v.hasProgress
pure def sometimesSessionListens(v: VoiceView): bool = v.phase == VoiceListening and v.sessionKnown
```

## Story: Send only what the person meant as a turn

> As a person talking with the microphone open, I want the assistant to
> answer what I said, not its own voice, my filler words or a draft I am
> still dictating.

### Filler words and the assistant's own echo are never sent as a turn

A final transcript with no words, or with only filler words such as "um"
and "uh", is not a turn. While the assistant is speaking, and for 1.5
seconds after its playback ended (or, when the turn's start is unknown,
while the reply is at most 3 seconds old), a turn of two or more words of
which at least 70 percent appear in the reply is its own echo and is not
sent. A capture that cancels the device's own playback has no echo after
playback ends. A one-word answer is never dropped as echo.

```quint
type HeardTurn = { words: int, onlyFiller: bool, overlapPercent: int, agentSpeaking: bool,
  startKnown: bool, startedAfterReplyEndMs: int, replyAgeMs: int, echoCancelled: bool }
pure def echoWindowOpen(heard: HeardTurn): bool =
  heard.agentSpeaking or (not(heard.echoCancelled) and
    (if (heard.startKnown) heard.startedAfterReplyEndMs <= 1500 else heard.replyAgeMs <= 3000))
pure def shouldRespond(heard: HeardTurn): bool =
  heard.words > 0 and not(heard.onlyFiller) and
    not(echoWindowOpen(heard) and heard.words >= 2 and heard.overlapPercent >= 70)
pure val spokenTurn: HeardTurn = { words: 3, onlyFiller: false, overlapPercent: 0, agentSpeaking: false,
  startKnown: true, startedAfterReplyEndMs: 5000, replyAgeMs: 9000, echoCancelled: false }
pure val heardValues = Set(spokenTurn, { ...spokenTurn, words: 0 }, { ...spokenTurn, onlyFiller: true },
  { ...spokenTurn, overlapPercent: 80, agentSpeaking: true }, { ...spokenTurn, overlapPercent: 80, startedAfterReplyEndMs: 1000 },
  { ...spokenTurn, overlapPercent: 80, startedAfterReplyEndMs: 1000, echoCancelled: true },
  { ...spokenTurn, words: 1, overlapPercent: 100, agentSpeaking: true }, { ...spokenTurn, overlapPercent: 80, startKnown: false, replyAgeMs: 2000 })
pure def lawFillerNeverSent(heard: HeardTurn): bool = (heard.words == 0 or heard.onlyFiller) implies not(shouldRespond(heard))
pure def lawEchoWhileSpeakingDropped(heard: HeardTurn): bool =
  heard.agentSpeaking and heard.words >= 2 and heard.overlapPercent >= 70 implies not(shouldRespond(heard))
pure def lawOneWordAnswerKept(heard: HeardTurn): bool =
  heard.words == 1 and not(heard.onlyFiller) implies shouldRespond(heard)
```

### Only a conversation submits on its own; dictation waits for the person

In a voice conversation the endpoint submits each utterance when it
decides the person finished. Dictation produces an editable draft that the
person sends; it never uses the conversation's turn controller and never
submits by itself. An automatic submission is never an approval.

```quint
type VoiceInputMode = ConversationMode | DictationMode
type VoiceSubmission = { mode: VoiceInputMode, endpointDecided: bool, personSent: bool }
pure def submissionSent(submission: VoiceSubmission): bool =
  if (submission.mode == ConversationMode) submission.endpointDecided else submission.personSent
pure val submissionValues = Set({ mode: DictationMode, endpointDecided: true, personSent: false },
  { mode: DictationMode, endpointDecided: false, personSent: true }, { mode: ConversationMode, endpointDecided: true, personSent: false },
  { mode: ConversationMode, endpointDecided: false, personSent: true })
pure def lawDictationNeedsThePerson(submission: VoiceSubmission): bool =
  submission.mode == DictationMode and not(submission.personSent) implies not(submissionSent(submission))
pure def lawConversationSubmitsOnEndpoint(submission: VoiceSubmission): bool =
  submission.mode == ConversationMode and submission.endpointDecided implies submissionSent(submission)
```

### The voice session's interface context is an allow-list of observations that grants no authority

With each voice session the renderer may send what it currently shows:
its view path (rooted, not starting with `//`, at most 2,048 characters),
subview and time zone (at most 128 characters each), that it presents the
native browser surface, that it delivers views as completed actions, its
routing identity (the same one its authenticated client uses), and the
person's direct-request preference. Direct requests need completed-action
delivery and a valid routing identity. Any other value, or any field
outside these bounds, refuses the whole context. The context only
describes the screen: it grants no device, provider or navigation
permission.

```quint
type UiContextOffer = { deliveryCompleted: bool, deliveryOther: bool, clientIdPresent: bool, clientIdValid: bool,
  directRequests: bool, surfaceOther: bool, viewPathChars: int, viewPathRooted: bool, viewPathDoubleSlash: bool, shortFieldChars: int }
pure def uiContextAccepted(offer: UiContextOffer): bool =
  not(offer.deliveryOther) and not(offer.surfaceOther) and (not(offer.clientIdPresent) or offer.clientIdValid) and
    (not(offer.directRequests) or (offer.deliveryCompleted and offer.clientIdPresent and offer.clientIdValid)) and
    offer.viewPathChars >= 0 and offer.viewPathChars <= 2048 and offer.shortFieldChars <= 128 and
    (offer.viewPathChars == 0 or (offer.viewPathRooted and not(offer.viewPathDoubleSlash)))
pure val boundOffer: UiContextOffer = { deliveryCompleted: true, deliveryOther: false, clientIdPresent: true, clientIdValid: true,
  directRequests: true, surfaceOther: false, viewPathChars: 12, viewPathRooted: true, viewPathDoubleSlash: false, shortFieldChars: 20 }
pure val offerValues = Set(boundOffer, { ...boundOffer, deliveryCompleted: false }, { ...boundOffer, clientIdPresent: false },
  { ...boundOffer, viewPathDoubleSlash: true }, { ...boundOffer, viewPathChars: 2049 }, { ...boundOffer, shortFieldChars: 129 },
  { ...boundOffer, directRequests: false, deliveryCompleted: false, clientIdPresent: false })
pure def lawDirectRequestsNeedABoundRenderer(offer: UiContextOffer): bool =
  offer.directRequests and uiContextAccepted(offer) implies offer.deliveryCompleted and offer.clientIdPresent and offer.clientIdValid
pure def lawViewPathStaysLocal(offer: UiContextOffer): bool =
  uiContextAccepted(offer) and offer.viewPathChars > 0 implies offer.viewPathRooted and not(offer.viewPathDoubleSlash)
```
