# Meeting transcription

URL authorization, viewer-scoped transcript disclosure, and ASR segment filtering
are specified in [join URL validation, viewer disclosure, and segment admission](urlAndDisclosure.md).

## Story: Join a meeting as a disclosed transcription guest

> As an authorized meeting participant, I can admit a notetaker, follow its transcription progress, stop it, and read the resulting transcript.

### Capture begins only after disclosure and admission for the same session

The shell connects to the chosen meeting platform, observes admission, makes the transcription disclosure, and binds observations to a session generation. It establishes that the join request is authorized and that the join URL matches the selected platform before applying the request.

```quint
type MeetingProvider = GoogleMeet | MicrosoftTeams | ZoomMeeting
type CapturePhase = NoMeeting | AwaitingAdmission | Admitted | Capturing | Finalizing | CompleteMeeting | FailedMeeting
type TranscriptSegment = { seq: int, speaker: str, fromMs: int, toMs: int, words: str }
type MeetingCapture = { capturePhase: CapturePhase, provider: MeetingProvider, sessionKey: str, disclosed: bool, transcript: List[TranscriptSegment], nextSeq: int }
pure val initial: MeetingCapture = { capturePhase: NoMeeting, provider: GoogleMeet, sessionKey: "", disclosed: false, transcript: List(), nextSeq: 1 }
pure val sessionKeyValues = Set("run-1", "run-2")
pure val segmentValues = Set({ seq: 1, speaker: "Jordan", fromMs: 0, toMs: 100, words: "Let's begin" }, { seq: 2, speaker: "Riley", fromMs: 200, toMs: 300, words: "Thanks" })
pure def canRequestJoin(s: MeetingCapture, sessionKey: str): bool = s.capturePhase == NoMeeting and sessionKey != ""
pure def requestJoin(s: MeetingCapture, sessionKey: str, provider: MeetingProvider): MeetingCapture =
  { ...s, capturePhase: AwaitingAdmission, sessionKey: sessionKey, provider: provider }
pure def canObserveJoin(s: MeetingCapture, sessionKey: str): bool = s.capturePhase == AwaitingAdmission and s.sessionKey == sessionKey
pure def observeJoin(s: MeetingCapture, sessionKey: str, accepted: bool): MeetingCapture =
  { ...s, capturePhase: if (accepted) Admitted else FailedMeeting }
pure def canObserveDisclosure(s: MeetingCapture, sessionKey: str): bool = s.capturePhase == Admitted and s.sessionKey == sessionKey
pure def observeDisclosure(s: MeetingCapture, sessionKey: str, disclosed: bool): MeetingCapture =
  { ...s, disclosed: disclosed, capturePhase: if (disclosed) Capturing else FailedMeeting }
pure def alwaysCaptureWasDisclosed(s: MeetingCapture): bool =
  (s.capturePhase == Capturing or s.capturePhase == Finalizing or s.capturePhase == CompleteMeeting) implies s.disclosed
```

### Transcript segments are bound to that meeting and appended once in sequence

Transcription and speaker recognition are external observations. The shell filters unusable output, supplies an ordered segment identifier and buffers provider fragments before admission to the transcript.

```quint
pure def canAppendSegment(s: MeetingCapture, sessionKey: str, segment: TranscriptSegment): bool =
  s.capturePhase == Capturing and sessionKey == s.sessionKey and segment.seq == s.nextSeq and
  segment.speaker != "" and segment.words != "" and segment.fromMs >= 0 and segment.toMs >= segment.fromMs
pure def appendSegment(s: MeetingCapture, sessionKey: str, segment: TranscriptSegment): MeetingCapture =
  { ...s, transcript: s.transcript.append(segment), nextSeq: s.nextSeq + 1 }
pure def alwaysSegmentsAreCounted(s: MeetingCapture): bool =
  s.nextSeq == s.transcript.length() + 1
pure def canStopCapture(s: MeetingCapture, sessionKey: str): bool = s.capturePhase == Capturing and sessionKey == s.sessionKey
pure def stopCapture(s: MeetingCapture, sessionKey: str): MeetingCapture = { ...s, capturePhase: Finalizing }
pure def canFinishTranscript(s: MeetingCapture, sessionKey: str): bool = s.capturePhase == Finalizing and sessionKey == s.sessionKey
pure def finishTranscript(s: MeetingCapture, sessionKey: str, saved: bool): MeetingCapture =
  { ...s, capturePhase: if (saved) CompleteMeeting else FailedMeeting }
pure def stepFinalTranscriptIsFrozen(before: MeetingCapture, after: MeetingCapture): bool =
  before.capturePhase == CompleteMeeting implies before == after
pure def sometimesTranscriptPublished(s: MeetingCapture): bool = s.capturePhase == CompleteMeeting and s.transcript.length() > 0
pure val eval_witness_sometimesTranscriptPublished = (("requestJoin", "run-1", GoogleMeet), ("observeJoin", "run-1", true), ("observeDisclosure", "run-1", true), ("appendSegment", "run-1", { seq: 1, speaker: "Jordan", fromMs: 0, toMs: 100, words: "Let's begin" }), ("stopCapture", "run-1"), ("finishTranscript", "run-1", true))
```
