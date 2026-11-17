lemma WorkerOfFilter(id: int, s: SpeechOutput)
  ensures workerOf(id, s) == (if ((0 <= 0) && (0 < |ProofLib.Filter((w: WarmupWorker) => (w.workerId == id), s.warmup.workers)|)) then ProofLib.Filter((w: WarmupWorker) => (w.workerId == id), s.warmup.workers)[0] else WarmupWorker(0, WorkerPhase.WorkerDone, true, 0, 0, 0))
{
}

lemma WorkerOfLaunched(id: int, s: SpeechOutput)
  requires !workerOf(id, s).workerPhase.WorkerDone?
  ensures workerOf(id, s) in s.warmup.workers && workerOf(id, s).workerId == id
{
  WorkerOfFilter(id, s);
  ProofLib.FilterMember((w: WarmupWorker) => (w.workerId == id), s.warmup.workers, workerOf(id, s));
}

lemma WarmupStep(s: SpeechOutput, id: int, change: WarmupWorker)
  requires !((exists w :: w in s.warmup.workers && !((!((w.workerId != s.warmup.owner)) || w.closed)))) && !((exists w :: w in s.warmup.workers && !((w.releases <= 1)))) && !((exists w :: w in s.warmup.workers && !((!((!w.workerPhase.WorkerDone?)) || (w.releases == 0)))))
  requires !workerOf(id, s).workerPhase.WorkerDone?
  requires change.workerId == workerOf(id, s).workerId && change.closed == workerOf(id, s).closed
  requires change.releases == 0 || (change.releases == 1 && change.workerPhase.WorkerDone?)
  ensures alwaysReplacedWorkersAreClosed(updateWorker(id, s, change))
  ensures alwaysOutputReleasedAtMostOnce(updateWorker(id, s, change))
  ensures alwaysUnfinishedWorkerReleasedNothing(updateWorker(id, s, change))
{
  WorkerOfLaunched(id, s);
  var after := updateWorker(id, s, change);
  forall w | w in after.warmup.workers
    ensures w == change || w in s.warmup.workers
  {
    var k :| 0 <= k < |after.warmup.workers| && after.warmup.workers[k] == w;
    assert s.warmup.workers[k] in s.warmup.workers;
  }
}

lemma openWarmup_ensures(s: SpeechOutput, id: int, success: bool)
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysRefusedPublicationKeepsPlayback(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysInterruptsOnlyWithReplacement(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysReplacedWorkersAreClosed(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysNoRetiredWorkerPlays(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysOutputReleasedAtMostOnce(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysUnfinishedWorkerReleasedNothing(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysBootstrapIsBounded(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysEachRequestOpensAtMostOneConnection(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysReuseWhenCompatible(openWarmup(s, id, success)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysSocketAfterBootstrap(openWarmup(s, id, success)))
{
  if inv(s) && canOpenWarmup(s, id) {
    WorkerOfLaunched(id, s);
    WarmupStep(s, id, workerOf(id, s).(workerPhase := (if success then WorkerPhase.Opened else WorkerPhase.WorkerDone)));
  }
}

lemma playWarmup_ensures(s: SpeechOutput, id: int, success: bool)
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysRefusedPublicationKeepsPlayback(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysInterruptsOnlyWithReplacement(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysReplacedWorkersAreClosed(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysNoRetiredWorkerPlays(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysOutputReleasedAtMostOnce(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysUnfinishedWorkerReleasedNothing(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysBootstrapIsBounded(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysEachRequestOpensAtMostOneConnection(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysReuseWhenCompatible(playWarmup(s, id, success)))
  ensures (inv(s) ==> canPlayWarmup(s, id) ==> alwaysSocketAfterBootstrap(playWarmup(s, id, success)))
{
  if inv(s) && canPlayWarmup(s, id) {
    WorkerOfLaunched(id, s);
    WarmupStep(s, id, workerOf(id, s).(workerPhase := (if (workerOf(id, s).closed || !(success)) then WorkerPhase.CleaningUp else WorkerPhase.Looping)));
  }
}

lemma tickWarmup_ensures(s: SpeechOutput, id: int)
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysRefusedPublicationKeepsPlayback(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysInterruptsOnlyWithReplacement(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysReplacedWorkersAreClosed(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysNoRetiredWorkerPlays(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysOutputReleasedAtMostOnce(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysUnfinishedWorkerReleasedNothing(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysBootstrapIsBounded(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysEachRequestOpensAtMostOneConnection(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysReuseWhenCompatible(tickWarmup(s, id)))
  ensures (inv(s) ==> canTickWarmup(s, id) ==> alwaysSocketAfterBootstrap(tickWarmup(s, id)))
{
  if inv(s) && canTickWarmup(s, id) {
    WorkerOfLaunched(id, s);
    WarmupStep(s, id, workerOf(id, s).(age := (workerOf(id, s).age + 1)));
  }
}

lemma releaseWarmup_ensures(s: SpeechOutput, id: int)
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysRefusedPublicationKeepsPlayback(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysInterruptsOnlyWithReplacement(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysReplacedWorkersAreClosed(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysNoRetiredWorkerPlays(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysOutputReleasedAtMostOnce(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysUnfinishedWorkerReleasedNothing(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysBootstrapIsBounded(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysEachRequestOpensAtMostOneConnection(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysReuseWhenCompatible(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysSocketAfterBootstrap(releaseWarmup(s, id)))
{
  if inv(s) && canReleaseWarmup(s, id) {
    WorkerOfLaunched(id, s);
    WarmupStep(s, id, workerOf(id, s).(workerPhase := WorkerPhase.WorkerDone, releases := (workerOf(id, s).releases + 1)));
  }
}

lemma finishWarmupWrite_ensures(s: SpeechOutput, id: int, success: bool)
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysRefusedPublicationKeepsPlayback(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysInterruptsOnlyWithReplacement(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysReplacedWorkersAreClosed(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysNoRetiredWorkerPlays(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysOutputReleasedAtMostOnce(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysUnfinishedWorkerReleasedNothing(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysBootstrapIsBounded(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysEachRequestOpensAtMostOneConnection(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysReuseWhenCompatible(finishWarmupWrite(s, id, success)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysSocketAfterBootstrap(finishWarmupWrite(s, id, success)))
{
  if inv(s) && canFinishWarmupWrite(s, id) {
    WorkerOfLaunched(id, s);
    WarmupStep(s, id, workerOf(id, s).(workerPhase := (if success then WorkerPhase.Looping else WorkerPhase.CleaningUp), writes := (workerOf(id, s).writes + 1)));
  }
}

lemma checkWarmupLoop_ensures(s: SpeechOutput, id: int)
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysRefusedPublicationKeepsPlayback(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysInterruptsOnlyWithReplacement(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysOnlyAnIdleOutputHasAnOwner(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysReplacedWorkersAreClosed(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysNoRetiredWorkerPlays(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysOutputReleasedAtMostOnce(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysUnfinishedWorkerReleasedNothing(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysBootstrapIsBounded(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysEachRequestOpensAtMostOneConnection(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysReuseWhenCompatible(checkWarmupLoop(s, id)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id) ==> alwaysSocketAfterBootstrap(checkWarmupLoop(s, id)))
{
  if inv(s) && canCheckWarmupLoop(s, id) {
    WorkerOfLaunched(id, s);
    WarmupStep(s, id, workerOf(id, s).(workerPhase := (if (workerOf(id, s).closed || (workerOf(id, s).age >= warmupTimeoutTicks)) then WorkerPhase.CleaningUp else WorkerPhase.Writing)));
  }
}
