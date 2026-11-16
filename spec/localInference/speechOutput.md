# Speech output

The device speaks the agent's replies through three parts that share no
state with one another, modeled side by side in one machine:

- **Publication.** A synthesized clip is prepared off the main thread and
  published on it into the one playback slot, which is empty, holds a
  prepared clip, or plays a stream.
- **Warm-up.** Before the first reply, a warm-up worker opens the audio
  output and keeps it primed by writing silence, until it is replaced,
  stopped or times out. Admission and replacement run on the main thread;
  each worker owns its own output handle.
- **Bootstrap.** Streamed speech starts with three requests to the same
  authorized origin (consent, session, then the socket upgrade), which
  reuse one connection whenever the protocol and the server allow it.

Device audio hardware, the actual timings and network latency are outside
this model.

## Story: Speak a reply without cutting off what is playing

> As a person talking to the agent on my device, I want a new reply to
> play only when nothing else is playing or when it is meant to replace
> what is, and never to hear a stale or cancelled reply.

### A prepared reply is published into the playback slot only if it may take it

The request is admitted with whether it replaces what is playing. At
publication, a cancelled request publishes nothing; a request that does
not replace finds the slot busy if anything is playing; otherwise the clip
takes the slot, interrupting what played before. A settled request makes
room for the next one.

```quint
type Playback = EmptyPlayback | PreparedClip | StreamPlayback
type PublishPhase = PublishIdle | PublishAdmitted | PublishBusy | Published | PublishCancelled
type Publication = { playback: Playback, publishPhase: PublishPhase, replace: bool, cancelRequested: bool, playbackAtPublication: Playback, interrupted: bool }
type OutputMode = ModeIdle | ModeBusy | ModeBackground | ModeCall | ModeDestroyed
type WorkerPhase = Opening | Opened | Looping | Writing | CleaningUp | WorkerDone
type WarmupWorker = { workerId: int, workerPhase: WorkerPhase, closed: bool, age: int, writes: int, releases: int }
type Warmup = { owner: int, mode: OutputMode, workers: List[WarmupWorker], unsafePlay: bool }
type Bootstrap = { started: bool, stage: int, http1: bool, keepAlive: bool, connections: int, pending: bool, stopped: bool }
type SpeechOutput = { publication: Publication, warmup: Warmup, bootstrap: Bootstrap }
pure val initial: SpeechOutput = {
  publication: { playback: EmptyPlayback, publishPhase: PublishIdle, replace: false, cancelRequested: false, playbackAtPublication: EmptyPlayback, interrupted: false },
  warmup: { owner: 0, mode: ModeIdle, workers: List(), unsafePlay: false },
  bootstrap: { started: false, stage: 0, http1: false, keepAlive: false, connections: 0, pending: false, stopped: false }
}
pure def requestSettled(phase: PublishPhase): bool = phase == PublishIdle or phase == PublishBusy or phase == Published or phase == PublishCancelled
pure def canAdmitSpeech(s: SpeechOutput, replace: bool): bool = requestSettled(s.publication.publishPhase)
pure def admitSpeech(s: SpeechOutput, replace: bool): SpeechOutput =
  { ...s, publication: { ...s.publication, publishPhase: PublishAdmitted, replace: replace, cancelRequested: false, interrupted: false } }
pure def canChangePlayback(s: SpeechOutput, kind: Playback): bool = s.publication.publishPhase == PublishIdle or s.publication.publishPhase == PublishAdmitted
pure def changePlayback(s: SpeechOutput, kind: Playback): SpeechOutput = { ...s, publication: { ...s.publication, playback: kind } }
pure def canCancelSpeech(s: SpeechOutput): bool = s.publication.publishPhase == PublishAdmitted
pure def cancelSpeech(s: SpeechOutput): SpeechOutput = { ...s, publication: { ...s.publication, cancelRequested: true } }
pure def canPublishSpeech(s: SpeechOutput): bool = s.publication.publishPhase == PublishAdmitted
pure def publishSpeech(s: SpeechOutput): SpeechOutput = {
  val p = s.publication
  val resolved =
    if (p.cancelRequested) { ...p, publishPhase: PublishCancelled, playbackAtPublication: p.playback }
    else if (p.playback != EmptyPlayback and not(p.replace)) { ...p, publishPhase: PublishBusy, playbackAtPublication: p.playback }
    else { ...p, publishPhase: Published, playback: PreparedClip, playbackAtPublication: p.playback, interrupted: p.playback != EmptyPlayback }
  { ...s, publication: resolved }
}
```

### A busy or cancelled publication leaves what is playing untouched

```quint
pure def alwaysRefusedPublicationKeepsPlayback(s: SpeechOutput): bool =
  (s.publication.publishPhase == PublishBusy or s.publication.publishPhase == PublishCancelled) implies s.publication.playback == s.publication.playbackAtPublication
```

### Only a replacing, uncancelled reply interrupts what was playing

```quint
pure def alwaysInterruptsOnlyWithReplacement(s: SpeechOutput): bool =
  s.publication.interrupted implies (s.publication.publishPhase == Published and s.publication.replace and not(s.publication.cancelRequested))
```

### An admitted reply is settled

```quint
pure val fair_publishSpeech = "weak"
pure def leadsToPublicationSettles(s: SpeechOutput, later: SpeechOutput): bool =
  s.publication.publishPhase == PublishAdmitted implies later.publication.publishPhase != PublishAdmitted
```

### A reply can interrupt what plays, find the slot busy, or be cancelled while a stream plays

```quint
pure def sometimesReplacementInterrupts(s: SpeechOutput): bool = s.publication.interrupted
pure def sometimesBusyKeepsTheStream(s: SpeechOutput): bool = s.publication.publishPhase == PublishBusy and s.publication.playback == StreamPlayback
pure def sometimesCancelledKeepsTheStream(s: SpeechOutput): bool = s.publication.publishPhase == PublishCancelled and s.publication.playback == StreamPlayback
```

## Story: Prime the audio output without playing over anything

> As a person waiting for the agent's first spoken reply, I want the audio
> output ready quickly, and never a warm-up still writing after it was
> replaced or after a call or another app took the output.

### A warm-up starts only while the output is idle, and replacing it retires the previous worker

Each worker is launched once. Starting a new one makes it the owner and
closes the one it replaces. Stopping for a busy output, the background, a
call or teardown closes the owner and leaves none.

```quint
pure val warmupTimeoutTicks = 2
pure val idValues = Set(1, 2, 3)
pure def workerOf(id: int, s: SpeechOutput): WarmupWorker =
  s.warmup.workers.select(w => w.workerId == id).nthOr(0, { workerId: 0, workerPhase: WorkerDone, closed: true, age: 0, writes: 0, releases: 0 })
pure def launched(id: int, s: SpeechOutput): bool = s.warmup.workers.some(w => w.workerId == id)
pure def retireOwner(w: Warmup): Warmup = { ...w, workers: w.workers.listMap(x => if (x.workerId == w.owner) { ...x, closed: true } else x) }
pure def updateWorker(id: int, s: SpeechOutput, change: WarmupWorker): SpeechOutput =
  { ...s, warmup: { ...s.warmup, workers: s.warmup.workers.listMap(x => if (x.workerId == id) change else x) } }
pure def canRequestWarmup(s: SpeechOutput, id: int): bool = s.warmup.mode == ModeIdle and not(launched(id, s))
pure def requestWarmup(s: SpeechOutput, id: int): SpeechOutput = {
  val retired = retireOwner(s.warmup)
  { ...s, warmup: { ...retired, owner: id, workers: retired.workers.append({ workerId: id, workerPhase: Opening, closed: false, age: 0, writes: 0, releases: 0 }) } }
}
pure def canStopWarmup(s: SpeechOutput, mode: OutputMode): bool = s.warmup.mode != ModeDestroyed
pure def stopWarmup(s: SpeechOutput, mode: OutputMode): SpeechOutput = { ...s, warmup: { ...retireOwner(s.warmup), mode: mode, owner: 0 } }
pure def alwaysOnlyAnIdleOutputHasAnOwner(s: SpeechOutput): bool = s.warmup.owner == 0 or s.warmup.mode == ModeIdle
pure def alwaysReplacedWorkersAreClosed(s: SpeechOutput): bool = s.warmup.workers.every(w => w.workerId != s.warmup.owner implies w.closed)
```

### A retired worker never starts playing

The worker checks that it is still open, publishes its exact output handle
and starts playing in one step that a concurrent close cannot interrupt.
An open that completes after its worker was retired goes straight to
cleanup.

```quint
pure def canOpenWarmup(s: SpeechOutput, id: int): bool = workerOf(id, s).workerPhase == Opening
pure def openWarmup(s: SpeechOutput, id: int, success: bool): SpeechOutput =
  updateWorker(id, s, { ...workerOf(id, s), workerPhase: if (success) Opened else WorkerDone })
pure def canPlayWarmup(s: SpeechOutput, id: int): bool = workerOf(id, s).workerPhase == Opened
pure def playWarmup(s: SpeechOutput, id: int, success: bool): SpeechOutput = {
  val w = workerOf(id, s)
  val played = updateWorker(id, s, { ...w, workerPhase: if (w.closed or not(success)) CleaningUp else Looping })
  { ...played, warmup: { ...played.warmup, unsafePlay: s.warmup.unsafePlay or (not(w.closed) and s.warmup.owner != id) } }
}
pure def alwaysNoRetiredWorkerPlays(s: SpeechOutput): bool = not(s.warmup.unsafePlay)
```

### A worker stops writing once closed or timed out, and releases its output once

A write already admitted when the close arrives may still finish, but no
further write is admitted. The worker times out after two clock ticks. Its
output is released by exactly one attempt; an open that failed has nothing
to release.

```quint
pure def canCheckWarmupLoop(s: SpeechOutput, id: int): bool = workerOf(id, s).workerPhase == Looping
pure def checkWarmupLoop(s: SpeechOutput, id: int): SpeechOutput = {
  val w = workerOf(id, s)
  updateWorker(id, s, { ...w, workerPhase: if (w.closed or w.age >= warmupTimeoutTicks) CleaningUp else Writing })
}
pure def canFinishWarmupWrite(s: SpeechOutput, id: int): bool = workerOf(id, s).workerPhase == Writing
pure def finishWarmupWrite(s: SpeechOutput, id: int, success: bool): SpeechOutput = {
  val w = workerOf(id, s)
  updateWorker(id, s, { ...w, workerPhase: if (success) Looping else CleaningUp, writes: w.writes + 1 })
}
pure def canTickWarmup(s: SpeechOutput, id: int): bool =
  (workerOf(id, s).workerPhase == Looping or workerOf(id, s).workerPhase == Writing) and workerOf(id, s).age < warmupTimeoutTicks
pure def tickWarmup(s: SpeechOutput, id: int): SpeechOutput = updateWorker(id, s, { ...workerOf(id, s), age: workerOf(id, s).age + 1 })
pure def canReleaseWarmup(s: SpeechOutput, id: int): bool = workerOf(id, s).workerPhase == CleaningUp
pure def releaseWarmup(s: SpeechOutput, id: int): SpeechOutput = updateWorker(id, s, { ...workerOf(id, s), workerPhase: WorkerDone, releases: workerOf(id, s).releases + 1 })
pure def alwaysOutputReleasedAtMostOnce(s: SpeechOutput): bool = s.warmup.workers.every(w => w.releases <= 1)
```

### A retired worker finishes

```quint
pure val fair_openWarmup = "weak"
pure val fair_playWarmup = "weak"
pure val fair_checkWarmupLoop = "weak"
pure val fair_finishWarmupWrite = "weak"
pure val fair_releaseWarmup = "weak"
pure def leadsToRetiredWorkerFinishes(s: SpeechOutput, later: SpeechOutput): bool =
  s.warmup.workers.every(w => w.closed implies workerOf(w.workerId, later).workerPhase == WorkerDone)
```

### A late open can be released without playing, a replaced worker can still be writing, and a worker can time out

```quint
pure def sometimesLateOpenReleasedWithoutPlaying(s: SpeechOutput): bool = s.warmup.workers.some(w => w.closed and w.workerPhase == WorkerDone and w.releases == 1 and w.writes == 0)
pure def sometimesReplacedWhileWriting(s: SpeechOutput): bool = s.warmup.workers.some(w => w.closed and w.workerPhase == Writing)
pure def sometimesTimedOut(s: SpeechOutput): bool = s.warmup.workers.some(w => w.age == warmupTimeoutTicks and w.workerPhase == CleaningUp and not(w.closed))
```

## Story: Start streamed speech without needless connections

> As a person starting a voice conversation, I want streamed speech to
> start quickly, over as few connections as the server allows.

### Bootstrap runs consent, session and socket in order, reusing the connection when it can

The first request opens a connection. A later request opens another only
when the server closes connections, and the socket upgrade opens another
when the bootstrap ran over HTTP/2, which cannot carry the upgrade. One
request is in flight at a time, and stopping settles the request in flight.

```quint
pure def canStartBootstrap(s: SpeechOutput, http1: bool, keepAlive: bool): bool = not(s.bootstrap.started)
pure def startBootstrap(s: SpeechOutput, http1: bool, keepAlive: bool): SpeechOutput =
  { ...s, bootstrap: { ...s.bootstrap, started: true, http1: http1, keepAlive: keepAlive } }
pure def canSendBootstrapRequest(s: SpeechOutput): bool =
  s.bootstrap.started and not(s.bootstrap.stopped) and s.bootstrap.stage < 3 and not(s.bootstrap.pending)
pure def sendBootstrapRequest(s: SpeechOutput): SpeechOutput = {
  val b = s.bootstrap
  val opens = b.stage == 0 or not(b.keepAlive) or (b.stage == 2 and not(b.http1))
  { ...s, bootstrap: { ...b, pending: true, connections: b.connections + (if (opens) 1 else 0) } }
}
pure def canCompleteBootstrapRequest(s: SpeechOutput): bool = s.bootstrap.pending and not(s.bootstrap.stopped)
pure def completeBootstrapRequest(s: SpeechOutput): SpeechOutput = { ...s, bootstrap: { ...s.bootstrap, stage: s.bootstrap.stage + 1, pending: false } }
pure def canStopBootstrap(s: SpeechOutput): bool = s.bootstrap.started and s.bootstrap.stage < 3 and not(s.bootstrap.stopped)
pure def stopBootstrap(s: SpeechOutput): SpeechOutput = { ...s, bootstrap: { ...s.bootstrap, pending: false, stopped: true } }
pure def alwaysBootstrapIsBounded(s: SpeechOutput): bool =
  s.bootstrap.stage >= 0 and s.bootstrap.stage <= 3 and s.bootstrap.connections >= 0 and s.bootstrap.connections <= 3 and (s.bootstrap.stopped implies not(s.bootstrap.pending))
```

### A persistent HTTP/1.1 server needs one connection for the whole bootstrap

```quint
pure def alwaysReuseWhenCompatible(s: SpeechOutput): bool = (s.bootstrap.http1 and s.bootstrap.keepAlive) implies s.bootstrap.connections <= 1
```

### The socket opens only after consent and session

```quint
pure def alwaysSocketAfterBootstrap(s: SpeechOutput): bool = s.bootstrap.stage == 3 implies (s.bootstrap.connections >= 1 and not(s.bootstrap.pending))
```

### A started bootstrap connects or stops

```quint
pure val fair_sendBootstrapRequest = "weak"
pure val fair_completeBootstrapRequest = "weak"
pure def leadsToBootstrapSettles(s: SpeechOutput, later: SpeechOutput): bool =
  (s.bootstrap.started and s.bootstrap.stage < 3 and not(s.bootstrap.stopped)) implies (later.bootstrap.stage == 3 or later.bootstrap.stopped)
```

### A bootstrap can need one, two or three connections

```quint
pure def sometimesOneConnectionServesAll(s: SpeechOutput): bool = s.bootstrap.stage == 3 and s.bootstrap.http1 and s.bootstrap.keepAlive and s.bootstrap.connections == 1
pure def sometimesHttp2NeedsANewUpgrade(s: SpeechOutput): bool = s.bootstrap.stage == 3 and not(s.bootstrap.http1) and s.bootstrap.keepAlive and s.bootstrap.connections == 2
pure def sometimesClosingServerReconnects(s: SpeechOutput): bool = s.bootstrap.stage == 3 and not(s.bootstrap.keepAlive) and s.bootstrap.connections == 3
```
