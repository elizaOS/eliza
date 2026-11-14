# Realtime voice client state

AlphaPhone projects `packages/ui/src/voice/voice-session-state.ts` and
`voice-session-client-core.ts` from Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. The decoder and socket owner
establish current session authority. [Playback](./mobilePlayback.md)
owns the audible queue and its drain. The UI reducer owns turn
presentation and ephemeral progress.

## Story: Show the current voice turn without reopening the microphone early

### Commit, audible playback and displayed progress have separate evidence

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
navigation, and overlap telemetry have separate external effects.
The model treats decoded IDs as positive ordinals and projects display
phase, transcript presence and progress presence. The port must also
copy complete strings, reasons, error code, retryable flag and exact
payload fields from the wire.

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
