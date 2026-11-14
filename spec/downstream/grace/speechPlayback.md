# Grace reply audio and playback ownership

Grace `48b43b9c` supplies one complete sentence at a time from
`apps/app/src/speech-playback.ts`. Its `stream-speech.ts` binds the
progressive attachment from Eliza `7743504b`. The producer owns the two
distinct contracts in `packages/ui/src/voice/segmented-speech-playback.ts`
and `progressive-speech-playback.ts`. [Reply streaming](./replyStreaming.md)
owns the written reply. [Voice input](../voiceEndpoint.md) owns the
microphone and turn endpoint.

## Story: Hear the current reply and stop it at any time

### The owned utterance completes after both end of input and end of playback

Grace uses the attachment mode of the segmented player. The player's
required change callback reports preparing, playing, waiting and idle.
With one segment in flight, another direct `speak` call leaves that
segment alone. Grace's higher-level new reply explicitly stops the old
owner first. Input readiness is one-shot. A rendered speed that is null
uses the neutral factor. An explicitly invalid speed fails with
`invalid-audio`. The preferred rate divided by the rendered speed is
sent to the same audio element. A play rejection or media error fails
with `playback`.

The attachment's `loaded` receipt is the explicit input end. If it
arrives without valid readiness, the player fails. Audio may end before
loaded, in which case the player waits with its caption and no highlight.
Loaded may arrive first, in which case the current audio keeps playing.
Either order releases the completed segment. A pause, seek or buffering
event clears the highlighted word. A new playing event can restore it
from valid alignment and the current media time. Frame timing validation
and word lookup are producer port inputs to this machine.

The schedules use representative attempt IDs. A callback from a retired
attempt cannot adopt a player, start audio, advance the sentence or change
the displayed state. Stop advances ownership immediately and clears the
player and display. Cleanup pauses before detaching, and releases a
retained URL even if another cleanup operation throws. The completion
observer runs for the current operation after cleanup. If a late
`play()` resolution belongs to a retired player, it pauses that player.

```quint
type AudioPhase = IdleAudio | PreparingAudio | WaitingAudio | PlayingAudio
type AudioResult = NoAudioResult | SegmentDone | InvalidAudio | FailedAudio | AudioStopped
type AudioSignal = ReadyWithSpeed | ReadyWithNeutralSpeed | ReadyWithInvalidSpeed | LoadedInput |
  EndedPlayback | StartedPlayback | WaitingPlayback | FailedPlayback
type AudioState = { ticket: int, phase: AudioPhase, ready: bool, loaded: bool, ended: bool, result: AudioResult }
pure val initial: AudioState = { ticket: 0, phase: IdleAudio, ready: false, loaded: false, ended: false, result: NoAudioResult }
pure def liveAudio(s: AudioState): bool = s.phase != IdleAudio
pure def closeAudio(s: AudioState, finalAudio: AudioResult): AudioState =
  { ...initial, ticket: s.ticket, result: finalAudio }
pure def canPrepareAudio(s: AudioState, hasText: bool): bool = not(liveAudio(s)) and hasText
pure def prepareAudio(s: AudioState, hasText: bool): AudioState =
  { ...initial, ticket: s.ticket + 1, phase: PreparingAudio }
pure def canStopAudio(s: AudioState): bool = liveAudio(s)
pure def stopAudio(s: AudioState): AudioState =
  { ...closeAudio(s, AudioStopped), ticket: s.ticket + 1 }
type AudioObservation = { currentTicket: bool, signal: AudioSignal }
pure val readyAudio: AudioObservation = { currentTicket: true, signal: ReadyWithSpeed }
pure val audioObservationValues = Set(readyAudio, { ...readyAudio, signal: ReadyWithNeutralSpeed },
  { ...readyAudio, signal: ReadyWithInvalidSpeed }, { ...readyAudio, signal: LoadedInput },
  { ...readyAudio, signal: EndedPlayback }, { ...readyAudio, signal: StartedPlayback },
  { ...readyAudio, signal: WaitingPlayback }, { ...readyAudio, signal: FailedPlayback },
  { ...readyAudio, currentTicket: false }, { currentTicket: false, signal: LoadedInput },
  { currentTicket: false, signal: EndedPlayback })
pure def canObserveAudio(s: AudioState): bool = liveAudio(s)
pure def observeAudio(s: AudioState, audioObservation: AudioObservation): AudioState = {
  val audioSignal = audioObservation.signal
  if (not(audioObservation.currentTicket)) s
  else match audioSignal {
    | ReadyWithSpeed => { ...s, ready: true }
    | ReadyWithNeutralSpeed => { ...s, ready: true }
    | ReadyWithInvalidSpeed => if (s.ready) s else closeAudio(s, InvalidAudio)
    | LoadedInput => if (not(s.ready)) closeAudio(s, InvalidAudio)
        else if (s.ended) closeAudio(s, SegmentDone) else { ...s, loaded: true }
    | EndedPlayback => if (s.loaded) closeAudio(s, SegmentDone)
        else { ...s, ended: true, phase: WaitingAudio }
    | StartedPlayback => if (s.ready and not(s.ended)) { ...s, phase: PlayingAudio } else s
    | WaitingPlayback => { ...s, phase: WaitingAudio }
    | FailedPlayback => closeAudio(s, FailedAudio)
  }
}
pure def alwaysLiveAudioOwnsTicket(s: AudioState): bool =
  s.ticket >= 0 and (liveAudio(s) implies s.ticket > 0 and s.result == NoAudioResult)
pure def alwaysInputReceiptFollowsReadiness(s: AudioState): bool =
  (s.loaded implies s.ready) and (s.phase == PlayingAudio implies s.ready and not(s.ended))
pure def alwaysCleanedAudioRetainsNoMilestones(s: AudioState): bool =
  not(liveAudio(s)) implies not(s.ready or s.loaded or s.ended)
pure def stepCleanCompletionNeedsBothReceipts(before: AudioState, via: str, after: AudioState): bool =
  via == "observeAudio" and after.result == SegmentDone implies before.ready and (before.ended or before.loaded)
pure def sometimesWaitingForInputEnd(s: AudioState): bool = s.ended and not(s.loaded)
pure def sometimesWaitingForPlaybackEnd(s: AudioState): bool = s.loaded and not(s.ended)
pure def sometimesFinishedAudio(s: AudioState): bool = s.result == SegmentDone
pure val weight_observeAudio = 8
```

### The attachment publishes the same audio stream and releases its own media

The attachment negotiates MediaSource support for MP3. It subscribes
before assigning a MediaSource URL and waits for each nonempty append
before reporting that frame. The first nonempty appended frame can
report readiness before input ends. Without supported MediaSource,
the complete clip comes from the same upstream stream and readiness
waits for explicit EOF. For either route, the completion receipt carries
the ordered frames, full encoded bytes and the source's rendered speed.
Source open, pull and browser append failures propagate. Browser media
waits time out after 30 seconds. Cancellation is idempotent, checks the
signal after blocking work, and cancels the upstream source only when
it has not completed. Release only detaches the player while it still
owns the exact URL. It always revokes its own URL.

```quint
pure def attachmentReady(progressive: bool, firstNonemptyAppend: bool, reachedEof: bool, stillOwned: bool): bool =
  stillOwned and (reachedEof or (progressive and firstNonemptyAppend))
pure def shouldCancelSource(disposed: bool, completed: bool): bool =
  not(disposed or completed)
pure def shouldDetachPlayer(exactUrl: bool, disposing: bool): bool =
  exactUrl and disposing
pure def lawFallbackReadyNeedsExplicitEnd(firstNonemptyAppend: bool, stillOwned: bool): bool =
  not(attachmentReady(false, firstNonemptyAppend, false, stillOwned))
pure def lawDoneSourceAvoidsCancel(disposed: bool): bool =
  not(shouldCancelSource(disposed, true))
```

The pinned producer `run-progressive-speech.mjs` verifies real Chromium
MediaSource and complete-clip playback with a synthetic MP3, held EOF,
cancellation during a held pull and a source failure. Grace's
`speech-load-ahead.test.mjs` drives the product scheduler with controlled
player and service ports. Device audio, live synthesis and the separate
speech timing provider remain external evidence.
