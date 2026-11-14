# Grace speech preview scheduling and final coverage

Grace `48b43b9c` implements its preview timing in
`apps/app/shared/verified/speech-window.ts` and
`apps/app/src/speech-preview-window.ts`. It applies that policy to
[Eliza's cumulative microphone snapshots](./cumulativeMicrophone.md).
[Recorded transcription](./recordedTranscription.md) owns the final
recording fallback and review callback.

## Story: See current words during speech and send the whole utterance once

### Speaking permits one upload and an owned silence permits one additional upload

The scheduling clock is in integer milliseconds. A missing observation
uses -1. The endpoint's last speech time wins over last soft sound when
speech has been observed. A pause begins after 400 ms of quiet. While
speaking, the scheduler allows at most one upload in flight, spaced at
least 2 seconds from the previous offer. A pause can authorize a second
in-flight upload and marks that exact silence as used. An empty or
failed response still releases an upload slot. The host calls settlement
once for each admitted upload.

The meter may ask for a pause snapshot once per new silence when the
stored samples can cover the last soft sound by a 300 ms tail plus the
128 ms worklet block. This reserves an ask, without using the silence
or allocating an upload yet. The actual offered snapshot still has
to pass the upload gate. With the meter active, a timer offer defers
while that tail is unavailable, then may accept a late tick at 800 ms
from the last endpoint sound. This covers noisy rooms where no meter
ask arrives. Without the meter, the quiet threshold alone applies.

```quint
type PreviewWindowSchedule = { pendingPreviews: int, sentAt: int, quietFor: int, asked: int, followsMeter: bool }
type SpeechClockReading = { at: int, lastSound: int, lastSpeech: int }
pure val initial: PreviewWindowSchedule = { pendingPreviews: 0, sentAt: -1, quietFor: -1, asked: -1, followsMeter: false }
pure def speechReadingAdmissible(clockReading: SpeechClockReading): bool =
  clockReading.at >= 0 and clockReading.lastSound >= -1 and clockReading.lastSpeech >= -1
pure def lastHeard(clockReading: SpeechClockReading): int =
  if (clockReading.lastSpeech != -1) clockReading.lastSpeech else clockReading.lastSound
pure def isPause(clockReading: SpeechClockReading): bool =
  lastHeard(clockReading) != -1 and clockReading.at - lastHeard(clockReading) >= 400
pure def enoughTail(clockReading: SpeechClockReading): bool =
  clockReading.lastSound == -1 or clockReading.at - clockReading.lastSound >= 428
pure def followPreviewMeter(s: PreviewWindowSchedule): PreviewWindowSchedule = { ...s, followsMeter: true }
pure def canAskPausePreview(s: PreviewWindowSchedule, clockReading: SpeechClockReading): bool =
  speechReadingAdmissible(clockReading) and isPause(clockReading) and enoughTail(clockReading) and
    s.pendingPreviews < 2 and lastHeard(clockReading) > s.quietFor and lastHeard(clockReading) > s.asked
pure def askPausePreview(s: PreviewWindowSchedule, clockReading: SpeechClockReading): PreviewWindowSchedule =
  { ...s, asked: lastHeard(clockReading) }
pure def canUploadSpeechPreview(s: PreviewWindowSchedule, clockReading: SpeechClockReading): bool =
  speechReadingAdmissible(clockReading) and
  (if (isPause(clockReading)) s.pendingPreviews < 2 and lastHeard(clockReading) > s.quietFor and
    (not(s.followsMeter) or enoughTail(clockReading) or clockReading.at - lastHeard(clockReading) >= 800)
   else s.pendingPreviews == 0 and (s.sentAt == -1 or clockReading.at - s.sentAt >= 2000))
pure def uploadSpeechPreview(s: PreviewWindowSchedule, clockReading: SpeechClockReading): PreviewWindowSchedule =
  { ...s, pendingPreviews: s.pendingPreviews + 1, sentAt: clockReading.at,
    quietFor: if (isPause(clockReading)) lastHeard(clockReading) else s.quietFor }
pure def finishSpeechPreview(s: PreviewWindowSchedule): PreviewWindowSchedule =
  { ...s, pendingPreviews: if (s.pendingPreviews > 0) s.pendingPreviews - 1 else 0 }
pure def alwaysSpeechPreviewSlotsFit(s: PreviewWindowSchedule): bool =
  s.pendingPreviews >= 0 and s.pendingPreviews <= 2 and s.sentAt >= -1 and s.quietFor >= -1 and s.asked >= -1
pure def stepTheSilenceMarkerDoesNotRegress(before: PreviewWindowSchedule, after: PreviewWindowSchedule): bool =
  after.quietFor >= before.quietFor and after.asked >= before.asked
pure def sometimesQuietUploadOverlaps(s: PreviewWindowSchedule): bool = s.pendingPreviews == 2
pure def sometimesMeterAsked(s: PreviewWindowSchedule): bool = s.asked >= 0
pure val clockReadingValues = Set(
  {at: -1, lastSound: -1, lastSpeech: -1}, {at: 0, lastSound: -1, lastSpeech: -1},
  {at: 200, lastSound: 190, lastSpeech: 120}, {at: 439, lastSound: 40, lastSpeech: 40},
  {at: 440, lastSound: 40, lastSpeech: 40}, {at: 467, lastSound: 40, lastSpeech: 40},
  {at: 468, lastSound: 40, lastSpeech: 40}, {at: 840, lastSound: 830, lastSpeech: 40},
  {at: 2440, lastSound: 2430, lastSpeech: 2430})
pure val weight_uploadSpeechPreview = 5
```

### Only a window with the complete sound interval may supply the final transcript

The sample clock retains the earliest estimate of the capture start
from offered snapshots. A later tick does not stretch the audio's
estimated end. The host passes conservatively rounded clock values.
A candidate must be untrimmed, start at least 300 ms before first
sound, and end at least 300 ms after last sound. Missing sound bounds
fail this check. The fallback decision still checks current ownership
and nonblank text, with a wait of at most 1.5 seconds for this preview.
The shape and async settlement of that result belong to the recorded
transcription host.

```quint
type PreviewCoverage = { trimmed: bool, startAt: int, endAt: int, firstSound: int, lastSound: int }
pure def coversSpeech(coverage: PreviewCoverage): bool =
  not(coverage.trimmed) and coverage.firstSound != -1 and coverage.lastSound != -1 and
    coverage.startAt + 300 <= coverage.firstSound and coverage.lastSound + 300 <= coverage.endAt
pure def lawTrimmedPreviewNeverFinal(coverage: PreviewCoverage): bool =
  coverage.trimmed implies not(coversSpeech(coverage))
pure val fullCoverage: PreviewCoverage = { trimmed: false, startAt: 40, endAt: 3000, firstSound: 340, lastSound: 2700 }
pure val coverageValues = Set(fullCoverage, { ...fullCoverage, trimmed: true },
  { ...fullCoverage, startAt: 41 }, { ...fullCoverage, endAt: 2999 }, { ...fullCoverage, lastSound: -1 })
```

The pinned `speech-preview-window.test.mjs` drives these decisions
through Grace's scheduler and clock. Its existing verified TypeScript is
the behavioral baseline for the corresponding Quint rules.
