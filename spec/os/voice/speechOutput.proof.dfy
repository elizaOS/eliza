lemma focusChanged_ensures(s: SpeechOutput, change: FocusChange)
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysWarmupOnlyWhileIdle(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysOnlyTheOwnerIsOpen(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysWorkerIdsAreUnique(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> alwaysNoSpeechDuringCall(focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepRetiredWorkerNeverStartsPlaying(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepNoWriteAfterRetireOrTimeout(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepOutputReleasedOnce(s, focusChanged(s, change).state))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepFirstAudioReportedOnce(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepFocusAbandonedWhenSpeechStops(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
  ensures (inv(s) ==> canFocusChanged(s, change) ==> stepStoppedSpeechDropsItsAudio(s, "focusChanged", focusChanged(s, change).state, focusChanged(s, change).out))
{
  if inv(s) && canFocusChanged(s, change) {
    var after := focusChanged(s, change).state;
    assert after.workers == s.workers;
    forall w | w in s.workers
      ensures workerOf(w.workerId, s) == w && workerOf(w.workerId, after) == w
    {
      var matches := (x: WarmupWorker) => x.workerId == w.workerId;
      var selected := ProofLib.Filter(matches, s.workers);
      assert |selected| == 1;
      ProofLib.FilterMember(matches, s.workers, w);
      assert selected[0] == w;
    }
    assert stepRetiredWorkerNeverStartsPlaying(s, after);
    assert stepNoWriteAfterRetireOrTimeout(s, after);
    assert stepOutputReleasedOnce(s, after);
  }
}
