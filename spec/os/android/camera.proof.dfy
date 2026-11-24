lemma dispatchPreview_ensures(s: CameraView)
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysTicketsWereIssued(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysCurrentAnswerIsAwaitedOnlyWhileStarting(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysViewfinderHasForegroundOwner(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysWorkDoesNotComeFromTheFuture(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysPreviewWorkHasTheCurrentReadyPreview(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysRecordingControlRunsOnlyBesideARunningRecording(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> alwaysCurrentVideoStartHasReadyPreview(dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> stepReadyOnlyFromTheCurrentAnswer(s, "dispatchPreview", dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> stepCameraDenialEndsOnlyByGrantRetryOrStop(s, "dispatchPreview", dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> stepRecordingControlIsZoomOrTorch(s, "dispatchPreview", dispatchPreview(s)))
  ensures (inv(s) ==> canDispatchPreview(s) ==> stepConfirmationFollowsFinalization(s, "dispatchPreview", dispatchPreview(s)))
{
  if inv(s) && canDispatchPreview(s) {
    var after := dispatchPreview(s);
    var addedTickets := ProofLib.Filter((set_x: int) => !((set_x in s.inFlight)), [s.epoch]);
    assert after.inFlight == s.inFlight + addedTickets;
    assert s.epoch > 0;
    forall t | t in after.inFlight
      ensures t > 0 && t <= after.epoch
    {
      if t !in s.inFlight {
        assert t in addedTickets;
        ProofLib.FilterMember((set_x: int) => !((set_x in s.inFlight)), [s.epoch], t);
        assert t == s.epoch;
      }
    }
  }
}

lemma observePreview_ensures(s: CameraView, ticket: int, previewAnswer: CameraAnswer)
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysTicketsWereIssued(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysCurrentAnswerIsAwaitedOnlyWhileStarting(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysViewfinderHasForegroundOwner(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysWorkDoesNotComeFromTheFuture(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysPreviewWorkHasTheCurrentReadyPreview(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysRecordingControlRunsOnlyBesideARunningRecording(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> alwaysCurrentVideoStartHasReadyPreview(observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> stepReadyOnlyFromTheCurrentAnswer(s, "observePreview", observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> stepCameraDenialEndsOnlyByGrantRetryOrStop(s, "observePreview", observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> stepRecordingControlIsZoomOrTorch(s, "observePreview", observePreview(s, ticket, previewAnswer)))
  ensures (inv(s) ==> canObservePreview(s, ticket) ==> stepConfirmationFollowsFinalization(s, "observePreview", observePreview(s, ticket, previewAnswer)))
{
  if inv(s) && canObservePreview(s, ticket) {
    var after := observePreview(s, ticket, previewAnswer);
    assert after.inFlight == ProofLib.Filter((set_x: int) => !((set_x in [ticket])), s.inFlight);
    assert after.epoch == s.epoch;
    forall t | t in after.inFlight
      ensures t in s.inFlight && t != ticket && 0 < t <= after.epoch
    {
      ProofLib.FilterMember((set_x: int) => !((set_x in [ticket])), s.inFlight, t);
    }
    if ticket == s.epoch {
      ProofLib.FilterMember((set_x: int) => !((set_x in [ticket])), s.inFlight, s.epoch);
      assert s.epoch !in after.inFlight;
    } else {
      assert after.phase == s.phase && after.foreground == s.foreground;
    }
  }
}
