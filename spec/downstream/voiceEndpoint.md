# Voice endpoint decisions and interruption receipts

AlphaPhone projects Eliza `packages/voice/src/voice-endpoint-chain.ts`,
`voice-assistant-session.ts` and `voice-turn-routes.ts` from
`c518127a025ab173874af9c7d304f26b25213b0d`. The [speech request](./mobileSpeech.md)
owns the native cancellation signal. [Audio playback](./mobilePlayback.md)
owns the sentences the person heard. This specification governs when
a voice utterance is sent and how an interrupted reply's history is amended.

## Story: Submit one utterance after the person finishes speaking

### One live utterance owns the short-gap answer and the long-gap fallback

After VAD speech-end and final transcript, the short gap may start a
single endpoint query. Resident finished or continue settles its query.
A resident rejection is unavailable when Cloud is configured and an
error otherwise. An optional Clef stage needs both its host enable
switch and authenticated client. Its gate may refuse this turn. It
sends text without audio at a maximum of 2,000 UTF-16 units, with a
default 300 ms stage deadline distinct from the overall endpoint
deadline. The pinned source sends at most six structurally valid recent
turns and only their speaker and text. The replacement checks the full
selected context and returns an explicit unavailable result when a
bounded provider cannot accept it. The session then uses its long gap.
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
