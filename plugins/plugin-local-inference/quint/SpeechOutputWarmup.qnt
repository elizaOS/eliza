// LocalSpeechBridgePlugin owns the current warm-up reference on the main
// thread. Each SpeechOutputWarmup owns a worker and its exact output.
module SpeechOutputWarmup {
  pure val Workers = Set(1, 2)
  pure val ReadyForRequest = Set("idle", "busy", "background", "call", "destroyed")
  type Worker = { phase: str, closed: bool, age: int, writes: int, releases: int }
  pure val unused: Worker = { phase: "unused", closed: false, age: 0, writes: 0, releases: 0 }
  var s: { owner: int, mode: str, workers: int -> Worker, unsafePlay: bool }
  action init = s' = { owner: 0, mode: "idle", workers: Workers.mapBy(_ => unused), unsafePlay: false }
  pure def retire(workers: int -> Worker, owner: int): int -> Worker =
    if (owner == 0) workers else workers.set(owner, { ...workers.get(owner), closed: true })
  action request(id: int): bool = all {
    s.mode == "idle", s.workers.get(id).phase == "unused",
    s' = { ...s, owner: id, workers: retire(s.workers, s.owner).set(id,
      { ...unused, phase: "opening" }) },
  }
  action stop(mode: str): bool = all {
    s.mode != "destroyed", ReadyForRequest.contains(mode),
    s' = { ...s, mode: mode, owner: 0, workers: retire(s.workers, s.owner) },
  }
  action open(id: int, success: bool): bool = {
    val w = s.workers.get(id)
    all { w.phase == "opening", s' = { ...s, workers: s.workers.set(id,
      { ...w, phase: if (success) "opened" else "done" }) } }
  }
  // Java checks closed, publishes the exact handle and calls play under one
  // monitor. A concurrent close cannot interpose inside this transition.
  action play(id: int, success: bool): bool = {
    val w = s.workers.get(id)
    all { w.phase == "opened", s' = { ...s,
      unsafePlay: s.unsafePlay or (not(w.closed) and s.owner != id),
      workers: s.workers.set(id, { ...w,
        phase: if (w.closed or not(success)) "cleanup" else "loop" }) } }
  }
  // A checked write may already be admitted when close arrives. It can still
  // invoke the output port. The worker cannot admit another after close.
  action checkLoop(id: int): bool = {
    val w = s.workers.get(id)
    all { w.phase == "loop", s' = { ...s, workers: s.workers.set(id, { ...w,
      phase: if (w.closed or w.age == 2 or w.writes == 2) "cleanup" else "write" }) } }
  }
  action finishWrite(id: int, success: bool): bool = {
    val w = s.workers.get(id)
    all { w.phase == "write", s' = { ...s, workers: s.workers.set(id, { ...w,
      phase: if (success) "loop" else "cleanup", writes: w.writes + 1 }) } }
  }
  action tick(id: int): bool = {
    val w = s.workers.get(id)
    all { Set("loop", "write").contains(w.phase), w.age < 2,
      s' = { ...s, workers: s.workers.set(id, { ...w, age: w.age + 1 }) } }
  }
  action release(id: int): bool = {
    val w = s.workers.get(id)
    all { w.phase == "cleanup", s' = { ...s, workers: s.workers.set(id,
      { ...w, phase: "done", releases: w.releases + 1 }) } }
  }
  action worker(id: int): bool = any {
    open(id, true), open(id, false), play(id, true), play(id, false),
    checkLoop(id), finishWrite(id, true), finishWrite(id, false), release(id),
  }
  action step = any {
    { nondet id = Workers.oneOf() request(id) },
    { nondet mode = ReadyForRequest.oneOf() stop(mode) },
    { nondet id = Workers.oneOf() tick(id) },
    worker(1), worker(2), s' = s,
  }
  val NoRetiredPlay = not(s.unsafePlay)
  val AdmissionOwnsIdle = s.owner == 0 or s.mode == "idle"
  val ReleaseAttemptOnce = Workers.forall(id => s.workers.get(id).releases <= 1)
  val RetiredWorkersAreClosed = Workers.forall(id =>
    (s.workers.get(id).phase != "unused" and s.owner != id).implies(s.workers.get(id).closed))
  val safety = NoRetiredPlay and AdmissionOwnsIdle and ReleaseAttemptOnce and RetiredWorkersAreClosed
  temporal RetiredWorkerSettles = (worker(1).weakFair(s) and worker(2).weakFair(s)).implies(
    Workers.forall(id => always(s.workers.get(id).closed.implies(eventually(s.workers.get(id).phase == "done")))))
  run lateOpenIsReleasedWithoutPlayTest = init.then(request(1)).then(stop("background"))
    .then(open(1, true)).then(play(1, true)).then(release(1))
    .expect(safety and s.workers.get(1).releases == 1)
  run replacementKeepsExactOwnerTest = init.then(request(1)).then(open(1, true)).then(play(1, true))
    .then(checkLoop(1)).then(request(2)).then(finishWrite(1, true)).then(checkLoop(1)).then(release(1))
    .expect(safety and s.owner == 2 and s.workers.get(2).phase == "opening")
  run timeoutStopsFurtherAdmissionsTest = init.then(request(1)).then(open(1, true)).then(play(1, true))
    .then(tick(1)).then(tick(1)).then(checkLoop(1)).then(release(1))
    .expect(safety and s.workers.get(1).writes == 0 and s.workers.get(1).releases == 1)
  run refusedOpenHasNoHandleTest = init.then(request(1)).then(open(1, false))
    .expect(safety and s.workers.get(1).phase == "done" and s.workers.get(1).releases == 0)
}
