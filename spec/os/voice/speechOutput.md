# Speech output

The device's own audio output for a spoken reply: a warm-up that keeps the
output path primed with silence before the reply's first samples, the
reply's speech with its audio focus, and the lead trim and first-write
report that make the reply start promptly. Sources are
`SpeechOutputWarmup.java`, `SpeechLeadTrim.java`,
`FirstWriteSpeechOutput.java`, `SpeechAudioFocus.java` and
`SpeechAudioFocusPolicy.java` of the `voice-io` module. The cloud speech
client (`cloudSpeech.md` beside this spec) builds on this machine; speech
engines are the local inference package's. Audio hardware, the platform
focus request and the clock stay in the shell: it reports what it observed
as event parameters.

## Story: Prime the audio output without playing over anything

> As a person waiting for the agent's first spoken reply, I want the audio
> output ready quickly, so that the reply starts at once and no warm-up is
> ever heard over a call or another reply.

Each warm-up worker owns its output handle. Requests, replacement and stops
run on the main thread; the worker opens, plays and writes on its own
thread. The shell also asks for a warm-up only while the voice surface is in
the foreground and no sensitive surface is shown, and stops it when that
ends.

### A warm-up starts only while no reply is speaking and no call holds the audio path

```quint
type WorkerPhase = Opening | Looping | Writing | CleaningUp | Released | NothingOpened
type WarmupWorker = { workerId: int, phase: WorkerPhase, closed: bool, elapsedMs: int }
type Volume = FullVolume | Ducked
type Speech = Silent | Speaking({ utteranceId: int, written: int, volume: Volume })
type AudioMode = NormalAudio | CallAudio
type SpeechOutput = { owner: int, workers: List[WarmupWorker], speech: Speech, mode: AudioMode }
pure val initial: SpeechOutput = { owner: 0, workers: List(), speech: Silent, mode: NormalAudio }
pure val idValues = Set(1, 2, 3)
pure val noWorker: WarmupWorker = { workerId: 0, phase: NothingOpened, closed: true, elapsedMs: 0 }
pure def isSilent(speech: Speech): bool = match speech { | Silent => true | _ => false }
pure def workerOf(id: int, s: SpeechOutput): WarmupWorker = s.workers.select(x => x.workerId == id).nthOr(0, noWorker)
pure def launched(id: int, s: SpeechOutput): bool = s.workers.some(x => x.workerId == id)
pure def retire(owner: int, workers: List[WarmupWorker]): List[WarmupWorker] = workers.listMap(x => if (x.workerId == owner) { ...x, closed: true } else x)
pure def updateWorker(id: int, s: SpeechOutput, change: WarmupWorker): SpeechOutput = { ...s, workers: s.workers.listMap(x => if (x.workerId == id) change else x) }
pure def canRequestWarmup(s: SpeechOutput, id: int): bool = id > 0 and not(launched(id, s)) and isSilent(s.speech) and s.mode == NormalAudio
pure def alwaysWarmupOnlyWhileIdle(s: SpeechOutput): bool = s.owner != 0 implies (isSilent(s.speech) and s.mode == NormalAudio)
```

### Replacing or stopping a warm-up retires its worker

A new request makes the new worker the owner and closes the one it
replaces; a stop closes the owner and leaves none.

```quint
pure def requestWarmup(s: SpeechOutput, id: int): SpeechOutput =
  { ...s, owner: id, workers: retire(s.owner, s.workers).append({ workerId: id, phase: Opening, closed: false, elapsedMs: 0 }) }
pure def canStopWarmup(s: SpeechOutput): bool = s.owner != 0
pure def stopWarmup(s: SpeechOutput): SpeechOutput = { ...s, owner: 0, workers: retire(s.owner, s.workers) }
pure def alwaysOnlyTheOwnerIsOpen(s: SpeechOutput): bool = s.workers.every(x => x.workerId != s.owner implies x.closed)
```

### Each warm-up worker keeps its own id

A close reaches only the worker it names, so an id is never reused.

```quint
pure def alwaysWorkerIdsAreUnique(s: SpeechOutput): bool = s.workers.every(x => x.workerId > 0 and s.workers.select(y => y.workerId == x.workerId).length() == 1)
```

### A retired worker never starts playing

The worker checks that it is still open, publishes its output handle and
starts playing in one step a concurrent close cannot split. An output that
opens after its worker was retired goes straight to cleanup; one that fails
to open leaves nothing to release.

```quint
type OpenOutcome = OutputMissing | OutputOpened | PlayFailed
pure def canOpenWarmup(s: SpeechOutput, id: int): bool = workerOf(id, s).phase == Opening
pure def openWarmup(s: SpeechOutput, id: int, opened: OpenOutcome): SpeechOutput = {
  val worker = workerOf(id, s)
  val nextPhase = if (opened == OutputMissing) NothingOpened else if (opened == OutputOpened and not(worker.closed)) Looping else CleaningUp
  updateWorker(id, s, { ...worker, phase: nextPhase })
}
pure def startedPlaying(before: SpeechOutput, x: WarmupWorker): bool = workerOf(x.workerId, before).phase == Opening and x.phase == Looping
pure def stepRetiredWorkerNeverStartsPlaying(before: SpeechOutput, after: SpeechOutput): bool = after.workers.every(x => startedPlaying(before, x) implies not(x.closed))
```

### A worker admits no write once it is retired or has run for its time limit

The shell reports the time since the worker started at each turn of its
loop. A write admitted before the close may still finish; the close aborts
it, and a failed write ends the loop.

```quint
pure val warmupLimitMs = 15000
pure val elapsedMsValues = Set(0, 14999, 15000)
pure def canCheckWarmupLoop(s: SpeechOutput, id: int, elapsedMs: int): bool = workerOf(id, s).phase == Looping and elapsedMs >= 0
pure def checkWarmupLoop(s: SpeechOutput, id: int, elapsedMs: int): SpeechOutput = {
  val worker = workerOf(id, s)
  updateWorker(id, s, { ...worker, elapsedMs: elapsedMs, phase: if (worker.closed or elapsedMs >= warmupLimitMs) CleaningUp else Writing })
}
pure def canFinishWarmupWrite(s: SpeechOutput, id: int): bool = workerOf(id, s).phase == Writing
pure def finishWarmupWrite(s: SpeechOutput, id: int, written: bool): SpeechOutput = {
  val worker = workerOf(id, s)
  updateWorker(id, s, { ...worker, phase: if (written) Looping else CleaningUp })
}
pure def startedWriting(before: SpeechOutput, x: WarmupWorker): bool = workerOf(x.workerId, before).phase == Looping and x.phase == Writing
pure def stepNoWriteAfterRetireOrTimeout(before: SpeechOutput, after: SpeechOutput): bool =
  after.workers.every(x => startedWriting(before, x) implies (not(x.closed) and x.elapsedMs < warmupLimitMs))
```

### A worker releases its output once, after it stops

```quint
pure def canReleaseWarmup(s: SpeechOutput, id: int): bool = workerOf(id, s).phase == CleaningUp
pure def releaseWarmup(s: SpeechOutput, id: int): SpeechOutput = updateWorker(id, s, { ...workerOf(id, s), phase: Released })
pure def finished(phase: WorkerPhase): bool = phase == Released or phase == NothingOpened
pure def stepOutputReleasedOnce(before: SpeechOutput, after: SpeechOutput): bool =
  after.workers.every(x => x.phase == Released implies (workerOf(x.workerId, before).phase == CleaningUp or workerOf(x.workerId, before).phase == Released))
    and before.workers.every(x => finished(x.phase) implies workerOf(x.workerId, after).phase == x.phase)
```

### A retired worker finishes

```quint
pure val fair_openWarmup = "weak"
pure val fair_checkWarmupLoop = "weak"
pure val fair_finishWarmupWrite = "weak"
pure val fair_releaseWarmup = "weak"
pure def leadsToRetiredWorkerFinishes(s: SpeechOutput, later: SpeechOutput): bool =
  s.workers.every(x => x.closed implies finished(workerOf(x.workerId, later).phase))
```

### A worker can be retired while opening or writing, time out, and release its output

```quint
pure def sometimesRetiredWhileOpening(s: SpeechOutput): bool = s.workers.some(x => x.closed and x.phase == Opening)
pure def sometimesRetiredWhileWriting(s: SpeechOutput): bool = s.workers.some(x => x.closed and x.phase == Writing)
pure def sometimesTimedOut(s: SpeechOutput): bool = s.workers.some(x => not(x.closed) and x.phase == CleaningUp and x.elapsedMs >= warmupLimitMs)
pure def sometimesReleasedAfterRetire(s: SpeechOutput): bool = s.workers.some(x => x.closed and x.phase == Released)
```

## Story: Start a reply's audio promptly without playing over anything

> As a person who asked something, I want the reply's voice to start at its
> first audible sound, so that I hear it at once, and never over a call or
> after another app took the audio.

The shell reads the audio mode before each decision and reports a change
(on Android 12 and later also when the platform announces it). It asks the
platform for transient, duckable focus only when the mode allows speech,
and reports the answer.

### A reply's speech starts only outside a call, with audio focus granted, and retires the warm-up

```quint
type OutputNotice = FirstAudio({ utteranceId: int }) | RefusedCallActive | RefusedFocusDenied | StopPlayback | AbandonFocus | DuckVolume | RestoreVolume | StopCapture
type OutputStep = { state: SpeechOutput, out: List[OutputNotice] }
pure val utteranceIdValues = Set(1, 2)
pure def canStartSpeech(s: SpeechOutput, utteranceId: int): bool = utteranceId > 0 and isSilent(s.speech)
pure def startSpeech(s: SpeechOutput, utteranceId: int, granted: bool): OutputStep =
  if (s.mode == CallAudio) { state: s, out: List(RefusedCallActive) }
  else if (not(granted)) { state: s, out: List(RefusedFocusDenied) }
  else { state: { ...s, owner: 0, workers: retire(s.owner, s.workers), speech: Speaking({ utteranceId: utteranceId, written: 0, volume: FullVolume }) }, out: List() }
pure def sometimesSpeaking(s: SpeechOutput): bool = writtenOf(s.speech) >= 1
```

### A call stops the reply, the warm-up and the assistant's capture

A focus loss the platform reports while the phone is in a call is reported
as the call starting.

```quint
pure def canAudioModeChanged(s: SpeechOutput, mode: AudioMode): bool = mode != s.mode
pure def audioModeChanged(s: SpeechOutput, mode: AudioMode): OutputStep =
  if (mode == NormalAudio) { state: { ...s, mode: mode }, out: List() }
  else {
    state: { ...s, mode: mode, owner: 0, workers: retire(s.owner, s.workers), speech: Silent },
    out: if (isSilent(s.speech)) List(StopCapture) else List(StopPlayback, AbandonFocus, StopCapture)
  }
pure def alwaysNoSpeechDuringCall(s: SpeechOutput): bool = s.mode == CallAudio implies isSilent(s.speech)
```

### The first write of an utterance is reported once, and no other write is

The report is made as the first sample is handed to the output, before the
write, so the time to first audio is measured from the write.

```quint
pure def writtenOf(speech: Speech): int = match speech { | Speaking(u) => u.written | _ => -1 }
pure def speakingId(speech: Speech): int = match speech { | Speaking(u) => u.utteranceId | _ => 0 }
pure def canWriteSpeech(s: SpeechOutput): bool = not(isSilent(s.speech))
pure def writeSpeech(s: SpeechOutput): OutputStep = {
  val speech = s.speech
  match speech {
  | Speaking(u) => { state: { ...s, speech: Speaking({ ...u, written: u.written + 1 }) }, out: if (u.written == 0) List(FirstAudio({ utteranceId: u.utteranceId })) else List() }
  | _ => { state: s, out: List() }
  }
}
pure def isFirstAudio(n: OutputNotice): bool = match n { | FirstAudio(f) => f.utteranceId > 0 | _ => false }
pure def stepFirstAudioReportedOnce(before: SpeechOutput, via: str, after: SpeechOutput, out: List[OutputNotice]): bool =
  out.some(n => isFirstAudio(n)) iff (via == "writeSpeech" and writtenOf(before.speech) == 0)
```

### The silent lead of an utterance is dropped, keeping a short pre-roll

Samples below the audible level are held until the first audible one;
playback then starts at most one pre-roll (about 30 ms of samples) before
it, so a soft onset is not clipped. Later samples play untouched, and an
utterance that never becomes audible plays nothing.

```quint
pure def trimStart(firstAudible: int, preRoll: int, samples: int): int =
  if (firstAudible < 0) samples else if (firstAudible > preRoll) firstAudible - preRoll else 0
pure def lawTrimKeepsTheOnset(firstAudible: int, preRoll: int, samples: int): bool = {
  val start = trimStart(firstAudible, preRoll, samples)
  (firstAudible >= 0 and preRoll >= 0) implies (start >= 0 and start <= firstAudible and firstAudible - start <= preRoll and (firstAudible >= preRoll implies firstAudible - start == preRoll))
}
```

### Audio focus is held while a reply speaks and abandoned exactly when it stops

A reply ends on its own, is cancelled by its owner, or is stopped by a
focus loss or a call; each stop abandons the focus request, so a displaced
request never gets focus back with nothing playing.

```quint
pure def canEndSpeech(s: SpeechOutput): bool = not(isSilent(s.speech))
pure def endSpeech(s: SpeechOutput): OutputStep = { state: { ...s, speech: Silent }, out: List(AbandonFocus) }
pure def canCancelSpeech(s: SpeechOutput): bool = not(isSilent(s.speech))
pure def cancelSpeech(s: SpeechOutput): OutputStep = { state: { ...s, speech: Silent }, out: List(StopPlayback, AbandonFocus) }
pure def stepFocusAbandonedWhenSpeechStops(before: SpeechOutput, via: str, after: SpeechOutput, out: List[OutputNotice]): bool =
  (not(isSilent(before.speech)) and isSilent(after.speech)) iff out.includes(AbandonFocus)
```

### A focus loss stops the reply and drops its unplayed audio, and a ducking loss only lowers it

A regain after ducking restores the volume. A focus change while no reply
speaks does nothing.

```quint
type FocusChange = FocusGain | FocusLoss | FocusLossTransient | FocusLossCanDuck
pure def canFocusChanged(s: SpeechOutput, change: FocusChange): bool = not(isSilent(s.speech))
pure def focusChanged(s: SpeechOutput, change: FocusChange): OutputStep = {
  val speech = s.speech
  match speech {
  | Speaking(u) =>
    if (change == FocusLoss or change == FocusLossTransient) { state: { ...s, speech: Silent }, out: List(StopPlayback, AbandonFocus) }
    else if (change == FocusLossCanDuck and u.volume == FullVolume) { state: { ...s, speech: Speaking({ ...u, volume: Ducked }) }, out: List(DuckVolume) }
    else if (change == FocusGain and u.volume == Ducked) { state: { ...s, speech: Speaking({ ...u, volume: FullVolume }) }, out: List(RestoreVolume) }
    else { state: s, out: List() }
  | _ => { state: s, out: List() }
  }
}
pure def stepStoppedSpeechDropsItsAudio(before: SpeechOutput, via: str, after: SpeechOutput, out: List[OutputNotice]): bool =
  (not(isSilent(before.speech)) and isSilent(after.speech) and via != "endSpeech") implies out.includes(StopPlayback)
pure def sometimesDucked(s: SpeechOutput): bool = {
  val speech = s.speech
  match speech { | Speaking(u) => u.volume == Ducked | _ => false }
}
```
