# Voice assistant playback ownership and heard receipts

Alpha's staged `packages/voice/src/voice-assistant-session.ts` owns
ordered sentence playback for one reply. Its pinned
`VoiceAssistantSpeechPump.qnt` checks streamed prefixes, confirmed
suffixes, earlier playback failure and terminal callback fences.
The implementation `playSentence` publishes first-audio on a
current callback and advances the heard prefix only after guarded
playback completion. `reportInterrupted` reports heard and unheard
text, and `release` waits for both the send/ack continuation and
the drained playback promises before asking capture to reopen.

## Story: Preserve only the playback the listener actually heard

### Receipts count completed contiguous playback rather than queued work

The active turn may hand off a streamed prefix before confirmation.
The host verifies that the confirmed reply preserves any handed
prefix before it supplies the rest. At most one current playback and
one later sentence are handed ahead. A later completion cannot fill
a gap left by failure. The model counts sentence identities and
requires original text association at the speaker port. The earlier
source Quint used three sentence IDs; this model allows any
nonnegative plan length.

```quint
type ReplyPhase = OwnedReply | PlayedReply | InterruptedReply | FailedReply
type Playback = {
  phase: ReplyPhase, planned: int, handed: int, heard: int, finished: int,
  confirmed: bool, audible: bool, playbackFailed: bool, activeAudible: bool,
  emittedReceipt: bool, heardReceipt: int, unheardReceipt: int, requestDrained: bool, reopened: bool
}
pure val initial: Playback = {
  phase: OwnedReply, planned: 0, handed: 0, heard: 0, finished: 0,
  confirmed: false, audible: false, playbackFailed: false, activeAudible: false,
  emittedReceipt: false, heardReceipt: 0, unheardReceipt: 0, requestDrained: false, reopened: false
}
pure def canAppendStreamed(s: Playback): bool =
  s.phase == OwnedReply and not(s.confirmed) and not(s.playbackFailed)
pure def appendStreamed(s: Playback): Playback = { ...s, planned: s.planned + 1 }
pure def canConfirmPlayPlan(s: Playback, sentenceCount: int): bool =
  s.phase == OwnedReply and not(s.confirmed) and sentenceCount >= s.planned
pure def confirmPlayPlan(s: Playback, sentenceCount: int): Playback =
  { ...s, planned: sentenceCount, confirmed: true }
pure val sentenceCountValues = Set(0, 1, 2, 3, 4)
pure def canHandSentence(s: Playback): bool =
  s.phase == OwnedReply and not(s.playbackFailed) and s.handed < s.planned and
  (s.handed == s.finished or (s.handed == s.finished + 1 and s.activeAudible))
pure def handSentence(s: Playback): Playback = { ...s, handed: s.handed + 1 }
pure def canStartAudio(s: Playback): bool = s.phase == OwnedReply and s.finished < s.handed and not(s.activeAudible)
pure def startAudio(s: Playback): Playback = { ...s, audible: true, activeAudible: true }
pure def canFinishAudio(s: Playback): bool = s.phase == OwnedReply and s.finished < s.handed
pure def finishAudio(s: Playback, played: bool): Playback =
  { ...s, finished: s.finished + 1, playbackFailed: s.playbackFailed or not(played), activeAudible: false,
    heard: if (played and s.finished == s.heard) s.heard + 1 else s.heard }
pure def alwaysPlaybackOrdered(s: Playback): bool =
  s.planned >= 0 and s.heard >= 0 and s.heard <= s.finished and s.finished <= s.handed and
  s.handed <= s.planned and s.handed - s.finished <= 2
pure def sometimesLookaheadQueued(s: Playback): bool = s.handed - s.finished == 2
```

### Terminal receipts are fixed and capture reopens after work drains

Completed playback requires a confirmed plan and its entire heard
prefix. Cancellation or failure before confirmation publishes a
receipt only if playback already became audible. A failure after
confirmation always publishes its partition. Late platform outcomes
release pending calls without changing what was heard. A capture
reopen after normal completion or interruption waits for the
request and audio to drain, then defers to the capture owner for
mute, binding and session permission.

```quint
pure def terminalReply(phase: ReplyPhase, s: Playback): Playback = {
  val receipt = s.confirmed or s.audible
  { ...s, phase: phase, emittedReceipt: receipt,
    heardReceipt: if (receipt) s.heard else 0,
    unheardReceipt: if (receipt) s.planned - s.heard else 0 }
}
pure def canCompleteReply(s: Playback): bool =
  s.phase == OwnedReply and s.confirmed and not(s.playbackFailed) and s.heard == s.planned
pure def completeReply(s: Playback): Playback = terminalReply(PlayedReply, s)
pure def canInterruptReply(s: Playback): bool = s.phase == OwnedReply
pure def interruptReply(s: Playback): Playback = terminalReply(InterruptedReply, s)
pure def canFailReply(s: Playback): bool = s.phase == OwnedReply
pure def failReply(s: Playback): Playback = terminalReply(FailedReply, s)
pure def canDrainRetiredAudio(s: Playback): bool = s.phase != OwnedReply and s.finished < s.handed
pure def drainRetiredAudio(s: Playback): Playback = { ...s, finished: s.finished + 1, activeAudible: false }
pure def canSettleTurnRequest(s: Playback): bool = not(s.requestDrained)
pure def settleTurnRequest(s: Playback): Playback = { ...s, requestDrained: true }
pure def canRequestCaptureAgain(s: Playback, ownerAllows: bool): bool =
  (s.phase == PlayedReply or s.phase == InterruptedReply) and s.requestDrained and
  s.finished == s.handed and not(s.reopened) and ownerAllows
pure def requestCaptureAgain(s: Playback, ownerAllows: bool): Playback = { ...s, reopened: true }
pure def alwaysReceiptMatchesHeardPrefix(s: Playback): bool =
  s.emittedReceipt implies s.phase != OwnedReply and s.heardReceipt == s.heard and s.unheardReceipt == s.planned - s.heard
pure def alwaysCompletedPlayedEverything(s: Playback): bool =
  s.phase == PlayedReply implies s.emittedReceipt and s.confirmed and s.heard == s.planned
pure def alwaysReopeningFollowsBothDrains(s: Playback): bool =
  s.reopened implies s.requestDrained and s.finished == s.handed and (s.phase == PlayedReply or s.phase == InterruptedReply)
pure def stepLatePlaybackCannotAddHeard(before: Playback, after: Playback): bool =
  before.phase != OwnedReply implies after.phase == before.phase and after.heard == before.heard and
  after.heardReceipt == before.heardReceipt and after.unheardReceipt == before.unheardReceipt
pure def sometimesPlaybackCompleted(s: Playback): bool = s.phase == PlayedReply and s.heard > 0
pure def sometimesInterruptedPartition(s: Playback): bool =
  s.phase == InterruptedReply and s.heardReceipt > 0 and s.unheardReceipt > 0
pure def sometimesPlaybackReopens(s: Playback): bool = s.reopened and s.heard > 0
```
