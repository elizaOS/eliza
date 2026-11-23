lemma admit_ensures(s: ReplyStream, verdict: agent__conversation__turns_Admission)
  ensures (inv(s) ==> canAdmit(s) ==> alwaysOnlyAStreamingTurnCarriesText(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> alwaysCaughtUpWhenFree(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> alwaysSnapshotCadence(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> alwaysAnAnnouncedReplyEndsAnswered(admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepOneFrameInFlight(s, "admit", admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepFramesRebuildTheText(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepAppendsNeverClearTheMark(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepMarkFollowsTheText(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepOnlyARestartShortensTheText(s, "admit", admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepCadenceSnapshotsAtLeastDouble(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepProgressNeverTouchesTheText(s, "admit", admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepAcknowledgingNeverTouchesTheText(s, "admit", admit(s, verdict).state))
  ensures (inv(s) ==> canAdmit(s) ==> stepAcknowledgedAtMostOnce(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepReadyAtMostOnce(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepNothingAfterTheEnd(s, admit(s, verdict).state, admit(s, verdict).out))
  ensures (inv(s) ==> canAdmit(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "admit", admit(s, verdict).state, admit(s, verdict).out))
{
  if inv(s) && canAdmit(s) {
    var role := roleFor(verdict);
    if role.Streams? {
      ReplyWriteNextStep(s, "admit", false, s.(role := role, progress := Activity("thinking")));
      assert admit(s, verdict) == writeNext(false, s.(role := role, progress := Activity("thinking")));
    } else {
      ReplyAdmitRoleOnly(s, role);
      assert admit(s, verdict) == StreamStep(s.(role := role), []);
    }
  }
}

lemma frameFlushed_ensures(s: ReplyStream)
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysOnlyAStreamingTurnCarriesText(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysCaughtUpWhenFree(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysSnapshotCadence(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> alwaysAnAnnouncedReplyEndsAnswered(frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepOneFrameInFlight(s, "frameFlushed", frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepFramesRebuildTheText(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAppendsNeverClearTheMark(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepMarkFollowsTheText(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepOnlyARestartShortensTheText(s, "frameFlushed", frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepCadenceSnapshotsAtLeastDouble(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepProgressNeverTouchesTheText(s, "frameFlushed", frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAcknowledgingNeverTouchesTheText(s, "frameFlushed", frameFlushed(s).state))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAcknowledgedAtMostOnce(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepReadyAtMostOnce(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepNothingAfterTheEnd(s, frameFlushed(s).state, frameFlushed(s).out))
  ensures (inv(s) ==> canFrameFlushed(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "frameFlushed", frameFlushed(s).state, frameFlushed(s).out))
{
  if inv(s) && canFrameFlushed(s) {
    ReplyWriteNextStep(s, "frameFlushed", true, s);
  }
}

lemma appendText_ensures(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysOnlyAStreamingTurnCarriesText(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysCaughtUpWhenFree(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysSnapshotCadence(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> alwaysAnAnnouncedReplyEndsAnswered(appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepOneFrameInFlight(s, "appendText", appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepFramesRebuildTheText(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAppendsNeverClearTheMark(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepMarkFollowsTheText(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepOnlyARestartShortensTheText(s, "appendText", appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepCadenceSnapshotsAtLeastDouble(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepProgressNeverTouchesTheText(s, "appendText", appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAcknowledgingNeverTouchesTheText(s, "appendText", appendText(s, units, provisional).state))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAcknowledgedAtMostOnce(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepReadyAtMostOnce(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepNothingAfterTheEnd(s, appendText(s, units, provisional).state, appendText(s, units, provisional).out))
  ensures (inv(s) ==> canAppendText(s, units) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "appendText", appendText(s, units, provisional).state, appendText(s, units, provisional).out))
{
  if inv(s) && canAppendText(s, units) {
    ReplyWriteNextStep(s, "appendText", false, s.(text := (s.text + units), held := (s.held || provisional)));
  }
}

lemma replaceText_ensures(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysOnlyAStreamingTurnCarriesText(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysCaughtUpWhenFree(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysSnapshotCadence(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> alwaysAnAnnouncedReplyEndsAnswered(replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepOneFrameInFlight(s, "replaceText", replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepFramesRebuildTheText(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAppendsNeverClearTheMark(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepMarkFollowsTheText(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepOnlyARestartShortensTheText(s, "replaceText", replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepCadenceSnapshotsAtLeastDouble(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepProgressNeverTouchesTheText(s, "replaceText", replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAcknowledgingNeverTouchesTheText(s, "replaceText", replaceText(s, units, provisional).state))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAcknowledgedAtMostOnce(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepReadyAtMostOnce(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepNothingAfterTheEnd(s, replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
  ensures (inv(s) ==> canReplaceText(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "replaceText", replaceText(s, units, provisional).state, replaceText(s, units, provisional).out))
{
  if inv(s) && canReplaceText(s) {
    if (core__streamUnits_unitPrefix(s.text, units) && (|units| < |s.text|)) {
      ReplyNothingWritten(s.shown, []);
    } else {
      ReplyWriteNextStep(s, "replaceText", false, s.(text := units, held := provisional));
    }
  }
}

lemma restartText_ensures(s: ReplyStream, units: seq<int>, provisional: bool)
  ensures (inv(s) ==> canRestartText(s) ==> alwaysOnlyAStreamingTurnCarriesText(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> alwaysCaughtUpWhenFree(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> alwaysSnapshotCadence(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> alwaysAnAnnouncedReplyEndsAnswered(restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepOneFrameInFlight(s, "restartText", restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepFramesRebuildTheText(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAppendsNeverClearTheMark(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepMarkFollowsTheText(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepOnlyARestartShortensTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepCadenceSnapshotsAtLeastDouble(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepProgressNeverTouchesTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepAcknowledgingNeverTouchesTheText(s, "restartText", restartText(s, units, provisional).state))
  ensures (inv(s) ==> canRestartText(s) ==> stepAcknowledgedAtMostOnce(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepReadyAtMostOnce(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepNothingAfterTheEnd(s, restartText(s, units, provisional).state, restartText(s, units, provisional).out))
  ensures (inv(s) ==> canRestartText(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "restartText", restartText(s, units, provisional).state, restartText(s, units, provisional).out))
{
  if inv(s) && canRestartText(s) {
    ReplyWriteNextStep(s, "restartText", false, s.(text := units, held := provisional));
  }
}

lemma showProgress_ensures(s: ReplyStream, progress: Progress)
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysOnlyAStreamingTurnCarriesText(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysCaughtUpWhenFree(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysSnapshotCadence(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> alwaysAnAnnouncedReplyEndsAnswered(showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepOneFrameInFlight(s, "showProgress", showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepFramesRebuildTheText(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAppendsNeverClearTheMark(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepMarkFollowsTheText(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepOnlyARestartShortensTheText(s, "showProgress", showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepCadenceSnapshotsAtLeastDouble(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepProgressNeverTouchesTheText(s, "showProgress", showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAcknowledgingNeverTouchesTheText(s, "showProgress", showProgress(s, progress).state))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAcknowledgedAtMostOnce(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepReadyAtMostOnce(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepNothingAfterTheEnd(s, showProgress(s, progress).state, showProgress(s, progress).out))
  ensures (inv(s) ==> canShowProgress(s, progress) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "showProgress", showProgress(s, progress).state, showProgress(s, progress).out))
{
  if inv(s) && canShowProgress(s, progress) {
    ReplyWriteNextStep(s, "showProgress", false, s.(progress := progress));
  }
}

lemma acknowledge_ensures(s: ReplyStream, units: seq<int>)
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysOnlyAStreamingTurnCarriesText(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysCaughtUpWhenFree(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysSnapshotCadence(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> alwaysAnAnnouncedReplyEndsAnswered(acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepOneFrameInFlight(s, "acknowledge", acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepFramesRebuildTheText(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAppendsNeverClearTheMark(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepMarkFollowsTheText(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepOnlyARestartShortensTheText(s, "acknowledge", acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepCadenceSnapshotsAtLeastDouble(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepProgressNeverTouchesTheText(s, "acknowledge", acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAcknowledgingNeverTouchesTheText(s, "acknowledge", acknowledge(s, units).state))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAcknowledgedAtMostOnce(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepReadyAtMostOnce(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepNothingAfterTheEnd(s, acknowledge(s, units).state, acknowledge(s, units).out))
  ensures (inv(s) ==> canAcknowledge(s, units) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "acknowledge", acknowledge(s, units).state, acknowledge(s, units).out))
{
  if inv(s) && canAcknowledge(s, units) {
    ReplyWriteNextStep(s, "acknowledge", false, s.(ack := AckWaiting(units)));
  }
}

lemma announceReply_ensures(s: ReplyStream, units: seq<int>, results: int)
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysOnlyAStreamingTurnCarriesText(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysCaughtUpWhenFree(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysSnapshotCadence(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> alwaysAnAnnouncedReplyEndsAnswered(announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepOneFrameInFlight(s, "announceReply", announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepFramesRebuildTheText(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAppendsNeverClearTheMark(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepMarkFollowsTheText(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepOnlyARestartShortensTheText(s, "announceReply", announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepCadenceSnapshotsAtLeastDouble(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepProgressNeverTouchesTheText(s, "announceReply", announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAcknowledgingNeverTouchesTheText(s, "announceReply", announceReply(s, units, results).state))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAcknowledgedAtMostOnce(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepReadyAtMostOnce(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepNothingAfterTheEnd(s, announceReply(s, units, results).state, announceReply(s, units, results).out))
  ensures (inv(s) ==> canAnnounceReply(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "announceReply", announceReply(s, units, results).state, announceReply(s, units, results).out))
{
  if inv(s) && canAnnounceReply(s) {
    ReplyWriteNextStep(s, "announceReply", false, s.(ready := ReadyPending(units, results)));
  }
}

lemma finish_ensures(s: ReplyStream, reply: int, units: seq<int>, kind: agent__conversation__turns_ReplyKind, results: int)
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysOnlyAStreamingTurnCarriesText(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysCaughtUpWhenFree(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysSnapshotCadence(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> alwaysAnAnnouncedReplyEndsAnswered(finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepOneFrameInFlight(s, "finish", finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepFramesRebuildTheText(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAppendsNeverClearTheMark(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepMarkFollowsTheText(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepOnlyARestartShortensTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepCadenceSnapshotsAtLeastDouble(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepProgressNeverTouchesTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAcknowledgingNeverTouchesTheText(s, "finish", finish(s, reply, units, kind, results).state))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAcknowledgedAtMostOnce(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepReadyAtMostOnce(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepNothingAfterTheEnd(s, finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
  ensures (inv(s) ==> canFinish(s, reply, kind, results) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "finish", finish(s, reply, units, kind, results).state, finish(s, reply, units, kind, results).out))
{
  if inv(s) && canFinish(s, reply, kind, results) {
    ReplyWriteNextStep(s, "finish", false, s.(progress := Progress.NoProgress, phase := Finishing(Done(reply, units, results, agent__conversation__turns_failureKind(kind)))));
  }
}

lemma answerError_ensures(s: ReplyStream, code: string)
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysOnlyAStreamingTurnCarriesText(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysCaughtUpWhenFree(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysSnapshotCadence(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> alwaysAnAnnouncedReplyEndsAnswered(answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepOneFrameInFlight(s, "answerError", answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepFramesRebuildTheText(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAppendsNeverClearTheMark(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepMarkFollowsTheText(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepOnlyARestartShortensTheText(s, "answerError", answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepCadenceSnapshotsAtLeastDouble(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepProgressNeverTouchesTheText(s, "answerError", answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAcknowledgingNeverTouchesTheText(s, "answerError", answerError(s, code).state))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAcknowledgedAtMostOnce(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepReadyAtMostOnce(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepNothingAfterTheEnd(s, answerError(s, code).state, answerError(s, code).out))
  ensures (inv(s) ==> canAnswerError(s, code) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "answerError", answerError(s, code).state, answerError(s, code).out))
{
  if inv(s) && canAnswerError(s, code) {
    ReplyWriteNextStep(s, "answerError", false, s.(progress := Progress.NoProgress, phase := Finishing(Errored(code))));
  }
}

lemma clientLeft_ensures(s: ReplyStream)
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysOnlyAStreamingTurnCarriesText(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysCaughtUpWhenFree(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysSnapshotCadence(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> alwaysAnAnnouncedReplyEndsAnswered(clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepOneFrameInFlight(s, "clientLeft", clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepFramesRebuildTheText(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAppendsNeverClearTheMark(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepMarkFollowsTheText(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepOnlyARestartShortensTheText(s, "clientLeft", clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepCadenceSnapshotsAtLeastDouble(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepProgressNeverTouchesTheText(s, "clientLeft", clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAcknowledgingNeverTouchesTheText(s, "clientLeft", clientLeft(s).state))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAcknowledgedAtMostOnce(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepReadyAtMostOnce(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepNothingAfterTheEnd(s, clientLeft(s).state, clientLeft(s).out))
  ensures (inv(s) ==> canClientLeft(s) ==> stepLeavingAbortsOnlyAnOwnRunningTurn(s, "clientLeft", clientLeft(s).state, clientLeft(s).out))
{
  if inv(s) && canClientLeft(s) {
    ReplyNothingWritten(s.shown, clientLeft(s).out);
  }
}

// spec/agent/conversation/replyStream.md: the frames written rebuild exactly the text the client holds.
lemma {:induction false} ReplySliceFrom(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires start <= offset <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[..end - offset]
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if offset == end {
    ReplySlicePast(xs, start, end, offset, acc);
  } else {
    var next := core__streamUnits_SliceWalk(offset + 1, acc + [xs[0]]);
    assert f(core__streamUnits_SliceWalk(offset, acc), xs[0]) == next;
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    ReplySliceFrom(xs[1..], start, end, offset + 1, acc + [xs[0]]);
    assert xs[..end - offset] == [xs[0]] + xs[1..][..end - offset - 1];
  }
}

lemma {:induction false} ReplySlicePast(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires offset >= end
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if |xs| > 0 {
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset + 1, acc), xs[1..]);
    ReplySlicePast(xs[1..], start, end, offset + 1, acc);
  }
}

lemma {:induction false} ReplySliceBefore(xs: seq<int>, start: int, end: int, offset: int, acc: seq<int>)
  requires offset <= start <= end <= offset + |xs|
  ensures Std.Collections.Seq.FoldLeft((walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units)), core__streamUnits_SliceWalk(offset, acc), xs).units == acc + xs[start - offset..end - offset]
  decreases |xs|
{
  var f := (walk: core__streamUnits_SliceWalk, code: int) => core__streamUnits_SliceWalk((walk.offset + 1), (if ((walk.offset >= start) && (walk.offset < end)) then (walk.units + [code]) else walk.units));
  if offset == start {
    ReplySliceFrom(xs, start, end, offset, acc);
    assert xs[start - offset..end - offset] == xs[..end - offset];
  } else {
    assert Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset, acc), xs) == Std.Collections.Seq.FoldLeft(f, core__streamUnits_SliceWalk(offset + 1, acc), xs[1..]);
    ReplySliceBefore(xs[1..], start, end, offset + 1, acc);
    assert xs[1..][start - offset - 1..end - offset - 1] == xs[start - offset..end - offset];
  }
}

lemma ReplySlice(units: seq<int>, start: int, end: int)
  requires 0 <= start <= end <= |units|
  ensures core__streamUnits_sliceUnits(units, start, end) == units[start..end]
{
  ReplySliceBefore(units, start, end, 0, []);
}

lemma ReplyAppendRebuilds(text: seq<int>, shown: seq<int>)
  requires core__streamUnits_unitPrefix(text, shown)
  ensures shown + core__streamUnits_sliceUnits(text, |shown|, |text|) == text
{
  ReplySlice(text, 0, |shown|);
  ReplySlice(text, |shown|, |text|);
  assert text == text[0..|shown|] + text[|shown|..|text|];
}

lemma ReplyWrittenShort(out: seq<Effect>)
  requires |out| <= 1
  ensures written(out) == (if |out| == 1 && out[0].Write? then [out[0].frame] else [])
{
  var f := (acc: seq<Frame>, e: Effect) => (if e.Write? then (acc + [e.frame]) else acc);
  if |out| == 1 {
    assert Std.Collections.Seq.FoldLeft(f, [], out) == Std.Collections.Seq.FoldLeft(f, f([], out[0]), out[1..]);
    assert out[1..] == [];
  }
}

lemma ReplyRebuiltShort(shown: seq<int>, out: seq<Effect>)
  requires |out| <= 1
  ensures rebuilt(shown, out) == (if |out| == 1 && out[0].Write? then applyFrame(shown, out[0].frame) else shown)
{
  ReplyWrittenShort(out);
  var g := (acc: seq<int>, f: Frame) => applyFrame(acc, f);
  if |out| == 1 && out[0].Write? {
    var w := [out[0].frame];
    assert Std.Collections.Seq.FoldLeft(g, shown, w) == Std.Collections.Seq.FoldLeft(g, g(shown, w[0]), w[1..]);
    assert w[1..] == [];
  }
}

// spec/agent/conversation/replyStream.md: a frame is written only when the one before it has left.
lemma ReplyWriteNextShape(left: bool, t: ReplyStream)
  ensures |writeNext(left, t).out| <= 1
  ensures forall e :: e in writeNext(left, t).out ==> e.Write?
  ensures written(writeNext(left, t).out) == (if |writeNext(left, t).out| == 1 then [writeNext(left, t).out[0].frame] else [])
  ensures rebuilt(t.shown, writeNext(left, t).out) == writeNext(left, t).state.shown
  ensures writeNext(left, t).state.text == t.text && writeNext(left, t).state.held == t.held && writeNext(left, t).state.role == t.role
{
  var r := writeNext(left, t);
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  ReplyWrittenShort(r.out);
  ReplyRebuiltShort(t.shown, r.out);
  if !t2.inFlight && isOpen(t2.phase) && !ackWaiting(t2.ack) && textPending(t2) && appendable(t2) {
    ReplyAppendRebuilds(t2.text, t2.shown);
  }
}

// spec/agent/conversation/replyStream.md: every rule of the stream holds after a frame is offered to the transport.
lemma ReplyStepRoles(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures alwaysOnlyAStreamingTurnCarriesText(writeNext(left, t).state)
{
  ReplyWriteNextShape(left, t);
  hide *;
  reveal writeNext, inv, isOpen, isFinishing, isSent, isEnded, ending, endText, ackWaiting, readyPending, readySent, textPending, appendable, cadenceDue, threshold, textFrame, ackFrame, readyFrame, doneAgrees, announcedResults, core__streamUnits_unitPrefix, alwaysOnlyAStreamingTurnCarriesText, alwaysCaughtUpWhenFree, alwaysSnapshotCadence, alwaysAnAnnouncedReplyEndsAnswered;
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  if t2.inFlight {
  } else if isFinishing(t2.phase) {
  } else if !isOpen(t2.phase) {
  } else if ackWaiting(t2.ack) {
  } else if textPending(t2) {
    if !appendable(t2) {
    } else if cadenceDue(t2) {
    } else {
    }
  } else if readyPending(t2.ready) {
  } else if !t2.progress.NoProgress? {
  } else {
  }
}

lemma ReplyStepCaughtUp(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures alwaysCaughtUpWhenFree(writeNext(left, t).state)
{
  ReplyWriteNextShape(left, t);
  hide *;
  reveal writeNext, inv, isOpen, isFinishing, isSent, isEnded, ending, endText, ackWaiting, readyPending, readySent, textPending, appendable, cadenceDue, threshold, textFrame, ackFrame, readyFrame, doneAgrees, announcedResults, core__streamUnits_unitPrefix, alwaysOnlyAStreamingTurnCarriesText, alwaysCaughtUpWhenFree, alwaysSnapshotCadence, alwaysAnAnnouncedReplyEndsAnswered;
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  if t2.inFlight {
  } else if isFinishing(t2.phase) {
  } else if !isOpen(t2.phase) {
  } else if ackWaiting(t2.ack) {
  } else if textPending(t2) {
    if !appendable(t2) {
    } else if cadenceDue(t2) {
    } else {
    }
  } else if readyPending(t2.ready) {
  } else if !t2.progress.NoProgress? {
  } else {
  }
}

lemma ReplyStepCadence(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures alwaysSnapshotCadence(writeNext(left, t).state)
{
  ReplyWriteNextShape(left, t);
  hide *;
  reveal writeNext, inv, isOpen, isFinishing, isSent, isEnded, ending, endText, ackWaiting, readyPending, readySent, textPending, appendable, cadenceDue, threshold, textFrame, ackFrame, readyFrame, doneAgrees, announcedResults, core__streamUnits_unitPrefix, alwaysOnlyAStreamingTurnCarriesText, alwaysCaughtUpWhenFree, alwaysSnapshotCadence, alwaysAnAnnouncedReplyEndsAnswered;
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  if t2.inFlight {
  } else if isFinishing(t2.phase) {
  } else if !isOpen(t2.phase) {
  } else if ackWaiting(t2.ack) {
  } else if textPending(t2) {
    if !appendable(t2) {
    } else if cadenceDue(t2) {
    } else {
    }
  } else if readyPending(t2.ready) {
  } else if !t2.progress.NoProgress? {
  } else {
  }
}

lemma ReplyStepAnnounced(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures alwaysAnAnnouncedReplyEndsAnswered(writeNext(left, t).state)
{
  hide *;
  reveal writeNext, isOpen, isFinishing, isSent, ending, alwaysAnAnnouncedReplyEndsAnswered, ackWaiting, textPending, readyPending, readySent;
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  var r := writeNext(left, t);
  if t2.inFlight {
    assert r.state == t2;
  } else if isFinishing(t2.phase) {
    assert r.state.phase == Ended(ending(t2.phase)) && r.state.ready == t.ready;
    assert ending(r.state.phase) == ending(t.phase);
  } else if !isOpen(t2.phase) {
    assert r.state == t2;
  } else {
    assert isOpen(r.state.phase);
  }
}

lemma ReplyStepAlways(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures alwaysOnlyAStreamingTurnCarriesText(writeNext(left, t).state)
  ensures alwaysCaughtUpWhenFree(writeNext(left, t).state)
  ensures alwaysSnapshotCadence(writeNext(left, t).state)
  ensures alwaysAnAnnouncedReplyEndsAnswered(writeNext(left, t).state)
{
  ReplyStepRoles(b, via, left, t);
  ReplyStepCaughtUp(b, via, left, t);
  ReplyStepCadence(b, via, left, t);
  ReplyStepAnnounced(b, via, left, t);
}

lemma ReplyStepFrames(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures stepOneFrameInFlight(b, via, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepFramesRebuildTheText(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepAppendsNeverClearTheMark(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepMarkFollowsTheText(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepCadenceSnapshotsAtLeastDouble(b, writeNext(left, t).state, writeNext(left, t).out)
{
  ReplyWriteNextShape(left, t);
  hide *;
  reveal writeNext, inv, isOpen, isFinishing, isSent, isEnded, ending, endText, ackWaiting, readyPending, readySent, textPending, appendable, cadenceDue, threshold, textFrame, ackFrame, readyFrame, doneAgrees, announcedResults, core__streamUnits_unitPrefix, alwaysSnapshotCadence, alwaysOnlyAStreamingTurnCarriesText, stepOneFrameInFlight, stepFramesRebuildTheText, stepAppendsNeverClearTheMark, stepMarkFollowsTheText, stepCadenceSnapshotsAtLeastDouble, markOf, isTextFrame;
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  if t2.inFlight {
  } else if isFinishing(t2.phase) {
  } else if !isOpen(t2.phase) {
  } else if ackWaiting(t2.ack) {
  } else if textPending(t2) {
    if !appendable(t2) {
    } else if cadenceDue(t2) {
    } else {
    }
  } else if readyPending(t2.ready) {
  } else if !t2.progress.NoProgress? {
  } else {
  }
}

lemma ReplyStepOrder(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures stepOnlyARestartShortensTheText(b, via, writeNext(left, t).state)
  ensures stepProgressNeverTouchesTheText(b, via, writeNext(left, t).state)
  ensures stepAcknowledgingNeverTouchesTheText(b, via, writeNext(left, t).state)
  ensures stepAcknowledgedAtMostOnce(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepReadyAtMostOnce(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepNothingAfterTheEnd(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepLeavingAbortsOnlyAnOwnRunningTurn(b, via, writeNext(left, t).state, writeNext(left, t).out)
{
  ReplyWriteNextShape(left, t);
  hide *;
  reveal writeNext, inv, isOpen, isFinishing, isSent, isEnded, ending, endText, ackWaiting, readyPending, readySent, textPending, appendable, cadenceDue, threshold, textFrame, ackFrame, readyFrame, doneAgrees, announcedResults, core__streamUnits_unitPrefix, stepOnlyARestartShortensTheText, stepProgressNeverTouchesTheText, stepAcknowledgingNeverTouchesTheText, stepAcknowledgedAtMostOnce, stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame, stepReadyAtMostOnce, stepNothingAfterTheEnd, stepLeavingAbortsOnlyAnOwnRunningTurn, isAckFrame, isReadyFrame, isReadySent, alwaysCaughtUpWhenFree;
  var t2 := t.(inFlight := (t.inFlight && !(left)));
  if t2.inFlight {
  } else if isFinishing(t2.phase) {
  } else if !isOpen(t2.phase) {
  } else if ackWaiting(t2.ack) {
    assert writeNext(left, t).out == [Write(ackFrame(t2.ack))];
    assert isAckFrame(ackFrame(t2.ack)) && ackFrame(t2.ack) in written(writeNext(left, t).out);
  } else if textPending(t2) {
    if !appendable(t2) {
    } else if cadenceDue(t2) {
    } else {
    }
  } else if readyPending(t2.ready) {
  } else if !t2.progress.NoProgress? {
  } else {
  }
}

lemma ReplyWriteNextStep(b: ReplyStream, via: string, left: bool, t: ReplyStream)
  requires inv(b)
  requires t.role == b.role || (b.role.Undecided? && t.role.Streams?)
  requires t.role.Streams? || t.role.Waits?
  requires t.shown == b.shown && t.shownHeld == b.shownHeld && t.sinceSnapshot == b.sinceSnapshot && t.lastSnapshot == b.lastSnapshot && t.inFlight == b.inFlight
  requires left ==> via == "frameFlushed"
  requires via != "clientLeft"
  requires t.ack == b.ack || (b.ack.Unacknowledged? && t.ack.AckWaiting?)
  requires t.ready == b.ready || (b.ready.NotReady? && t.ready.ReadyPending?)
  requires t.phase == b.phase || (isOpen(b.phase) && isFinishing(t.phase))
  requires (core__streamUnits_unitPrefix(b.text, t.text) && |t.text| < |b.text|) ==> via == "restartText"
  requires via == "showProgress" ==> t.text == b.text && t.held == b.held
  requires via == "acknowledge" ==> t.text == b.text && t.held == b.held && t.progress == b.progress && ackWaiting(t.ack) && isOpen(t.phase)
  requires !t.role.Streams? ==> (t.text == [] && !t.held && t.ack.Unacknowledged? && t.progress.NoProgress? && t.ready.NotReady?)
  requires alwaysAnAnnouncedReplyEndsAnswered(t)
  ensures alwaysOnlyAStreamingTurnCarriesText(writeNext(left, t).state)
  ensures alwaysCaughtUpWhenFree(writeNext(left, t).state)
  ensures alwaysSnapshotCadence(writeNext(left, t).state)
  ensures alwaysAnAnnouncedReplyEndsAnswered(writeNext(left, t).state)
  ensures stepOneFrameInFlight(b, via, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepFramesRebuildTheText(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepAppendsNeverClearTheMark(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepMarkFollowsTheText(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepOnlyARestartShortensTheText(b, via, writeNext(left, t).state)
  ensures stepCadenceSnapshotsAtLeastDouble(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepProgressNeverTouchesTheText(b, via, writeNext(left, t).state)
  ensures stepAcknowledgingNeverTouchesTheText(b, via, writeNext(left, t).state)
  ensures stepAcknowledgedAtMostOnce(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepReadyAtMostOnce(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepNothingAfterTheEnd(b, writeNext(left, t).state, writeNext(left, t).out)
  ensures stepLeavingAbortsOnlyAnOwnRunningTurn(b, via, writeNext(left, t).state, writeNext(left, t).out)
{
  ReplyStepAlways(b, via, left, t);
  ReplyStepFrames(b, via, left, t);
  ReplyStepOrder(b, via, left, t);
}

// spec/agent/conversation/replyStream.md: a repeat waits for its reply, and a refusal opens no stream.
lemma ReplyAdmitRoleAlwaysOnlyAStreamingTurnCarriesText(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures alwaysOnlyAStreamingTurnCarriesText(StreamStep(s.(role := role), []).state)
{
  hide *;
  reveal inv, alwaysOnlyAStreamingTurnCarriesText, isOpen;
}

lemma ReplyAdmitRoleAlwaysCaughtUpWhenFree(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures alwaysCaughtUpWhenFree(StreamStep(s.(role := role), []).state)
{
  hide *;
  reveal alwaysCaughtUpWhenFree;
}

lemma ReplyAdmitRoleAlwaysSnapshotCadence(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures alwaysSnapshotCadence(StreamStep(s.(role := role), []).state)
{
  hide *;
  reveal inv, alwaysSnapshotCadence;
}

lemma ReplyAdmitRoleAlwaysAnAnnouncedReplyEndsAnswered(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures alwaysAnAnnouncedReplyEndsAnswered(StreamStep(s.(role := role), []).state)
{
  hide *;
  reveal inv, alwaysOnlyAStreamingTurnCarriesText, alwaysAnAnnouncedReplyEndsAnswered, isOpen, isFinishing, isSent;
}

lemma ReplyAdmitRoleStepOneFrameInFlight(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepOneFrameInFlight(s, "admit", StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  assert "admit" != "clientLeft" && "admit" != "restartText" && "admit" != "showProgress" && "admit" != "acknowledge" && "admit" != "frameFlushed";
  hide *;
  reveal stepOneFrameInFlight;
}

lemma ReplyAdmitRoleStepFramesRebuildTheText(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepFramesRebuildTheText(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  hide *;
  reveal stepFramesRebuildTheText;
}

lemma ReplyAdmitRoleStepAppendsNeverClearTheMark(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepAppendsNeverClearTheMark(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  hide *;
  reveal stepAppendsNeverClearTheMark;
}

lemma ReplyAdmitRoleStepMarkFollowsTheText(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepMarkFollowsTheText(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  hide *;
  reveal stepMarkFollowsTheText;
}

lemma ReplyAdmitRoleStepOnlyARestartShortensTheText(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepOnlyARestartShortensTheText(s, "admit", StreamStep(s.(role := role), []).state)
{
  ReplyNothingWritten(s.shown, []);
  assert "admit" != "clientLeft" && "admit" != "restartText" && "admit" != "showProgress" && "admit" != "acknowledge" && "admit" != "frameFlushed";
  hide *;
  reveal stepOnlyARestartShortensTheText, core__streamUnits_unitPrefix;
}

lemma ReplyAdmitRoleStepCadenceSnapshotsAtLeastDouble(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepCadenceSnapshotsAtLeastDouble(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  hide *;
  reveal stepCadenceSnapshotsAtLeastDouble;
}

lemma ReplyAdmitRoleStepProgressNeverTouchesTheText(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepProgressNeverTouchesTheText(s, "admit", StreamStep(s.(role := role), []).state)
{
  ReplyNothingWritten(s.shown, []);
  assert "admit" != "clientLeft" && "admit" != "restartText" && "admit" != "showProgress" && "admit" != "acknowledge" && "admit" != "frameFlushed";
  hide *;
  reveal stepProgressNeverTouchesTheText;
}

lemma ReplyAdmitRoleStepAcknowledgingNeverTouchesTheText(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepAcknowledgingNeverTouchesTheText(s, "admit", StreamStep(s.(role := role), []).state)
{
  ReplyNothingWritten(s.shown, []);
  assert "admit" != "clientLeft" && "admit" != "restartText" && "admit" != "showProgress" && "admit" != "acknowledge" && "admit" != "frameFlushed";
  hide *;
  reveal stepAcknowledgingNeverTouchesTheText;
}

lemma ReplyAdmitRoleStepAcknowledgedAtMostOnce(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepAcknowledgedAtMostOnce(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  hide *;
  var after := s.(role := role);
  var out: seq<Effect> := [];
  ReplyNothingWritten(s.shown, out);
  assert after.ack == s.ack;
  reveal stepAcknowledgedAtMostOnce;
  assert stepAcknowledgedAtMostOnce(s, after, out);
  assert StreamStep(after, out).state == after && StreamStep(after, out).out == out;
}

lemma ReplyAdmitRoleStepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  hide *;
  reveal stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame, ackWaiting;
}

lemma ReplyAdmitRoleStepReadyAtMostOnce(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepReadyAtMostOnce(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  hide *;
  var after := s.(role := role);
  var out: seq<Effect> := [];
  ReplyNothingWritten(s.shown, out);
  assert after.ready == s.ready;
  reveal stepReadyAtMostOnce;
  assert stepReadyAtMostOnce(s, after, out);
  assert StreamStep(after, out).state == after && StreamStep(after, out).out == out;
}

lemma ReplyAdmitRoleStepNothingAfterTheEnd(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepNothingAfterTheEnd(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  assert StreamStep(s.(role := role), []).out == [];
  assert forall f :: !(f in written(StreamStep(s.(role := role), []).out));
  assert StreamStep(s.(role := role), []).state.ack == s.ack && StreamStep(s.(role := role), []).state.ready == s.ready && StreamStep(s.(role := role), []).state.phase == s.phase;
  hide *;
  reveal stepNothingAfterTheEnd, isEnded;
}

lemma ReplyAdmitRoleStepLeavingAbortsOnlyAnOwnRunningTurn(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures stepLeavingAbortsOnlyAnOwnRunningTurn(s, "admit", StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyNothingWritten(s.shown, []);
  assert "admit" != "clientLeft" && "admit" != "restartText" && "admit" != "showProgress" && "admit" != "acknowledge" && "admit" != "frameFlushed";
  hide *;
  reveal stepLeavingAbortsOnlyAnOwnRunningTurn;
}

lemma ReplyAdmitRoleOnly(s: ReplyStream, role: Role)
  requires inv(s) && s.role.Undecided? && !role.Streams?
  ensures alwaysOnlyAStreamingTurnCarriesText(StreamStep(s.(role := role), []).state)
  ensures alwaysCaughtUpWhenFree(StreamStep(s.(role := role), []).state)
  ensures alwaysSnapshotCadence(StreamStep(s.(role := role), []).state)
  ensures alwaysAnAnnouncedReplyEndsAnswered(StreamStep(s.(role := role), []).state)
  ensures stepOneFrameInFlight(s, "admit", StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepFramesRebuildTheText(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepAppendsNeverClearTheMark(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepMarkFollowsTheText(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepOnlyARestartShortensTheText(s, "admit", StreamStep(s.(role := role), []).state)
  ensures stepCadenceSnapshotsAtLeastDouble(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepProgressNeverTouchesTheText(s, "admit", StreamStep(s.(role := role), []).state)
  ensures stepAcknowledgingNeverTouchesTheText(s, "admit", StreamStep(s.(role := role), []).state)
  ensures stepAcknowledgedAtMostOnce(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepReadyAtMostOnce(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepNothingAfterTheEnd(s, StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
  ensures stepLeavingAbortsOnlyAnOwnRunningTurn(s, "admit", StreamStep(s.(role := role), []).state, StreamStep(s.(role := role), []).out)
{
  ReplyAdmitRoleAlwaysOnlyAStreamingTurnCarriesText(s, role);
  ReplyAdmitRoleAlwaysCaughtUpWhenFree(s, role);
  ReplyAdmitRoleAlwaysSnapshotCadence(s, role);
  ReplyAdmitRoleAlwaysAnAnnouncedReplyEndsAnswered(s, role);
  ReplyAdmitRoleStepOneFrameInFlight(s, role);
  ReplyAdmitRoleStepFramesRebuildTheText(s, role);
  ReplyAdmitRoleStepAppendsNeverClearTheMark(s, role);
  ReplyAdmitRoleStepMarkFollowsTheText(s, role);
  ReplyAdmitRoleStepOnlyARestartShortensTheText(s, role);
  ReplyAdmitRoleStepCadenceSnapshotsAtLeastDouble(s, role);
  ReplyAdmitRoleStepProgressNeverTouchesTheText(s, role);
  ReplyAdmitRoleStepAcknowledgingNeverTouchesTheText(s, role);
  ReplyAdmitRoleStepAcknowledgedAtMostOnce(s, role);
  ReplyAdmitRoleStepAWaitingAcknowledgmentLeavesOnlyAsItsFrame(s, role);
  ReplyAdmitRoleStepReadyAtMostOnce(s, role);
  ReplyAdmitRoleStepNothingAfterTheEnd(s, role);
  ReplyAdmitRoleStepLeavingAbortsOnlyAnOwnRunningTurn(s, role);
}

lemma ReplyNothingWritten(shown: seq<int>, out: seq<Effect>)
  requires out == [] || out == [Effect.AbortTurn]
  ensures written(out) == []
  ensures rebuilt(shown, out) == shown
{
  ReplyWrittenShort(out);
  ReplyRebuiltShort(shown, out);
}
