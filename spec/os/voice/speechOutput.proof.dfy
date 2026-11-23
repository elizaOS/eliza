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
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysPausedListeningIsSilent(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepRetiredWorkerNeverStartsPlaying(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepNoWriteAfterRetireOrTimeout(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepOutputReleasedOnce(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepFirstAudioReportedOnce(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepFocusAbandonedWhenUnused(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
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
  ensures (inv(s) ==> canWriteSpeech(s) ==> alwaysPausedListeningIsSilent(writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepRetiredWorkerNeverStartsPlaying(s, writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepNoWriteAfterRetireOrTimeout(s, writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepOutputReleasedOnce(s, writeSpeech(s).state))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepFirstAudioReportedOnce(s, "writeSpeech", writeSpeech(s).state, writeSpeech(s).out))
  ensures (inv(s) ==> canWriteSpeech(s) ==> stepFocusAbandonedWhenUnused(s, "writeSpeech", writeSpeech(s).state, writeSpeech(s).out))
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
  ensures (inv(s) ==> canEndSpeech(s) ==> alwaysPausedListeningIsSilent(endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepRetiredWorkerNeverStartsPlaying(s, endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepNoWriteAfterRetireOrTimeout(s, endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepOutputReleasedOnce(s, endSpeech(s).state))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepFirstAudioReportedOnce(s, "endSpeech", endSpeech(s).state, endSpeech(s).out))
  ensures (inv(s) ==> canEndSpeech(s) ==> stepFocusAbandonedWhenUnused(s, "endSpeech", endSpeech(s).state, endSpeech(s).out))
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
  ensures (inv(s) ==> canCancelSpeech(s) ==> alwaysPausedListeningIsSilent(cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepRetiredWorkerNeverStartsPlaying(s, cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepNoWriteAfterRetireOrTimeout(s, cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepOutputReleasedOnce(s, cancelSpeech(s).state))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepFirstAudioReportedOnce(s, "cancelSpeech", cancelSpeech(s).state, cancelSpeech(s).out))
  ensures (inv(s) ==> canCancelSpeech(s) ==> stepFocusAbandonedWhenUnused(s, "cancelSpeech", cancelSpeech(s).state, cancelSpeech(s).out))
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

lemma RetiringWorkersKeepsRules(before: SpeechOutput, after: SpeechOutput)
  requires inv(before)
  requires after.workers == retire(before.owner, before.workers)
  ensures |before.workers| == |after.workers|
  ensures forall i :: 0 <= i < |before.workers| ==> before.workers[i].workerId == after.workers[i].workerId
  ensures forall w :: w in after.workers ==> w.closed
  ensures alwaysWorkerIdsAreUnique(after)
  ensures stepRetiredWorkerNeverStartsPlaying(before, after)
  ensures stepNoWriteAfterRetireOrTimeout(before, after)
  ensures stepOutputReleasedOnce(before, after)
{
  forall i | 0 <= i < |before.workers|
    ensures after.workers[i].workerId == before.workers[i].workerId
    ensures after.workers[i].phase == before.workers[i].phase
    ensures after.workers[i].closed
  {
    var former := before.workers[i];
    assert former in before.workers;
    assert after.workers[i] == (if former.workerId == before.owner then former.(closed := true) else former);
  }
  WorkerMapPreservesIds(before, after);
  WorkerMapPreservesPhaseRules(before, after);
}

lemma stopWarmup_ensures(s: SpeechOutput)
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysWarmupOnlyWhileIdle(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysOnlyTheOwnerIsOpen(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysWorkerIdsAreUnique(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysNoSpeechDuringCall(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysSpeakingHasPositiveUtteranceId(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> alwaysPausedListeningIsSilent(stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepRetiredWorkerNeverStartsPlaying(s, stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepNoWriteAfterRetireOrTimeout(s, stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepOutputReleasedOnce(s, stopWarmup(s)))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepFirstAudioReportedOnce(s, "stopWarmup", stopWarmup(s), []))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepFocusAbandonedWhenUnused(s, "stopWarmup", stopWarmup(s), []))
  ensures (inv(s) ==> canStopWarmup(s) ==> stepStoppedSpeechDropsItsAudio(s, "stopWarmup", stopWarmup(s), []))
{
  if inv(s) && canStopWarmup(s) {
    RetiringWorkersKeepsRules(s, stopWarmup(s));
  }
}

lemma startSpeech_ensures(s: SpeechOutput, utteranceId: int, granted: bool)
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> alwaysWarmupOnlyWhileIdle(startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> alwaysOnlyTheOwnerIsOpen(startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> alwaysWorkerIdsAreUnique(startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> alwaysNoSpeechDuringCall(startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> alwaysSpeakingHasPositiveUtteranceId(startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> alwaysPausedListeningIsSilent(startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> stepRetiredWorkerNeverStartsPlaying(s, startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> stepNoWriteAfterRetireOrTimeout(s, startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> stepOutputReleasedOnce(s, startSpeech(s, utteranceId, granted).state))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> stepFirstAudioReportedOnce(s, "startSpeech", startSpeech(s, utteranceId, granted).state, startSpeech(s, utteranceId, granted).out))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> stepFocusAbandonedWhenUnused(s, "startSpeech", startSpeech(s, utteranceId, granted).state, startSpeech(s, utteranceId, granted).out))
  ensures (inv(s) ==> canStartSpeech(s, utteranceId) ==> stepStoppedSpeechDropsItsAudio(s, "startSpeech", startSpeech(s, utteranceId, granted).state, startSpeech(s, utteranceId, granted).out))
{
  if inv(s) && canStartSpeech(s, utteranceId) {
    var after := startSpeech(s, utteranceId, granted).state;
    if s.mode.CallAudio? || s.hold.HoldPaused? || (!granted && s.hold.NoHold?) {
      UnchangedWorkersKeepPhaseRules(s, after);
    } else {
      RetiringWorkersKeepsRules(s, after);
    }
  }
}

lemma audioModeChanged_ensures(s: SpeechOutput, mode: AudioMode)
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> alwaysWarmupOnlyWhileIdle(audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> alwaysOnlyTheOwnerIsOpen(audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> alwaysWorkerIdsAreUnique(audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> alwaysNoSpeechDuringCall(audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> alwaysSpeakingHasPositiveUtteranceId(audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> alwaysPausedListeningIsSilent(audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> stepRetiredWorkerNeverStartsPlaying(s, audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> stepNoWriteAfterRetireOrTimeout(s, audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> stepOutputReleasedOnce(s, audioModeChanged(s, mode).state))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> stepFirstAudioReportedOnce(s, "audioModeChanged", audioModeChanged(s, mode).state, audioModeChanged(s, mode).out))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> stepFocusAbandonedWhenUnused(s, "audioModeChanged", audioModeChanged(s, mode).state, audioModeChanged(s, mode).out))
  ensures (inv(s) ==> canAudioModeChanged(s, mode) ==> stepStoppedSpeechDropsItsAudio(s, "audioModeChanged", audioModeChanged(s, mode).state, audioModeChanged(s, mode).out))
{
  if inv(s) && canAudioModeChanged(s, mode) {
    var after := audioModeChanged(s, mode).state;
    if mode.NormalAudio? {
      UnchangedWorkersKeepPhaseRules(s, after);
    } else {
      RetiringWorkersKeepsRules(s, after);
    }
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

lemma SelectedWorkerHasId(s: SpeechOutput, id: int)
  requires !workerOf(id, s).phase.NothingOpened?
  ensures workerOf(id, s).workerId == id
{
  var matches := (x: WarmupWorker) => x.workerId == id;
  var selected := ProofLib.Filter(matches, s.workers);
  assert |selected| > 0;
  ProofLib.FilterMember(matches, s.workers, selected[0]);
}

lemma WorkerUpdatePreservesRules(s: SpeechOutput, id: int, worker: WarmupWorker)
  requires inv(s)
  requires worker.workerId == id && worker.closed == workerOf(id, s).closed
  requires workerOf(id, s).phase.Opening? && worker.phase.Looping? ==> !worker.closed
  requires workerOf(id, s).phase.Looping? && worker.phase.Writing? ==> !worker.closed && worker.elapsedMs < warmupLimitMs
  requires worker.phase.Released? ==> workerOf(id, s).phase.CleaningUp? || workerOf(id, s).phase.Released?
  requires finished(workerOf(id, s).phase) ==> worker.phase == workerOf(id, s).phase
  ensures alwaysOnlyTheOwnerIsOpen(updateWorker(id, s, worker))
  ensures alwaysWorkerIdsAreUnique(updateWorker(id, s, worker))
  ensures stepRetiredWorkerNeverStartsPlaying(s, updateWorker(id, s, worker))
  ensures stepNoWriteAfterRetireOrTimeout(s, updateWorker(id, s, worker))
  ensures stepOutputReleasedOnce(s, updateWorker(id, s, worker))
{
  WorkerUpdatePreservesOwnership(s, id, worker);
  var after := updateWorker(id, s, worker);
  forall i | 0 <= i < |s.workers|
    ensures s.workers[i].phase.Opening? && after.workers[i].phase.Looping? ==> !after.workers[i].closed
    ensures s.workers[i].phase.Looping? && after.workers[i].phase.Writing? ==> !after.workers[i].closed && after.workers[i].elapsedMs < warmupLimitMs
    ensures after.workers[i].phase.Released? ==> s.workers[i].phase.CleaningUp? || s.workers[i].phase.Released?
    ensures finished(s.workers[i].phase) ==> after.workers[i].phase == s.workers[i].phase
  {
    var former := s.workers[i];
    assert former in s.workers;
    if former.workerId == id {
      WorkerLookupMatchesMember(s, former);
    }
  }
  WorkerMapPreservesPhaseRules(s, after);
}

lemma openWarmup_ensures(s: SpeechOutput, id: int, opened_: OpenOutcome)
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysWarmupOnlyWhileIdle(openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysOnlyTheOwnerIsOpen(openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysWorkerIdsAreUnique(openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysNoSpeechDuringCall(openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysSpeakingHasPositiveUtteranceId(openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> alwaysPausedListeningIsSilent(openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> stepRetiredWorkerNeverStartsPlaying(s, openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> stepNoWriteAfterRetireOrTimeout(s, openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> stepOutputReleasedOnce(s, openWarmup(s, id, opened_)))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> stepFirstAudioReportedOnce(s, "openWarmup", openWarmup(s, id, opened_), []))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> stepFocusAbandonedWhenUnused(s, "openWarmup", openWarmup(s, id, opened_), []))
  ensures (inv(s) ==> canOpenWarmup(s, id) ==> stepStoppedSpeechDropsItsAudio(s, "openWarmup", openWarmup(s, id, opened_), []))
{
  if inv(s) && canOpenWarmup(s, id) {
    SelectedWorkerHasId(s, id);
    var worker := workerOf(id, s);
    var nextPhase := if opened_.OutputMissing? then WorkerPhase.NothingOpened
      else if opened_.OutputOpened? && !worker.closed then WorkerPhase.Looping else WorkerPhase.CleaningUp;
    WorkerUpdatePreservesRules(s, id, worker.(phase := nextPhase));
  }
}

lemma checkWarmupLoop_ensures(s: SpeechOutput, id: int, elapsedMs: int)
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> alwaysWarmupOnlyWhileIdle(checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> alwaysOnlyTheOwnerIsOpen(checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> alwaysWorkerIdsAreUnique(checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> alwaysNoSpeechDuringCall(checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> alwaysSpeakingHasPositiveUtteranceId(checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> alwaysPausedListeningIsSilent(checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> stepRetiredWorkerNeverStartsPlaying(s, checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> stepNoWriteAfterRetireOrTimeout(s, checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> stepOutputReleasedOnce(s, checkWarmupLoop(s, id, elapsedMs)))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> stepFirstAudioReportedOnce(s, "checkWarmupLoop", checkWarmupLoop(s, id, elapsedMs), []))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> stepFocusAbandonedWhenUnused(s, "checkWarmupLoop", checkWarmupLoop(s, id, elapsedMs), []))
  ensures (inv(s) ==> canCheckWarmupLoop(s, id, elapsedMs) ==> stepStoppedSpeechDropsItsAudio(s, "checkWarmupLoop", checkWarmupLoop(s, id, elapsedMs), []))
{
  if inv(s) && canCheckWarmupLoop(s, id, elapsedMs) {
    SelectedWorkerHasId(s, id);
    var worker := workerOf(id, s);
    var nextPhase := if worker.closed || elapsedMs >= warmupLimitMs then WorkerPhase.CleaningUp else WorkerPhase.Writing;
    WorkerUpdatePreservesRules(s, id, worker.(elapsedMs := elapsedMs, phase := nextPhase));
  }
}

lemma finishWarmupWrite_ensures(s: SpeechOutput, id: int, written: bool)
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysWarmupOnlyWhileIdle(finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysOnlyTheOwnerIsOpen(finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysWorkerIdsAreUnique(finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysNoSpeechDuringCall(finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysSpeakingHasPositiveUtteranceId(finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> alwaysPausedListeningIsSilent(finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> stepRetiredWorkerNeverStartsPlaying(s, finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> stepNoWriteAfterRetireOrTimeout(s, finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> stepOutputReleasedOnce(s, finishWarmupWrite(s, id, written)))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> stepFirstAudioReportedOnce(s, "finishWarmupWrite", finishWarmupWrite(s, id, written), []))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> stepFocusAbandonedWhenUnused(s, "finishWarmupWrite", finishWarmupWrite(s, id, written), []))
  ensures (inv(s) ==> canFinishWarmupWrite(s, id) ==> stepStoppedSpeechDropsItsAudio(s, "finishWarmupWrite", finishWarmupWrite(s, id, written), []))
{
  if inv(s) && canFinishWarmupWrite(s, id) {
    SelectedWorkerHasId(s, id);
    var worker := workerOf(id, s);
    var nextPhase := if written then WorkerPhase.Looping else WorkerPhase.CleaningUp;
    WorkerUpdatePreservesRules(s, id, worker.(phase := nextPhase));
  }
}

lemma releaseWarmup_ensures(s: SpeechOutput, id: int)
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysWarmupOnlyWhileIdle(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysOnlyTheOwnerIsOpen(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysWorkerIdsAreUnique(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysNoSpeechDuringCall(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysSpeakingHasPositiveUtteranceId(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> alwaysPausedListeningIsSilent(releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepRetiredWorkerNeverStartsPlaying(s, releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepNoWriteAfterRetireOrTimeout(s, releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepOutputReleasedOnce(s, releaseWarmup(s, id)))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepFirstAudioReportedOnce(s, "releaseWarmup", releaseWarmup(s, id), []))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepFocusAbandonedWhenUnused(s, "releaseWarmup", releaseWarmup(s, id), []))
  ensures (inv(s) ==> canReleaseWarmup(s, id) ==> stepStoppedSpeechDropsItsAudio(s, "releaseWarmup", releaseWarmup(s, id), []))
{
  if inv(s) && canReleaseWarmup(s, id) {
    SelectedWorkerHasId(s, id);
    var worker := workerOf(id, s);
    WorkerUpdatePreservesRules(s, id, worker.(phase := WorkerPhase.Released));
  }
}

lemma requestWarmup_ensures(s: SpeechOutput, id: int)
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> alwaysWarmupOnlyWhileIdle(requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> alwaysOnlyTheOwnerIsOpen(requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> alwaysWorkerIdsAreUnique(requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> alwaysNoSpeechDuringCall(requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> alwaysSpeakingHasPositiveUtteranceId(requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> alwaysPausedListeningIsSilent(requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> stepRetiredWorkerNeverStartsPlaying(s, requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> stepNoWriteAfterRetireOrTimeout(s, requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> stepOutputReleasedOnce(s, requestWarmup(s, id)))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> stepFirstAudioReportedOnce(s, "requestWarmup", requestWarmup(s, id), []))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> stepFocusAbandonedWhenUnused(s, "requestWarmup", requestWarmup(s, id), []))
  ensures (inv(s) ==> canRequestWarmup(s, id) ==> stepStoppedSpeechDropsItsAudio(s, "requestWarmup", requestWarmup(s, id), []))
{
  if inv(s) && canRequestWarmup(s, id) {
    var retired := stopWarmup(s);
    RetiringWorkersKeepsRules(s, retired);
    var opening := WarmupWorker(id, WorkerPhase.Opening, false, 0);
    var after := requestWarmup(s, id);
    assert after.workers == retired.workers + [opening] && after.owner == id;
    forall w | w in retired.workers
      ensures w.workerId != id
    {
      var i :| 0 <= i < |retired.workers| && retired.workers[i] == w;
      assert s.workers[i] in s.workers;
      assert w.workerId == s.workers[i].workerId;
    }
    ProofLib.FilterNone((x: WarmupWorker) => x.workerId == id, retired.workers);
    forall w | w in after.workers
      ensures w.workerId > 0 && |ProofLib.Filter((x: WarmupWorker) => x.workerId == w.workerId, after.workers)| == 1
      ensures w.workerId != after.owner ==> w.closed
    {
      var matches := (x: WarmupWorker) => x.workerId == w.workerId;
      ProofLib.FilterAppend(matches, retired.workers, opening);
      if w != opening {
        assert w in retired.workers && w.workerId != id;
        assert |ProofLib.Filter(matches, retired.workers)| == 1;
      } else {
        assert |ProofLib.Filter(matches, retired.workers)| == 0;
      }
    }
    forall w | w in after.workers
      ensures startedPlaying(s, w) ==> !w.closed
      ensures startedWriting(s, w) ==> !w.closed && w.elapsedMs < warmupLimitMs
      ensures w.phase.Released? ==> workerOf(w.workerId, s).phase.CleaningUp? || workerOf(w.workerId, s).phase.Released?
    {
      if w != opening {
        assert w in retired.workers;
      }
    }
    forall w | w in s.workers && finished(w.phase)
      ensures workerOf(w.workerId, after).phase == w.phase
    {
      assert w.workerId != id;
      var matches := (x: WarmupWorker) => x.workerId == w.workerId;
      ProofLib.FilterAppend(matches, retired.workers, opening);
      assert workerOf(w.workerId, after) == workerOf(w.workerId, retired);
    }
  }
}

lemma openListening_ensures(s: SpeechOutput, granted: bool)
  ensures (inv(s) ==> canOpenListening(s) ==> alwaysWarmupOnlyWhileIdle(openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> alwaysOnlyTheOwnerIsOpen(openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> alwaysWorkerIdsAreUnique(openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> alwaysNoSpeechDuringCall(openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> alwaysSpeakingHasPositiveUtteranceId(openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> alwaysPausedListeningIsSilent(openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> stepRetiredWorkerNeverStartsPlaying(s, openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> stepNoWriteAfterRetireOrTimeout(s, openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> stepOutputReleasedOnce(s, openListening(s, granted).state))
  ensures (inv(s) ==> canOpenListening(s) ==> stepFirstAudioReportedOnce(s, "openListening", openListening(s, granted).state, openListening(s, granted).out))
  ensures (inv(s) ==> canOpenListening(s) ==> stepFocusAbandonedWhenUnused(s, "openListening", openListening(s, granted).state, openListening(s, granted).out))
  ensures (inv(s) ==> canOpenListening(s) ==> stepStoppedSpeechDropsItsAudio(s, "openListening", openListening(s, granted).state, openListening(s, granted).out))
{
  if inv(s) && canOpenListening(s) {
    UnchangedWorkersKeepPhaseRules(s, openListening(s, granted).state);
  }
}

lemma closeListening_ensures(s: SpeechOutput)
  ensures (inv(s) ==> canCloseListening(s) ==> alwaysWarmupOnlyWhileIdle(closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> alwaysOnlyTheOwnerIsOpen(closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> alwaysWorkerIdsAreUnique(closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> alwaysNoSpeechDuringCall(closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> alwaysSpeakingHasPositiveUtteranceId(closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> alwaysPausedListeningIsSilent(closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> stepRetiredWorkerNeverStartsPlaying(s, closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> stepNoWriteAfterRetireOrTimeout(s, closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> stepOutputReleasedOnce(s, closeListening(s).state))
  ensures (inv(s) ==> canCloseListening(s) ==> stepFirstAudioReportedOnce(s, "closeListening", closeListening(s).state, closeListening(s).out))
  ensures (inv(s) ==> canCloseListening(s) ==> stepFocusAbandonedWhenUnused(s, "closeListening", closeListening(s).state, closeListening(s).out))
  ensures (inv(s) ==> canCloseListening(s) ==> stepStoppedSpeechDropsItsAudio(s, "closeListening", closeListening(s).state, closeListening(s).out))
{
  if inv(s) && canCloseListening(s) {
    UnchangedWorkersKeepPhaseRules(s, closeListening(s).state);
  }
}

// A volume change leaves the workers as they were.
lemma withVolume_ensures(s: SpeechOutput, v: Volume)
  ensures (inv(s) ==> alwaysWarmupOnlyWhileIdle(withVolume(s, v)))
  ensures (inv(s) ==> alwaysOnlyTheOwnerIsOpen(withVolume(s, v)))
  ensures (inv(s) ==> alwaysWorkerIdsAreUnique(withVolume(s, v)))
  ensures (inv(s) ==> alwaysNoSpeechDuringCall(withVolume(s, v)))
  ensures (inv(s) ==> alwaysSpeakingHasPositiveUtteranceId(withVolume(s, v)))
  ensures (inv(s) ==> alwaysPausedListeningIsSilent(withVolume(s, v)))
  ensures (inv(s) ==> stepRetiredWorkerNeverStartsPlaying(s, withVolume(s, v)))
  ensures (inv(s) ==> stepNoWriteAfterRetireOrTimeout(s, withVolume(s, v)))
  ensures (inv(s) ==> stepOutputReleasedOnce(s, withVolume(s, v)))
  ensures (inv(s) ==> stepFirstAudioReportedOnce(s, "withVolume", withVolume(s, v), []))
  ensures (inv(s) ==> stepFocusAbandonedWhenUnused(s, "withVolume", withVolume(s, v), []))
  ensures (inv(s) ==> stepStoppedSpeechDropsItsAudio(s, "withVolume", withVolume(s, v), []))
{
  if inv(s) {
    UnchangedWorkersKeepPhaseRules(s, withVolume(s, v));
  }
}
