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
    var p := (set_x: int) => !((set_x in s.inFlight));
    ProofLib.FilterCons(p, [s.epoch]);
    ProofLib.FilterNil(p, [s.epoch][1..]);
    assert after.inFlight == s.inFlight + [s.epoch];
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
    var p := (set_x: int) => !((set_x in [ticket]));
    assert forall x :: x in after.inFlight <==> x in s.inFlight && !(x in [ticket]) by {
      forall x {
        ProofLib.FilterMember(p, s.inFlight, x);
      }
    }
  }
}
