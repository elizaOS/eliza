# Native talk mode

The Android [microphone](../os/voice/microphone.md), [speech output](../os/voice/speechOutput.md), and [live capture](../os/voice/liveCapture.md) specifications own their resources. Talk Mode exposes the cross-platform session, transcription, playback, audio-frame and status boundaries. Input-capture and TTS output-mute continuity rules live in [volume and mute audio policy](./audioPolicy.md).

## Story: Converse by voice without audio from a retired session playing or recording

> As the owner, I want spoken replies and live transcripts tied to this conversation and to current device permissions.

### Capture and playback callbacks belong to the current conversation

Start and stop operate on an owner session. Audio frames and transcripts require a live capture lease; device call occupancy suspends capture and playback while the system owns those resources. A late reply cannot trigger playback after the session closes.

```quint
type TalkEvent = TalkStateChange | TalkTranscript | TalkAudioFrame | TalkPlaybackFrame | TalkPlaybackDone
type TalkSession = { conversationId: str, ownerSession: bool, active: bool, captureLease: bool, outputFocus: bool, onCall: bool }
pure def mayPublishTalkEvent(s: TalkSession, conversationId: str, eventKind: TalkEvent): bool =
  conversationId != "" and s.conversationId == conversationId and s.ownerSession and s.active and
  (if (eventKind == TalkTranscript or eventKind == TalkAudioFrame) s.captureLease and not(s.onCall) else
   if (eventKind == TalkPlaybackFrame) s.outputFocus and not(s.onCall) else true)
pure def lawCallPreventsTalkAudio(s: TalkSession, conversationId: str): bool =
  s.onCall implies
    not(mayPublishTalkEvent(s, conversationId, TalkAudioFrame) or mayPublishTalkEvent(s, conversationId, TalkPlaybackFrame))
pure def lawRetiredConversationCannotPublish(s: TalkSession, conversationId: str, eventKind: TalkEvent): bool =
  s.conversationId != conversationId implies not(mayPublishTalkEvent(s, conversationId, eventKind))
pure val sValues = Set(
  { conversationId: "talk1", ownerSession: true, active: true, captureLease: true, outputFocus: true, onCall: false },
  { conversationId: "talk1", ownerSession: true, active: true, captureLease: true, outputFocus: true, onCall: true },
  { conversationId: "talk2", ownerSession: true, active: false, captureLease: false, outputFocus: false, onCall: false })
pure val conversationIdValues = Set("", "talk1", "talk2")
```
