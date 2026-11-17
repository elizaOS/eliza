# Client audio

The browser-safe audio helpers a screen and the voice session
(`spec/agent/voice/session.md`) use, exported from `@elizaos/agent/voice`:
the cumulative microphone capture and its worklet, mono PCM16 WAV encoding,
decoding a recorded clip to bounded samples, `audioBlobBase64`, the cloud
speech piece plan, the segmented player with its progressive attachment,
the recorded transcription controller and the draft guard. They hold no
policy of their own: the screen owns the microphone stream, the speech
service and what is sent. Who owns the microphone through a voice turn, and
what of a spoken reply was heard, is the voice session's. Browser audio,
media elements, timers and file reads stay in `voice/capture.vibe`,
`voice/playback.vibe` and `voice/recorded-transcription.vibe`; this library
holds the decisions they make, with sample values in millionths of full
scale and audio sizes as counts.

## Story: Record and play speech in the screen without losing a segment

> As a person talking to the assistant, I want what I say recorded whole
> and what it says played whole, in order, so that no word is dropped,
> repeated or played after I stop it.

### A WAV holds every sample in order as mono PCM16 behind a 44-byte header

Samples from any number of chunks are written in order with no second
float buffer. A sample is clamped to full scale; a negative one scales by
32,768 and a positive one by 32,767, rounded to the nearest whole value; a
sample that is not a finite number is silence. The sample rate is a whole
number from 8,000 to 48,000. A recorded clip is decoded to mono samples at
16 kHz only when it is not empty, at most 16 MB and at most 60 seconds
long; the decode stops when the caller cancels.

```quint
type SampleValue = FiniteSample({ micro: int }) | NonFiniteSample
pure val fullScale = 1000000
pure val wavHeaderBytes = 44
pure val recordingSampleRate = 16000
pure val recordingMaxBytes = 16000000
pure val recordingMaxMs = 60000
pure def wavRateAccepted(rate: int): bool = rate >= 8000 and rate <= 48000
pure def wavByteLength(sampleCount: int): int = wavHeaderBytes + 2 * sampleCount
pure def recordingDecodable(bytes: int, durationMs: int): bool = bytes > 0 and bytes <= recordingMaxBytes and durationMs > 0 and durationMs <= recordingMaxMs
pure def floorRatio(n: int, d: int): int = if (d <= 0) 0 else if (n >= 0 or n % d == 0) n / d else n / d - 1
pure def pcm16OfMicro(micro: int): int = {
  val c = if (micro > fullScale) fullScale else if (micro < -fullScale) -fullScale else micro
  floorRatio(2 * c * (if (c < 0) 32768 else 32767) + fullScale, 2 * fullScale)
}
pure def pcm16Of(sample: SampleValue): int = match sample { | FiniteSample(f) => pcm16OfMicro(f.micro) | NonFiniteSample => 0 }
pure val microValues = Set(-2000000, -1000000, -999999, -500000, -15, -1, 0, 1, 15, 500000, 999999, 1000000, 2000000)
pure def lawPcm16StaysInRange(micro: int): bool = pcm16OfMicro(micro) >= -32768 and pcm16OfMicro(micro) <= 32767
pure def lawPcm16KeepsTheSign(micro: int): bool = (micro > 0 implies pcm16OfMicro(micro) >= 0) and (micro < 0 implies pcm16OfMicro(micro) <= 0)
pure def lawFullScaleReachesTheLimits(micro: int): bool = (micro >= fullScale implies pcm16OfMicro(micro) == 32767) and (micro <= -fullScale implies pcm16OfMicro(micro) == -32768)
```

### The capture keeps a bounded prefix in arrival order while the meter keeps counting

The worklet copies the first input channel only, posts each full block of
2,048 samples in order and plays nothing back. The capture takes a
nonempty block only while it is current; it keeps samples up to its cap
(sample rate times the screen's maximum seconds), clipping only the block
that reaches it, and still counts and meters every block past the cap.
Only the kept part of a block can count as speech, and speech heard once
stays heard. A screen may share its open audio context, which must run at
the capture's sample rate; the capture closes only a context it opened and
never stops the screen's tracks. Closing drops the kept samples.

```quint
type ContextCustody = OwnedContext | SharedContext
type CaptureBuffer = { capSamples: int, received: int, stored: int, heardSpeech: bool, lastOffered: int, offering: bool }
pure def closesContextOnRelease(custody: ContextCustody): bool = custody == OwnedContext
pure def sharedContextAccepted(contextRate: int, captureRate: int): bool = contextRate == captureRate
pure def captureWellFormed(b: CaptureBuffer): bool = b.capSamples > 0 and b.lastOffered >= 0 and b.lastOffered <= b.stored and b.stored <= b.capSamples and b.stored <= b.received
pure def blockAccepted(isCurrent: bool, blockSamples: int): bool = isCurrent and blockSamples > 0
pure def retainBlock(b: CaptureBuffer, blockSamples: int, blockHasSpeech: bool): CaptureBuffer = {
  val room = b.capSamples - b.stored
  val kept = if (blockSamples < room) blockSamples else room
  { ...b, received: b.received + blockSamples, stored: b.stored + kept, heardSpeech: b.heardSpeech or (kept > 0 and blockHasSpeech) }
}
pure val bValues = Set(
  { capSamples: 4, received: 0, stored: 0, heardSpeech: false, lastOffered: 0, offering: false },
  { capSamples: 4, received: 2, stored: 2, heardSpeech: false, lastOffered: 0, offering: false },
  { capSamples: 4, received: 3, stored: 3, heardSpeech: true, lastOffered: 1, offering: false },
  { capSamples: 4, received: 9, stored: 4, heardSpeech: true, lastOffered: 4, offering: true })
pure val blockSamplesValues = Set(1, 2, 3, 5)
pure def lawTheKeptPrefixOnlyGrowsWithinTheCap(b: CaptureBuffer, blockSamples: int, blockHasSpeech: bool): bool = {
  val after = retainBlock(b, blockSamples, blockHasSpeech)
  (captureWellFormed(b) and blockAccepted(true, blockSamples)) implies (captureWellFormed(after) and after.stored >= b.stored and after.received == b.received + blockSamples)
}
pure def lawTheMeterCountsPastTheCap(b: CaptureBuffer, blockSamples: int, blockHasSpeech: bool): bool = {
  val after = retainBlock(b, blockSamples, blockHasSpeech)
  (captureWellFormed(b) and b.stored == b.capSamples and blockSamples > 0) implies (after.stored == b.stored and after.heardSpeech == b.heardSpeech and after.received > b.received)
}
```

### A preview offers only new speech and never offers a failed preview again

On each tick a capture that has heard speech offers the whole kept prefix
when at least the screen's minimum of new samples has arrived and no
offer is in flight. A snapshot waits for the offer in flight and then
needs one new sample; it answers true only when the receiver completed.
The offered position moves before the receiver starts, so a receiver that
fails or throws at once is not offered the same samples again, and the
recording is untouched by a failed preview.

```quint
pure def previewDue(b: CaptureBuffer, minimumNew: int): bool = b.heardSpeech and not(b.offering) and b.stored - b.lastOffered >= (if (minimumNew < 1) 1 else minimumNew)
pure def offerPreview(b: CaptureBuffer): CaptureBuffer = { ...b, lastOffered: b.stored, offering: true }
pure def settlePreview(b: CaptureBuffer): CaptureBuffer = { ...b, offering: false }
pure val minimumNewValues = Set(0, 1, 2)
pure def lawOneOfferAtATime(b: CaptureBuffer, minimumNew: int): bool = not(previewDue(offerPreview(b), minimumNew))
pure def lawAFailedPreviewIsNeverOfferedAgain(b: CaptureBuffer, minimumNew: int): bool = previewDue(b, minimumNew) implies not(previewDue(settlePreview(offerPreview(b)), minimumNew))
pure def lawNewSpeechIsOfferedNext(b: CaptureBuffer, blockSamples: int): bool = {
  val retried = settlePreview(offerPreview(b))
  (captureWellFormed(b) and previewDue(b, 1) and b.stored + blockSamples <= b.capSamples and blockSamples > 0) implies previewDue(retainBlock(retried, blockSamples, false), 1)
}
```

### Cloud speech goes in pieces, a short first one and none larger than one request

The whole reply is planned before any piece is spoken, with whitespace
collapsed so that joining the pieces with one space keeps every word. The
first piece is at most 220 units unless it is one word, each later piece at
most 5,000, cut at a sentence end, then a phrase end, then a space, never
inside a word or after an abbreviation. A word longer than 5,000 units
refuses the whole reply. Pieces are spoken one at a time, each fully
retired before the next, and the screen hears of first audio once per
reply.

```quint
pure val cloudFirstPieceUnits = 220
pure val cloudPieceUnits = 5000
pure def speechPieceAccepted(first: bool, units: int, words: int): bool = units > 0 and words > 0 and units <= cloudPieceUnits and (not(first) or units <= cloudFirstPieceUnits or words == 1)
pure def replySpeakable(longestWordUnits: int): bool = longestWordUnits <= cloudPieceUnits
```

### A segment is played only once its input has ended and its audio has played

Each segment's audio arrives through an attachment whose readiness is
one-shot. A rendered speed that is absent is neutral; one that is not a
positive number fails the segment as invalid audio. Input end without
readiness is invalid audio. Audio may end before or after the input does,
and the segment is played when both have happened; a play rejection or a
media error fails it. A settled segment ignores every later signal, and a
signal from a stopped reply never reaches the player.

```quint
type SegmentSignal = AudioReady | AudioReadyBadSpeed | InputLoaded | AudioEnded | AudioBroke
type SegmentOutcome = SegmentPending | SegmentPlayed | SegmentInvalid | SegmentFailed
type SegmentProgress = { ready: bool, loaded: bool, ended: bool, outcome: SegmentOutcome }
pure val segmentStart: SegmentProgress = { ready: false, loaded: false, ended: false, outcome: SegmentPending }
pure def segmentAfter(p: SegmentProgress, sig: SegmentSignal): SegmentProgress =
  if (p.outcome != SegmentPending) p else match sig {
    | AudioReady => { ...p, ready: true }
    | AudioReadyBadSpeed => if (p.ready) p else { ...p, outcome: SegmentInvalid }
    | InputLoaded => if (not(p.ready)) { ...p, outcome: SegmentInvalid } else { ...p, loaded: true, outcome: if (p.ended) SegmentPlayed else SegmentPending }
    | AudioEnded => { ...p, ended: true, outcome: if (p.loaded) SegmentPlayed else SegmentPending }
    | AudioBroke => { ...p, outcome: SegmentFailed }
  }
pure def segmentOf(signals: List[SegmentSignal]): SegmentProgress = signals.foldl(segmentStart, (p, sig) => segmentAfter(p, sig))
pure def lawASegmentPlaysOnlyAfterBothEnds(signals: List[SegmentSignal]): bool =
  segmentOf(signals).outcome == SegmentPlayed implies (signals.includes(AudioReady) and signals.includes(InputLoaded) and signals.includes(AudioEnded))
pure def lawASettledSegmentStaysSettled(signals: List[SegmentSignal], later: List[SegmentSignal]): bool =
  segmentOf(signals).outcome != SegmentPending implies segmentOf(signals.concat(later)).outcome == segmentOf(signals).outcome
```

### Segments play in order once each, and Stop silences the reply at once

A reply's text is split into segments that keep every word; a screen may
keep an utterance whole. Speak while a reply plays does nothing. Each
played segment is the next one, a failed segment ends the reply with its
error, and Stop ends it at once, pausing and detaching the player and
showing idle. A reply that ended plays nothing more until the next Speak.

```quint
type ReplyEvent = SpeakReply | NextSegmentPlayed | SegmentBroke | StopReply
type ReplyRun = { running: bool, played: int, stopped: bool, failed: bool }
pure val replyIdle: ReplyRun = { running: false, played: 0, stopped: false, failed: false }
pure def replyAfter(r: ReplyRun, segmentCount: int, e: ReplyEvent): ReplyRun = match e {
  | SpeakReply => if (r.running) r else { ...replyIdle, running: segmentCount > 0 }
  | NextSegmentPlayed => if (r.running and r.played < segmentCount) { ...r, played: r.played + 1, running: r.played + 1 < segmentCount } else r
  | SegmentBroke => if (r.running) { ...r, running: false, failed: true } else r
  | StopReply => { ...r, running: false, stopped: true }
}
pure def replyOf(segmentCount: int, events: List[ReplyEvent]): ReplyRun = events.foldl(replyIdle, (r, e) => replyAfter(r, segmentCount, e))
pure def lawNoMoreSegmentsThanTheReplyHas(segmentCount: int, events: List[ReplyEvent]): bool = replyOf(segmentCount, events).played <= (if (segmentCount > 0) segmentCount else 0)
pure def lawNothingPlaysAfterStop(segmentCount: int, events: List[ReplyEvent], later: List[ReplyEvent]): bool = {
  val ended = events.append(StopReply)
  not(later.includes(SpeakReply)) implies (replyOf(segmentCount, ended.concat(later)).played == replyOf(segmentCount, ended).played and not(replyOf(segmentCount, ended.concat(later)).running))
}
pure def lawAFailedSegmentEndsTheReply(segmentCount: int, events: List[ReplyEvent]): bool =
  replyOf(segmentCount, events).running implies not(replyAfter(replyOf(segmentCount, events), segmentCount, SegmentBroke).running)
```

### The progressive attachment is ready at its first appended frame, or at the end without streaming

Where the browser streams MP3 through a media source, the attachment
listens before it sets the source URL, waits for each nonempty append, and
is ready after the first one. Without a media source it plays the same
response's complete clip, never a second synthesis, and is ready only at
the stream's end. Its result carries the ordered frames, the whole audio
and the rendered speed. A browser media wait times out after 30 seconds.
Dispose cancels the upstream stream only when it has not completed,
detaches the player only while it holds this URL, and always revokes it.

```quint
pure val mediaWaitMs = 30000
pure def attachmentReady(streaming: bool, appendedFrame: bool, reachedEnd: bool, stillOwned: bool): bool = stillOwned and (reachedEnd or (streaming and appendedFrame))
pure def cancelsUpstream(disposed: bool, completed: bool): bool = not(disposed or completed)
pure def lawWithoutStreamingReadyNeedsTheEnd(appendedFrame: bool, stillOwned: bool): bool = not(attachmentReady(false, appendedFrame, false, stillOwned))
pure def lawACompletedStreamIsNeverCancelled(disposed: bool): bool = not(cancelsUpstream(disposed, true))
```

## Story: Dictate into my draft without losing my own words

> As a person dictating a message, I want my words to land in the draft for
> me to review, so that nothing is sent by itself and nothing I typed is
> overwritten by a late transcription.

### A recording becomes review text through the host's result or the recording, never a send

Start authorizes, acquires the microphone and starts a recorder once; a
second Start while one is pending does nothing. Finish, the pause
observer, the time limit and a total over the byte limit all stop the same
recorder; exactly the limit is kept. The bounds are whole numbers from 1 to
2,147,483,647. Once the recorder stops the microphone is released. A
host's final result other than undefined is the final text, even with no
usable recording; only undefined encodes the recording under the
recorder's MIME type and transcribes it. Previews are published only as
nonblank, non-final text of the current capture. The final text goes to
the screen for review; the controller has no send. Cancel releases
everything at once, and nothing late reaches the screen.

```quint
type RecordingPhase = RecordingIdle | RecordingConnecting | RecordingActive | RecordingTranscribing
type HostTranscript = HostUndefined | HostText | HostBlank | HostRejected
type RecordingText = TranscribedText | TranscribedBlank | TranscribeRejected
type RecordedResult = ReviewText | EmptyAudio | TooLarge | EmptyTranscript | PortFailed
pure val recordingBoundMax = 2147483647
pure def recordingBoundAccepted(n: int): bool = n > 0 and n <= recordingBoundMax
pure def recordingUploaded(host: HostTranscript, bytes: int, maximumBytes: int): bool = host == HostUndefined and bytes > 0 and bytes <= maximumBytes
pure def recordedResult(host: HostTranscript, bytes: int, maximumBytes: int, transcript: RecordingText): RecordedResult = match host {
  | HostText => ReviewText
  | HostBlank => EmptyTranscript
  | HostRejected => PortFailed
  | HostUndefined => if (bytes > maximumBytes) TooLarge else if (bytes <= 0) EmptyAudio else match transcript { | TranscribedText => ReviewText | TranscribedBlank => EmptyTranscript | TranscribeRejected => PortFailed }
}
pure def previewPublishable(currentCapture: bool, previewsOpen: bool, nonblank: bool): bool = currentCapture and previewsOpen and nonblank
pure val bytesValues = Set(0, 1, 4, 5)
pure val maximumBytesValues = Set(4)
pure def lawTheRecordingMattersOnlyWhenUploaded(host: HostTranscript, bytes: int, maximumBytes: int, transcript: RecordingText, otherTranscript: RecordingText): bool =
  not(recordingUploaded(host, bytes, maximumBytes)) implies recordedResult(host, bytes, maximumBytes, transcript) == recordedResult(host, bytes, maximumBytes, otherTranscript)
pure def lawReviewTextNeedsWords(host: HostTranscript, bytes: int, maximumBytes: int, transcript: RecordingText): bool =
  recordedResult(host, bytes, maximumBytes, transcript) == ReviewText implies (host == HostText or (recordingUploaded(host, bytes, maximumBytes) and transcript == TranscribedText))
```

### A stale transcription never replaces a newer draft

Each capture takes a ticket that remembers the draft's revision when it
began; a new capture or an invalidation retires the older ticket. The
screen reports each draft it shows, and only a draft that differs from the
last one counts as an edit. A transcription from the current ticket with
no edit since replaces the draft with the screen's composition of the
original draft and the text, which is not an edit. After an edit a preview
is ignored and a final text is handed back as a conflict, so the person
loses neither their words nor the transcription. A retired ticket is
ignored.

```quint
type DraftGuard = { revision: int, generation: int }
type DraftTicket = { ticketRevision: int, ticketGeneration: int }
type DraftOutcome = DraftApplied | DraftConflict | DraftIgnored
pure def observeDraft(g: DraftGuard, changed: bool): DraftGuard = if (changed) { ...g, revision: g.revision + 1 } else g
pure def invalidateDraft(g: DraftGuard): DraftGuard = { ...g, generation: g.generation + 1 }
pure def beginDraft(g: DraftGuard): DraftGuard = { ...g, generation: g.generation + 1 }
pure def ticketFor(g: DraftGuard): DraftTicket = { ticketRevision: g.revision, ticketGeneration: g.generation + 1 }
pure def draftOutcome(g: DraftGuard, t: DraftTicket, isFinal: bool): DraftOutcome =
  if (t.ticketGeneration != g.generation) DraftIgnored else if (t.ticketRevision != g.revision) (if (isFinal) DraftConflict else DraftIgnored) else DraftApplied
pure val gValues = Set({ revision: 0, generation: 0 }, { revision: 2, generation: 3 })
pure def lawAnUneditedDraftTakesTheTranscript(g: DraftGuard, isFinal: bool): bool = draftOutcome(observeDraft(beginDraft(g), false), ticketFor(g), isFinal) == DraftApplied
pure def lawAnEditAfterBeginKeepsTheDraft(g: DraftGuard, isFinal: bool): bool = draftOutcome(observeDraft(beginDraft(g), true), ticketFor(g), isFinal) != DraftApplied
pure def lawAFinalTextAfterAnEditIsHandedBack(g: DraftGuard): bool = draftOutcome(observeDraft(beginDraft(g), true), ticketFor(g), true) == DraftConflict
pure def lawARetiredCaptureIsIgnored(g: DraftGuard, isFinal: bool): bool =
  draftOutcome(beginDraft(beginDraft(g)), ticketFor(g), isFinal) == DraftIgnored and draftOutcome(invalidateDraft(beginDraft(g)), ticketFor(g), isFinal) == DraftIgnored
```
