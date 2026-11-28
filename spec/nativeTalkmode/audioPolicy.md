# Talk Mode volume and mute audio policy

Voice capture is input-side state and never stops when device output is muted or set to volume zero. In-flight speech synthesis continues silently under output mute rather than pausing or cancelling.

## Story: Keep voice capture active and TTS progressing under output mute

> As the owner, I want muting output volume to make speech inaudible without interrupting microphone capture or cancelling an active utterance.

### Output mute and volume zero change audibility without stopping capture or active TTS progress

A fresh policy state starts with `captureActive = false`, `ttsUtteranceId = ""`, `outputMuted = false`, and `outputVolumePct = 100`. `startCapture` requires `not(captureActive)` and sets `captureActive = true`; `stopCapture` requires `captureActive` and sets `captureActive = false`. `startTts` requires a non-empty `utteranceId` and sets `ttsUtteranceId = utteranceId`; `finishTts` requires a non-empty `utteranceId` matching `ttsUtteranceId` and clears `ttsUtteranceId`. `setOutputMute` sets `outputMuted` when it differs from the current flag. `setOutputVolume` accepts `volumePct` in `0..100` when it differs from `outputVolumePct`. Across every state: `outputVolumePct` stays in `0..100`. Derived audibility returns `TtsNotSpeaking` when `ttsUtteranceId == ""`, `TtsSilentByOutputPolicy` when `outputMuted` or `outputVolumePct == 0`, and `TtsAudible` otherwise. Muting output never stops active capture.

```quint
type TalkAudibility = TtsAudible | TtsSilentByOutputPolicy | TtsNotSpeaking
type TalkAudioPolicyState = { captureActive: bool, ttsUtteranceId: str, outputMuted: bool, outputVolumePct: int }
pure val initial: TalkAudioPolicyState = { captureActive: false, ttsUtteranceId: "", outputMuted: false, outputVolumePct: 100 }
pure val utteranceIdValues = Set("utt-1", "utt-2", "")
pure val volumePctValues = Set(0, 50, 100)
pure def canStartCapture(s: TalkAudioPolicyState): bool = not(s.captureActive)
pure def startCapture(s: TalkAudioPolicyState): TalkAudioPolicyState = { ...s, captureActive: true }
pure def canStopCapture(s: TalkAudioPolicyState): bool = s.captureActive
pure def stopCapture(s: TalkAudioPolicyState): TalkAudioPolicyState = { ...s, captureActive: false }
pure def canStartTts(s: TalkAudioPolicyState, utteranceId: str): bool = utteranceId != "" and s.ttsUtteranceId != utteranceId
pure def startTts(s: TalkAudioPolicyState, utteranceId: str): TalkAudioPolicyState = { ...s, ttsUtteranceId: utteranceId }
pure def canFinishTts(s: TalkAudioPolicyState, utteranceId: str): bool = utteranceId != "" and s.ttsUtteranceId == utteranceId
pure def finishTts(s: TalkAudioPolicyState, utteranceId: str): TalkAudioPolicyState = { ...s, ttsUtteranceId: "" }
pure def canSetOutputMute(s: TalkAudioPolicyState, muted: bool): bool = s.outputMuted != muted
pure def setOutputMute(s: TalkAudioPolicyState, muted: bool): TalkAudioPolicyState = { ...s, outputMuted: muted }
pure def canSetOutputVolume(s: TalkAudioPolicyState, volumePct: int): bool = volumePct >= 0 and volumePct <= 100 and s.outputVolumePct != volumePct
pure def setOutputVolume(s: TalkAudioPolicyState, volumePct: int): TalkAudioPolicyState = { ...s, outputVolumePct: volumePct }
pure def talkAudibility(s: TalkAudioPolicyState): TalkAudibility =
  if (s.ttsUtteranceId == "") TtsNotSpeaking
  else if (s.outputMuted or s.outputVolumePct == 0) TtsSilentByOutputPolicy
  else TtsAudible
pure def alwaysVolumeInBounds(s: TalkAudioPolicyState): bool = s.outputVolumePct >= 0 and s.outputVolumePct <= 100
pure def lawMutePreservesCapture(s: TalkAudioPolicyState): bool =
  setOutputMute(s, true).captureActive == s.captureActive
pure def lawZeroVolumeSilencesTts(s: TalkAudioPolicyState): bool =
  s.ttsUtteranceId != "" implies talkAudibility({ ...s, outputVolumePct: 0 }) == TtsSilentByOutputPolicy
pure def sometimesMutedCaptureAndSilentTts(s: TalkAudioPolicyState): bool =
  s.captureActive and s.ttsUtteranceId != "" and talkAudibility(s) == TtsSilentByOutputPolicy
pure val eval_witness_sometimesMutedCaptureAndSilentTts = ("startCapture", ("startTts", "utt-1"), ("setOutputMute", true))
```
