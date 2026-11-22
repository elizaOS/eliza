lemma WorkerLookupMatchesMember(s: SpeechOutput, w: WarmupWorker)
  requires alwaysWorkerIdsAreUnique(s)
  requires w in s.workers
  ensures workerOf(w.workerId, s) == w
{
  var matches := (x: WarmupWorker) => x.workerId == w.workerId;
  var selected := ProofLib.Filter(matches, s.workers);
  assert |selected| == 1;
  ProofLib.FilterMember(matches, s.workers, w);
  assert selected[0] == w;
}

lemma UnchangedWorkersKeepPhaseRules(before: SpeechOutput, after: SpeechOutput)
  requires alwaysWorkerIdsAreUnique(before)
  requires after.workers == before.workers
  ensures stepRetiredWorkerNeverStartsPlaying(before, after)
  ensures stepNoWriteAfterRetireOrTimeout(before, after)
  ensures stepOutputReleasedOnce(before, after)
{
  forall w | w in before.workers
    ensures workerOf(w.workerId, before) == w && workerOf(w.workerId, after) == w
  {
    WorkerLookupMatchesMember(before, w);
    assert workerOf(w.workerId, after) == workerOf(w.workerId, before);
  }
}

lemma focusChanged_ensures(s: SpeechOutput, change: FocusChange)
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysWarmupOnlyWhileIdle(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysOnlyTheOwnerIsOpen(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysWorkerIdsAreUnique(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysNoSpeechDuringCall(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysSpeakingHasPositiveUtteranceId(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepRetiredWorkerNeverStartsPlaying(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepNoWriteAfterRetireOrTimeout(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepOutputReleasedOnce(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepFirstAudioReportedOnce(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepFocusAbandonedWhenSpeechStops(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepStoppedSpeechDropsItsAudio(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
{
  if inv(s) && canFocusChanged(s, change) {
    UnchangedWorkersKeepPhaseRules(s, focusChanged(s, change).state);
  }
}

lemma writeSpeech_ensures(s: SpeechOutput)
  ensures (inv(s) ==> canWriteSpeech(s) ==> alwaysWarmupOnlyWhileIdle(writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> alwaysOnlyTheOwnerIsOpen(writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> alwaysWorkerIdsAreUnique(writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> alwaysNoSpeechDuringCall(writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> alwaysSpeakingHasPositiveUtteranceId(writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepRetiredWorkerNeverStartsPlaying(s, writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepNoWriteAfterRetireOrTimeout(s, writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepOutputReleasedOnce(s, writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepFirstAudioReportedOnce(s, "writeSpeech", writeSpeech(s).state, writeSpeech(s).out))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepFocusAbandonedWhenSpeechStops(s, "writeSpeech", writeSpeech(s).state, writeSpeech(s).out))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepStoppedSpeechDropsItsAudio(s, "writeSpeech", writeSpeech(s).state, writeSpeech(s).out))
{
  if inv(s) && canWriteSpeech(s) {
    UnchangedWorkersKeepPhaseRules(s, writeSpeech(s).state);
    assert s.speech.Speaking?;
    assert s.speech.utteranceId > 0;
    var after := writeSpeech(s);
    if writtenOf(s.speech) == 0 {
      var notice := FirstAudio(s.speech.utteranceId);
      assert notice in after.out && isFirstAudio(notice);
      assert exists n :: n in after.out && isFirstAudio(n);
    } else {
      assert after.out == [];
    }
    assert stepFirstAudioReportedOnce(s, "writeSpeech", after.state, after.out);
  }
}

lemma endSpeech_ensures(s: SpeechOutput)
  ensures (inv(s) ==> canEndSpeech(s) ==> alwaysWarmupOnlyWhileIdle(endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> alwaysOnlyTheOwnerIsOpen(endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> alwaysWorkerIdsAreUnique(endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> alwaysNoSpeechDuringCall(endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> alwaysSpeakingHasPositiveUtteranceId(endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepRetiredWorkerNeverStartsPlaying(s, endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepNoWriteAfterRetireOrTimeout(s, endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepOutputReleasedOnce(s, endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepFirstAudioReportedOnce(s, "endSpeech", endSpeech(s).state, endSpeech(s).out))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepFocusAbandonedWhenSpeechStops(s, "endSpeech", endSpeech(s).state, endSpeech(s).out))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepStoppedSpeechDropsItsAudio(s, "endSpeech", endSpeech(s).state, endSpeech(s).out))
{
  if inv(s) && canEndSpeech(s) {
    UnchangedWorkersKeepPhaseRules(s, endSpeech(s).state);
  }
}

lemma cancelSpeech_ensures(s: SpeechOutput)
  ensures (inv(s) ==> canCancelSpeech(s) ==> alwaysWarmupOnlyWhileIdle(cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> alwaysOnlyTheOwnerIsOpen(cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> alwaysWorkerIdsAreUnique(cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> alwaysNoSpeechDuringCall(cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> alwaysSpeakingHasPositiveUtteranceId(cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepRetiredWorkerNeverStartsPlaying(s, cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepNoWriteAfterRetireOrTimeout(s, cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepOutputReleasedOnce(s, cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepFirstAudioReportedOnce(s, "cancelSpeech", cancelSpeech(s).state, cancelSpeech(s).out))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepFocusAbandonedWhenSpeechStops(s, "cancelSpeech", cancelSpeech(s).state, cancelSpeech(s).out))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepStoppedSpeechDropsItsAudio(s, "cancelSpeech", cancelSpeech(s).state, cancelSpeech(s).out))
{
  if inv(s) && canCancelSpeech(s) {
    UnchangedWorkersKeepPhaseRules(s, cancelSpeech(s).state);
  }
}

lemma WorkerMapPreservesIds(before: SpeechOutput, after: SpeechOutput)
  requires alwaysWorkerIdsAreUnique(before)
  requires |before.workers| == |after.workers|
  requires forall i :: 0 <= i < |before.workers| ==> before.workers[i].workerId == after.workers[i].workerId
  ensures alwaysWorkerIdsAreUnique(after)
{
  forall w | w in after.workers
    ensures w.workerId > 0 && |ProofLib.Filter((x: WarmupWorker) => x.workerId == w.workerId, after.workers)| == 1
  {
    var i :| 0 <= i < |after.workers| && after.workers[i] == w;
    var former := before.workers[i];
    assert former in before.workers && former.workerId == w.workerId;
    var matches := (x: WarmupWorker) => x.workerId == w.workerId;
    assert |ProofLib.Filter(matches, before.workers)| == 1;
    ProofLib.FilterLengthPointwise(matches, matches, before.workers, after.workers);
  }
}

lemma WorkerMapPreservesPhaseRules(before: SpeechOutput, after: SpeechOutput)
  requires alwaysWorkerIdsAreUnique(before) && alwaysWorkerIdsAreUnique(after)
  requires |before.workers| == |after.workers|
  requires forall i :: 0 <= i < |before.workers| ==> before.workers[i].workerId == after.workers[i].workerId
  requires forall i :: 0 <= i < |before.workers| ==> (
    (before.workers[i].phase.Opening? && after.workers[i].phase.Looping? ==> !after.workers[i].closed) &&
    (before.workers[i].phase.Looping? && after.workers[i].phase.Writing? ==> !after.workers[i].closed && after.workers[i].elapsedMs < warmupLimitMs) &&
    (after.workers[i].phase.Released? ==> before.workers[i].phase.CleaningUp? || before.workers[i].phase.Released?) &&
    (finished(before.workers[i].phase) ==> after.workers[i].phase == before.workers[i].phase))
  ensures stepRetiredWorkerNeverStartsPlaying(before, after)
  ensures stepNoWriteAfterRetireOrTimeout(before, after)
  ensures stepOutputReleasedOnce(before, after)
{
  forall w | w in after.workers
    ensures startedPlaying(before, w) ==> !w.closed
    ensures startedWriting(before, w) ==> !w.closed && w.elapsedMs < warmupLimitMs
    ensures w.phase.Released? ==> workerOf(w.workerId, before).phase.CleaningUp? || workerOf(w.workerId, before).phase.Released?
  {
    var i :| 0 <= i < |after.workers| && after.workers[i] == w;
    var former := before.workers[i];
    assert former in before.workers && former.workerId == w.workerId;
    WorkerLookupMatchesMember(before, former);
  }
  forall w | w in before.workers && finished(w.phase)
    ensures workerOf(w.workerId, after).phase == w.phase
  {
    var i :| 0 <= i < |before.workers| && before.workers[i] == w;
    var later := after.workers[i];
    assert later in after.workers && later.workerId == w.workerId;
    WorkerLookupMatchesMember(after, later);
  }
}

lemma stopWarmup_ensures(s: SpeechOutput)
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysWarmupOnlyWhileIdle(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysOnlyTheOwnerIsOpen(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysWorkerIdsAreUnique(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysNoSpeechDuringCall(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysSpeakingHasPositiveUtteranceId(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepRetiredWorkerNeverStartsPlaying(s, stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepNoWriteAfterRetireOrTimeout(s, stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepOutputReleasedOnce(s, stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepFirstAudioReportedOnce(s, "stopWarmup", stopWarmup(s), []))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepFocusAbandonedWhenSpeechStops(s, "stopWarmup", stopWarmup(s), []))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepStoppedSpeechDropsItsAudio(s, "stopWarmup", stopWarmup(s), []))
{
  if inv(s) && canStopWarmup(s) {
    var after := stopWarmup(s);
    forall i | 0 <= i < |s.workers|
      ensures after.workers[i].workerId == s.workers[i].workerId
      ensures after.workers[i].phase == s.workers[i].phase
    {
      assert after.workers[i] == (if s.workers[i].workerId == s.owner then s.workers[i].(closed := true) else s.workers[i]);
    }
    assert alwaysOnlyTheOwnerIsOpen(after);
    WorkerMapPreservesIds(s, after);
    WorkerMapPreservesPhaseRules(s, after);
  }
}


lemma WorkerUpdatePreservesOwnership(s: SpeechOutput, id: int, worker: WarmupWorker)
  requires inv(s)
  requires worker.workerId == id && worker.closed == workerOf(id, s).closed
  ensures alwaysOnlyTheOwnerIsOpen(updateWorker(id, s, worker))
  ensures alwaysWorkerIdsAreUnique(updateWorker(id, s, worker))
  ensures forall i :: 0 <= i < |s.workers| ==> s.workers[i].workerId == updateWorker(id, s, worker).workers[i].workerId
{
  var after := updateWorker(id, s, worker);
  forall i | 0 <= i < |s.workers|
    ensures after.workers[i].workerId == s.workers[i].workerId
    ensures after.workers[i].closed == s.workers[i].closed
  {
    var former := s.workers[i];
    assert former in s.workers;
    assert after.workers[i] == (if former.workerId == id then worker else former);
    if former.workerId == id {
      WorkerLookupMatchesMember(s, former);
    }
  }
  forall w | w in after.workers && w.workerId != after.owner
    ensures w.closed
  {
    var i :| 0 <= i < |after.workers| && after.workers[i] == w;
    assert s.workers[i] in s.workers;
  }
  WorkerMapPreservesIds(s, after);
}

lemma releaseWarmup_ensures(s: SpeechOutput, id: int)
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysWarmupOnlyWhileIdle(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysOnlyTheOwnerIsOpen(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysWorkerIdsAreUnique(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysNoSpeechDuringCall(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysSpeakingHasPositiveUtteranceId(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepRetiredWorkerNeverStartsPlaying(s, releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepNoWriteAfterRetireOrTimeout(s, releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepOutputReleasedOnce(s, releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepFirstAudioReportedOnce(s, "releaseWarmup", releaseWarmup(s, id), []))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepFocusAbandonedWhenSpeechStops(s, "releaseWarmup", releaseWarmup(s, id), []))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepStoppedSpeechDropsItsAudio(s, "releaseWarmup", releaseWarmup(s, id), []))
{
  if inv(s) && canReleaseWarmup(s, id) {
    var matches := (x: WarmupWorker) => x.workerId == id;
    var selected := ProofLib.Filter(matches, s.workers);
    assert |selected| > 0;
    ProofLib.FilterMember(matches, s.workers, selected[0]);
    var worker := workerOf(id, s);
    assert worker.workerId == id && worker.phase.CleaningUp?;
    WorkerUpdatePreservesOwnership(s, id, worker.(phase := WorkerPhase.Released));
    var after := releaseWarmup(s, id);
    forall i | 0 <= i < |s.workers|
      ensures after.workers[i].phase == s.workers[i].phase ||
        (s.workers[i].phase.CleaningUp? && after.workers[i].phase.Released?)
    {
      var former := s.workers[i];
      assert former in s.workers;
      if former.workerId == id {
        WorkerLookupMatchesMember(s, former);
      }
    }
    WorkerMapPreservesPhaseRules(s, after);
  }
}
