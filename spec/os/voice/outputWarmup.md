# Speech output warm-up and lead trim

Before the first spoken reply the device primes its audio output, and each
synthesized utterance starts at its first audible sample. A warm-up worker
opens the audio output and keeps it primed by writing silence until it is
replaced, stopped or times out; admission and replacement run on the main
thread, and each worker owns its own output handle. Publishing a reply
into the playback slot and the streamed-speech bootstrap are
[speech output](../../localInference/speechOutput.md); the sentences a
person heard are [playback](./playback.md). Device audio hardware and the
actual timings are outside this model.

## Story: Prime the audio output without playing over anything

> As a person waiting for the agent's first spoken reply, I want the audio
> output ready quickly, and never a warm-up still writing after it was
> replaced or after a call or another app took the output.

### A warm-up starts only while the output is idle, and replacing it retires the previous worker

Each worker is launched once. Starting a new one makes it the owner and
closes the one it replaces. Stopping for a busy output, the background, a
call or teardown closes the owner and leaves none.

```quint
type OutputMode = ModeIdle | ModeBusy | ModeBackground | ModeCall | ModeDestroyed
type WorkerPhase = Opening | Opened | Looping | Writing | CleaningUp | WorkerDone
type WarmupWorker = { workerId: int, workerPhase: WorkerPhase, closed: bool, age: int, writes: int, releases: int }
type Warmup = { owner: int, mode: OutputMode, workers: List[WarmupWorker], unsafePlay: bool }
pure val initial: Warmup = { owner: 0, mode: ModeIdle, workers: List(), unsafePlay: false }
pure val warmupTimeoutTicks = 2
pure val idValues = Set(1, 2, 3)
pure def workerOf(id: int, w: Warmup): WarmupWorker =
  w.workers.select(x => x.workerId == id).nthOr(0, { workerId: 0, workerPhase: WorkerDone, closed: true, age: 0, writes: 0, releases: 0 })
pure def launched(id: int, w: Warmup): bool = w.workers.some(x => x.workerId == id)
pure def retiredWorkers(owner: int, workers: List[WarmupWorker]): List[WarmupWorker] =
  workers.listMap(x => if (x.workerId == owner) { ...x, closed: true } else x)
pure def updateWorker(id: int, w: Warmup, change: WarmupWorker): Warmup =
  { ...w, workers: w.workers.listMap(x => if (x.workerId == id) change else x) }
pure def canRequestWarmup(w: Warmup, id: int): bool = w.mode == ModeIdle and not(launched(id, w))
pure def requestWarmup(w: Warmup, id: int): Warmup =
  { ...w, owner: id, workers: retiredWorkers(w.owner, w.workers).append({ workerId: id, workerPhase: Opening, closed: false, age: 0, writes: 0, releases: 0 }) }
pure def canStopWarmup(w: Warmup, mode: OutputMode): bool = w.mode != ModeDestroyed
pure def stopWarmup(w: Warmup, mode: OutputMode): Warmup = { ...w, workers: retiredWorkers(w.owner, w.workers), mode: mode, owner: 0 }
pure def alwaysOnlyAnIdleOutputHasAnOwner(w: Warmup): bool = w.owner == 0 or w.mode == ModeIdle
pure def alwaysReplacedWorkersAreClosed(w: Warmup): bool = w.workers.every(x => x.workerId != w.owner implies x.closed)
```

### A retired worker never starts playing

The worker checks that it is still open, publishes its exact output handle
and starts playing in one step that a concurrent close cannot interrupt.
An open that completes after its worker was retired goes straight to
cleanup.

```quint
pure def canOpenWarmup(w: Warmup, id: int): bool = workerOf(id, w).workerPhase == Opening
pure def openWarmup(w: Warmup, id: int, success: bool): Warmup =
  updateWorker(id, w, { ...workerOf(id, w), workerPhase: if (success) Opened else WorkerDone })
pure def canPlayWarmup(w: Warmup, id: int): bool = workerOf(id, w).workerPhase == Opened
pure def playWarmup(w: Warmup, id: int, success: bool): Warmup = {
  val worker = workerOf(id, w)
  val played = updateWorker(id, w, { ...worker, workerPhase: if (worker.closed or not(success)) CleaningUp else Looping })
  { ...played, unsafePlay: w.unsafePlay or (not(worker.closed) and w.owner != id) }
}
pure def alwaysNoRetiredWorkerPlays(w: Warmup): bool = not(w.unsafePlay)
```

### A worker stops writing once closed or timed out, and releases its output once

A write already admitted when the close arrives may still finish, but no
further write is admitted. The worker times out after two clock ticks. Its
output is released by exactly one attempt; an open that failed has nothing
to release.

```quint
pure def canCheckWarmupLoop(w: Warmup, id: int): bool = workerOf(id, w).workerPhase == Looping
pure def checkWarmupLoop(w: Warmup, id: int): Warmup = {
  val worker = workerOf(id, w)
  updateWorker(id, w, { ...worker, workerPhase: if (worker.closed or worker.age >= warmupTimeoutTicks) CleaningUp else Writing })
}
pure def canFinishWarmupWrite(w: Warmup, id: int): bool = workerOf(id, w).workerPhase == Writing
pure def finishWarmupWrite(w: Warmup, id: int, success: bool): Warmup = {
  val worker = workerOf(id, w)
  updateWorker(id, w, { ...worker, workerPhase: if (success) Looping else CleaningUp, writes: worker.writes + 1 })
}
pure def canTickWarmup(w: Warmup, id: int): bool =
  (workerOf(id, w).workerPhase == Looping or workerOf(id, w).workerPhase == Writing) and workerOf(id, w).age < warmupTimeoutTicks
pure def tickWarmup(w: Warmup, id: int): Warmup = updateWorker(id, w, { ...workerOf(id, w), age: workerOf(id, w).age + 1 })
pure def canReleaseWarmup(w: Warmup, id: int): bool = workerOf(id, w).workerPhase == CleaningUp
pure def releaseWarmup(w: Warmup, id: int): Warmup = updateWorker(id, w, { ...workerOf(id, w), workerPhase: WorkerDone, releases: workerOf(id, w).releases + 1 })
pure def alwaysOutputReleasedAtMostOnce(w: Warmup): bool = w.workers.every(x => x.releases <= 1)
```

### An unfinished worker has released nothing

A worker's output is released only as the worker finishes, so a worker
still opening, playing, writing or cleaning up has released nothing yet.

```quint
pure def alwaysUnfinishedWorkerReleasedNothing(w: Warmup): bool =
  w.workers.every(x => x.workerPhase != WorkerDone implies x.releases == 0)
```

### A retired worker finishes

```quint
pure val fair_openWarmup = "weak"
pure val fair_playWarmup = "weak"
pure val fair_checkWarmupLoop = "weak"
pure val fair_finishWarmupWrite = "weak"
pure val fair_releaseWarmup = "weak"
pure def leadsToRetiredWorkerFinishes(w: Warmup, later: Warmup): bool =
  w.workers.every(x => x.closed implies workerOf(x.workerId, later).workerPhase == WorkerDone)
```

### A late open can be released without playing, a replaced worker can still be writing, and a worker can time out

```quint
pure def sometimesLateOpenReleasedWithoutPlaying(w: Warmup): bool = w.workers.some(x => x.closed and x.workerPhase == WorkerDone and x.releases == 1 and x.writes == 0)
pure def sometimesReplacedWhileWriting(w: Warmup): bool = w.workers.some(x => x.closed and x.workerPhase == Writing)
pure def sometimesTimedOut(w: Warmup): bool = w.workers.some(x => x.age == warmupTimeoutTicks and x.workerPhase == CleaningUp and not(x.closed))
```

## Story: Start a reply's audio at its first audible sample

> As a person who asked something, I want the reply's voice to start
> without a stretch of silence before it, and without its first syllable
> cut off.

### The silent lead of an utterance is dropped, keeping a short pre-roll

A synthesized utterance often opens with near-silence. Samples below the
audible level are held, not played, until the first audible sample
arrives; playback then starts at most one pre-roll (about 30 ms) before
that sample, so a soft onset is not clipped. Every later sample of the
utterance plays untouched, and an utterance that never becomes audible
plays nothing.

```quint
type LeadTrim = { firstAudible: int, preRoll: int, length: int }
pure def trimStart(trim: LeadTrim): int =
  if (trim.firstAudible < 0) trim.length
  else if (trim.firstAudible > trim.preRoll) trim.firstAudible - trim.preRoll else 0
pure val trimValues = Set({ firstAudible: -1, preRoll: 480, length: 9600 }, { firstAudible: 0, preRoll: 480, length: 9600 },
  { firstAudible: 300, preRoll: 480, length: 9600 }, { firstAudible: 7200, preRoll: 480, length: 9600 })
pure def lawSilentUtterancePlaysNothing(trim: LeadTrim): bool = trim.firstAudible < 0 implies trimStart(trim) == trim.length
pure def lawOnsetKeepsItsPreRoll(trim: LeadTrim): bool =
  trim.firstAudible >= 0 and trim.preRoll >= 0 implies
    trimStart(trim) >= 0 and trimStart(trim) <= trim.firstAudible and trim.firstAudible - trimStart(trim) <= trim.preRoll
```

### The first write to the output is reported once

The output reports the moment it is handed the first sample of an
utterance, before that write, and never again for the same utterance, so
the time to first audio is measured from the write and not after it.

```quint
type FirstWrite = { writes: int, reports: int }
pure def outputWrite(first: FirstWrite): FirstWrite =
  { writes: first.writes + 1, reports: first.reports + (if (first.writes == 0) 1 else 0) }
pure val firstValues = Set({ writes: 0, reports: 0 }, { writes: 1, reports: 1 }, { writes: 5, reports: 1 })
pure def lawFirstWriteReportedOnce(first: FirstWrite): bool =
  first.writes >= 0 and first.reports == (if (first.writes > 0) 1 else 0) implies outputWrite(first).reports == 1
```
