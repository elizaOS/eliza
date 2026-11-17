lemma WorkerOfFilter(id: int, s: Warmup)
  ensures workerOf(id, s) == (if ((0 <= 0) && (0 < |ProofLib.Filter((x: WarmupWorker) => (x.workerId == id), s.workers)|)) then ProofLib.Filter((x: WarmupWorker) => (x.workerId == id), s.workers)[0] else WarmupWorker(0, WorkerPhase.WorkerDone, true, 0, 0, 0))
{
}

lemma WorkerOfLaunched(id: int, s: Warmup)
  requires !workerOf(id, s).workerPhase.WorkerDone?
  ensures workerOf(id, s) in s.workers && workerOf(id, s).workerId == id
{
  WorkerOfFilter(id, s);
  ProofLib.FilterMember((x: WarmupWorker) => (x.workerId == id), s.workers, workerOf(id, s));
}

lemma WarmupStep(s: Warmup, id: int, change: WarmupWorker)
  requires !((exists w :: w in s.workers && !((!((w.workerId != s.owner)) || w.closed)))) && !((exists w :: w in s.workers && !((w.releases <= 1)))) && !((exists w :: w in s.workers && !((!((!w.workerPhase.WorkerDone?)) || (w.releases == 0)))))
  requires !workerOf(id, s).workerPhase.WorkerDone?
  requires change.workerId == workerOf(id, s).workerId && change.closed == workerOf(id, s).closed
  requires change.releases == 0 || (change.releases == 1 && change.workerPhase.WorkerDone?)
  ensures alwaysReplacedWorkersAreClosed(updateWorker(id, s, change))
  ensures alwaysOutputReleasedAtMostOnce(updateWorker(id, s, change))
  ensures alwaysUnfinishedWorkerReleasedNothing(updateWorker(id, s, change))
{
  WorkerOfLaunched(id, s);
  var after := updateWorker(id, s, change);
  forall w | w in after.workers
    ensures w == change || w in s.workers
  {
    var k :| 0 <= k < |after.workers| && after.workers[k] == w;
    assert s.workers[k] in s.workers;
  }
}

lemma openWarmup_ensures(w: Warmup, id: int, success: bool)
  ensures (inv(w) ==> canOpenWarmup(w, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(openWarmup(w, id, success)))
  ensures (inv(w) ==> canOpenWarmup(w, id) ==> alwaysReplacedWorkersAreClosed(openWarmup(w, id, success)))
  ensures (inv(w) ==> canOpenWarmup(w, id) ==> alwaysNoRetiredWorkerPlays(openWarmup(w, id, success)))
  ensures (inv(w) ==> canOpenWarmup(w, id) ==> alwaysOutputReleasedAtMostOnce(openWarmup(w, id, success)))
  ensures (inv(w) ==> canOpenWarmup(w, id) ==> alwaysUnfinishedWorkerReleasedNothing(openWarmup(w, id, success)))
{
  if inv(w) && canOpenWarmup(w, id) {
    WorkerOfLaunched(id, w);
    WarmupStep(w, id, workerOf(id, w).(workerPhase := (if success then WorkerPhase.Opened else WorkerPhase.WorkerDone)));
  }
}

lemma playWarmup_ensures(w: Warmup, id: int, success: bool)
  ensures (inv(w) ==> canPlayWarmup(w, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(playWarmup(w, id, success)))
  ensures (inv(w) ==> canPlayWarmup(w, id) ==> alwaysReplacedWorkersAreClosed(playWarmup(w, id, success)))
  ensures (inv(w) ==> canPlayWarmup(w, id) ==> alwaysNoRetiredWorkerPlays(playWarmup(w, id, success)))
  ensures (inv(w) ==> canPlayWarmup(w, id) ==> alwaysOutputReleasedAtMostOnce(playWarmup(w, id, success)))
  ensures (inv(w) ==> canPlayWarmup(w, id) ==> alwaysUnfinishedWorkerReleasedNothing(playWarmup(w, id, success)))
{
  if inv(w) && canPlayWarmup(w, id) {
    WorkerOfLaunched(id, w);
    WarmupStep(w, id, workerOf(id, w).(workerPhase := (if (workerOf(id, w).closed || !(success)) then WorkerPhase.CleaningUp else WorkerPhase.Looping)));
  }
}

lemma tickWarmup_ensures(w: Warmup, id: int)
  ensures (inv(w) ==> canTickWarmup(w, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(tickWarmup(w, id)))
  ensures (inv(w) ==> canTickWarmup(w, id) ==> alwaysReplacedWorkersAreClosed(tickWarmup(w, id)))
  ensures (inv(w) ==> canTickWarmup(w, id) ==> alwaysNoRetiredWorkerPlays(tickWarmup(w, id)))
  ensures (inv(w) ==> canTickWarmup(w, id) ==> alwaysOutputReleasedAtMostOnce(tickWarmup(w, id)))
  ensures (inv(w) ==> canTickWarmup(w, id) ==> alwaysUnfinishedWorkerReleasedNothing(tickWarmup(w, id)))
{
  if inv(w) && canTickWarmup(w, id) {
    WorkerOfLaunched(id, w);
    WarmupStep(w, id, workerOf(id, w).(age := (workerOf(id, w).age + 1)));
  }
}

lemma releaseWarmup_ensures(w: Warmup, id: int)
  ensures (inv(w) ==> canReleaseWarmup(w, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(releaseWarmup(w, id)))
  ensures (inv(w) ==> canReleaseWarmup(w, id) ==> alwaysReplacedWorkersAreClosed(releaseWarmup(w, id)))
  ensures (inv(w) ==> canReleaseWarmup(w, id) ==> alwaysNoRetiredWorkerPlays(releaseWarmup(w, id)))
  ensures (inv(w) ==> canReleaseWarmup(w, id) ==> alwaysOutputReleasedAtMostOnce(releaseWarmup(w, id)))
  ensures (inv(w) ==> canReleaseWarmup(w, id) ==> alwaysUnfinishedWorkerReleasedNothing(releaseWarmup(w, id)))
{
  if inv(w) && canReleaseWarmup(w, id) {
    WorkerOfLaunched(id, w);
    WarmupStep(w, id, workerOf(id, w).(workerPhase := WorkerPhase.WorkerDone, releases := (workerOf(id, w).releases + 1)));
  }
}

lemma finishWarmupWrite_ensures(w: Warmup, id: int, success: bool)
  ensures (inv(w) ==> canFinishWarmupWrite(w, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(finishWarmupWrite(w, id, success)))
  ensures (inv(w) ==> canFinishWarmupWrite(w, id) ==> alwaysReplacedWorkersAreClosed(finishWarmupWrite(w, id, success)))
  ensures (inv(w) ==> canFinishWarmupWrite(w, id) ==> alwaysNoRetiredWorkerPlays(finishWarmupWrite(w, id, success)))
  ensures (inv(w) ==> canFinishWarmupWrite(w, id) ==> alwaysOutputReleasedAtMostOnce(finishWarmupWrite(w, id, success)))
  ensures (inv(w) ==> canFinishWarmupWrite(w, id) ==> alwaysUnfinishedWorkerReleasedNothing(finishWarmupWrite(w, id, success)))
{
  if inv(w) && canFinishWarmupWrite(w, id) {
    WorkerOfLaunched(id, w);
    WarmupStep(w, id, workerOf(id, w).(workerPhase := (if success then WorkerPhase.Looping else WorkerPhase.CleaningUp), writes := (workerOf(id, w).writes + 1)));
  }
}

lemma checkWarmupLoop_ensures(w: Warmup, id: int)
  ensures (inv(w) ==> canCheckWarmupLoop(w, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(checkWarmupLoop(w, id)))
  ensures (inv(w) ==> canCheckWarmupLoop(w, id) ==> alwaysReplacedWorkersAreClosed(checkWarmupLoop(w, id)))
  ensures (inv(w) ==> canCheckWarmupLoop(w, id) ==> alwaysNoRetiredWorkerPlays(checkWarmupLoop(w, id)))
  ensures (inv(w) ==> canCheckWarmupLoop(w, id) ==> alwaysOutputReleasedAtMostOnce(checkWarmupLoop(w, id)))
  ensures (inv(w) ==> canCheckWarmupLoop(w, id) ==> alwaysUnfinishedWorkerReleasedNothing(checkWarmupLoop(w, id)))
{
  if inv(w) && canCheckWarmupLoop(w, id) {
    WorkerOfLaunched(id, w);
    WarmupStep(w, id, workerOf(id, w).(workerPhase := (if (workerOf(id, w).closed || (workerOf(id, w).age >= warmupTimeoutTicks)) then WorkerPhase.CleaningUp else WorkerPhase.Writing)));
  }
}
