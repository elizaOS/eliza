lemma begin_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canBegin(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysOpenWorkUsesTheCurrentKey(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysOnlyALiveSessionCaptures(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysAnEndingSaysWhetherAudioStarted(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysADeviceEndIsAFailure(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysBatchRequestsAreDistinct(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "begin", begin(s).state, begin(s).out))
  ensures (inv(s) ==> canBegin(s) ==> stepTheSessionOpensInOrder(s, begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "begin", begin(s).state, begin(s).out))
  ensures (inv(s) ==> canBegin(s) ==> stepAReplySettlesOnce(s, "begin", begin(s).state, begin(s).out))
  ensures (inv(s) ==> canBegin(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "begin", begin(s).state, begin(s).out))
  ensures (inv(s) ==> canBegin(s) ==> stepABatchRequestSettlesOnce(s, "begin", begin(s).state, begin(s).out))
{
  hide *;
  reveal inv, canBegin, begin, isOpen, asksOf, waitedOf, turnOwner, hasEnded;
  reveal alwaysConsentIsAskedAtMostTwiceWithinItsDeadline, alwaysOpenWorkUsesTheCurrentKey;
  reveal alwaysOnlyALiveSessionCaptures, alwaysAReplyNeverPlaysAheadOfItsAudio;
  reveal alwaysAnEndingSaysWhetherAudioStarted, alwaysADeviceEndIsAFailure, alwaysBatchRequestsAreDistinct;
  reveal stepARefusedKeyIsReportedOnceAndEndsItsRequest, keyReportVersion;
  reveal stepTheSessionOpensInOrder, openingRank;
  reveal stepOnlyTheCaptureATurnBeganInPublishesIt, heardCapture;
  reveal isReplySettled, failedBefore, settledId, closing;
  reveal initial, consentDeadline, cloud__shared__types_millisPerSecond;
  reveal endingOf, failedAfterAudio, failedBeforeAudio;
  if inv(s) && canBegin(s) {
    var actual := begin(s);
    assert !s.phase.Live? && s.reply.NoReply? && actual.state.reply.NoReply?;
    assert actual.out == [SpeechNotice.AskConsent];
    forall n | n in actual.out
      ensures !isReplySettled(n) && failedBefore(n) == -1 && settledId(n) == 0
    {
      assert n == SpeechNotice.AskConsent;
    }
    assert actual.state.batches == s.batches && actual.state.reply == s.reply;
    assert !closing(s, actual.state);
    UnchangedSpeechSettlements(s, "begin", actual.state, actual.out);
  }
}

lemma consentDismissed_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysOpenWorkUsesTheCurrentKey(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysOnlyALiveSessionCaptures(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysAnEndingSaysWhetherAudioStarted(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysADeviceEndIsAFailure(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> alwaysBatchRequestsAreDistinct(consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "consentDismissed", consentDismissed(s).state, consentDismissed(s).out))
  ensures (inv(s) ==> canConsentDismissed(s) ==> stepTheSessionOpensInOrder(s, consentDismissed(s).state))
  ensures (inv(s) ==> canConsentDismissed(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "consentDismissed", consentDismissed(s).state, consentDismissed(s).out))
  ensures (inv(s) ==> canConsentDismissed(s) ==> stepAReplySettlesOnce(s, "consentDismissed", consentDismissed(s).state, consentDismissed(s).out))
  ensures (inv(s) ==> canConsentDismissed(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "consentDismissed", consentDismissed(s).state, consentDismissed(s).out))
  ensures (inv(s) ==> canConsentDismissed(s) ==> stepABatchRequestSettlesOnce(s, "consentDismissed", consentDismissed(s).state, consentDismissed(s).out))
{
  if inv(s) && canConsentDismissed(s) {
    var actual := consentDismissed(s);
    assert !revokeOwed(s.phase) && s.capture.Muted?;
    assert actual.out == [] || actual.out == [SpeechNotice.AskConsent];
    forall n | n in actual.out
      ensures !isReplySettled(n) && failedBefore(n) == -1 && settledId(n) == 0
    {
      assert n == SpeechNotice.AskConsent;
    }
    assert actual.state.batches == s.batches && actual.state.reply == s.reply;
    assert closing(s, actual.state) ==> failureOfEnding(endingOf(actual.state.phase)).NoFailure?;
    UnchangedSpeechSettlements(s, "consentDismissed", actual.state, actual.out);
  }
}

lemma unmute_ensures(s: CloudSpeech, recordAudio: bool)
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysOpenWorkUsesTheCurrentKey(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysOnlyALiveSessionCaptures(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysAnEndingSaysWhetherAudioStarted(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysADeviceEndIsAFailure(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> alwaysBatchRequestsAreDistinct(unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "unmute", unmute(s, recordAudio).state, unmute(s, recordAudio).out))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> stepTheSessionOpensInOrder(s, unmute(s, recordAudio).state))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "unmute", unmute(s, recordAudio).state, unmute(s, recordAudio).out))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> stepAReplySettlesOnce(s, "unmute", unmute(s, recordAudio).state, unmute(s, recordAudio).out))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "unmute", unmute(s, recordAudio).state, unmute(s, recordAudio).out))
  ensures (inv(s) ==> canUnmute(s, recordAudio) ==> stepABatchRequestSettlesOnce(s, "unmute", unmute(s, recordAudio).state, unmute(s, recordAudio).out))
{
  if inv(s) && canUnmute(s, recordAudio) {
    var actual := unmute(s, recordAudio);
    assert actual.out == [SpeechNotice.ReserveLiveCapture];
    forall n | n in actual.out
      ensures !isReplySettled(n) && failedBefore(n) == -1 && settledId(n) == 0
    {
      assert n == SpeechNotice.ReserveLiveCapture;
    }
    assert actual.state.batches == s.batches && actual.state.reply == s.reply;
    assert !closing(s, actual.state);
    UnchangedSpeechSettlements(s, "unmute", actual.state, actual.out);
  }
}

lemma mute_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canMute(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> alwaysOpenWorkUsesTheCurrentKey(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> alwaysOnlyALiveSessionCaptures(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> alwaysAnEndingSaysWhetherAudioStarted(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> alwaysADeviceEndIsAFailure(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> alwaysBatchRequestsAreDistinct(mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "mute", mute(s).state, mute(s).out))
  ensures (inv(s) ==> canMute(s) ==> stepTheSessionOpensInOrder(s, mute(s).state))
  ensures (inv(s) ==> canMute(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "mute", mute(s).state, mute(s).out))
  ensures (inv(s) ==> canMute(s) ==> stepAReplySettlesOnce(s, "mute", mute(s).state, mute(s).out))
  ensures (inv(s) ==> canMute(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "mute", mute(s).state, mute(s).out))
  ensures (inv(s) ==> canMute(s) ==> stepABatchRequestSettlesOnce(s, "mute", mute(s).state, mute(s).out))
{
  if inv(s) && canMute(s) {
    var actual := mute(s);
    assert actual.out == [] || actual.out == [SpeechNotice.ReleaseLiveCapture];
    forall n | n in actual.out
      ensures !isReplySettled(n) && failedBefore(n) == -1 && settledId(n) == 0
    {
      assert n == SpeechNotice.ReleaseLiveCapture;
    }
    assert actual.state.batches == s.batches && actual.state.reply == s.reply;
    assert !closing(s, actual.state);
    UnchangedSpeechSettlements(s, "mute", actual.state, actual.out);
  }
}

lemma UnchangedSpeechSettlements(before: CloudSpeech, via: string, after: CloudSpeech, out: seq<SpeechNotice>)
  requires alwaysBatchRequestsAreDistinct(before)
  requires before.batches == after.batches && before.reply == after.reply
  requires forall n :: n in out ==> !isReplySettled(n) && failedBefore(n) == -1 && settledId(n) == 0
  requires closing(before, after) ==> !before.capture.Listening? && !revokeOwed(before.phase) && failureOfEnding(endingOf(after.phase)).NoFailure?
  ensures stepAReplySettlesOnce(before, via, after, out)
  ensures stepAnEndReleasesRevokesAndReportsOnce(before, via, after, out)
  ensures stepABatchRequestSettlesOnce(before, via, after, out)
{
  NoReplyOrSessionEndReceipt(before, via, after, out);
  UnchangedBatchSettlements(before, via, after, out);
}

lemma NoReplyOrSessionEndReceipt(before: CloudSpeech, via: string, after: CloudSpeech, out: seq<SpeechNotice>)
  requires before.reply == after.reply
  requires forall n :: n in out ==> !isReplySettled(n) && failedBefore(n) == -1
  requires closing(before, after) ==> !before.capture.Listening? && !revokeOwed(before.phase) && failureOfEnding(endingOf(after.phase)).NoFailure?
  ensures stepAReplySettlesOnce(before, via, after, out)
  ensures stepAnEndReleasesRevokesAndReportsOnce(before, via, after, out)
{
  ProofLib.FilterNone((n: SpeechNotice) => isReplySettled(n), out);
  ProofLib.FilterNone((n: SpeechNotice) => (failedBefore(n) != -1), out);
}

lemma UnchangedBatchSettlements(before: CloudSpeech, via: string, after: CloudSpeech, out: seq<SpeechNotice>)
  requires alwaysBatchRequestsAreDistinct(before)
  requires before.batches == after.batches
  requires forall n :: n in out ==> settledId(n) == 0
  ensures stepABatchRequestSettlesOnce(before, via, after, out)
{
  forall b | b in before.batches
    ensures |ProofLib.Filter((n: SpeechNotice) => (settledId(n) == b.requestId), out)| == 0
  {
    assert b.requestId >= 1;
    ProofLib.FilterNone((n: SpeechNotice) => (settledId(n) == b.requestId), out);
  }
  assert stepABatchRequestSettlesOnce(before, via, after, out);
}

lemma stop_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canStop(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysOpenWorkUsesTheCurrentKey(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysOnlyALiveSessionCaptures(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysAnEndingSaysWhetherAudioStarted(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysADeviceEndIsAFailure(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysBatchRequestsAreDistinct(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "stop", stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepTheSessionOpensInOrder(s, stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "stop", stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepAReplySettlesOnce(s, "stop", stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "stop", stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepABatchRequestSettlesOnce(s, "stop", stop(s).state, stop(s).out))
{
  if inv(s) && canStop(s) {
    CloseSpeechReceipts(s, Ending.Stopped, "stop");
  }
}

lemma relayLost_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysOpenWorkUsesTheCurrentKey(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysOnlyALiveSessionCaptures(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysAnEndingSaysWhetherAudioStarted(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysADeviceEndIsAFailure(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> alwaysBatchRequestsAreDistinct(relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "relayLost", relayLost(s).state, relayLost(s).out))
  ensures (inv(s) ==> canRelayLost(s) ==> stepTheSessionOpensInOrder(s, relayLost(s).state))
  ensures (inv(s) ==> canRelayLost(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "relayLost", relayLost(s).state, relayLost(s).out))
  ensures (inv(s) ==> canRelayLost(s) ==> stepAReplySettlesOnce(s, "relayLost", relayLost(s).state, relayLost(s).out))
  ensures (inv(s) ==> canRelayLost(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "relayLost", relayLost(s).state, relayLost(s).out))
  ensures (inv(s) ==> canRelayLost(s) ==> stepABatchRequestSettlesOnce(s, "relayLost", relayLost(s).state, relayLost(s).out))
{
  if inv(s) && canRelayLost(s) {
    var failure := core__capabilityRouting_Failure.RemoteUnreachable;
    var ending := if s.audioStarted then FailedAfterAudio(failure) else FailedBeforeAudio(failure);
    assert relayLost(s) == closeWith(ending, s, [], cloud__shared__types_WaitTime.NoWait);
    CloseSpeechReceipts(s, ending, "relayLost");
  }
}

lemma FilterOptionalSpeechNotice(p: SpeechNotice -> bool, prefix: seq<SpeechNotice>, emit: bool, n: SpeechNotice)
  ensures |ProofLib.Filter(p, prefix + noticeIf(emit, n))| == |ProofLib.Filter(p, prefix)| + (if emit && p(n) then 1 else 0)
{
  hide *;
  reveal noticeIf;
  if emit {
    assert noticeIf(emit, n) == [n];
    ProofLib.FilterAppend(p, prefix, n);
    if p(n) {
      assert |ProofLib.Filter(p, prefix) + [n]| == |ProofLib.Filter(p, prefix)| + 1;
      assert ProofLib.Filter(p, prefix + [n]) == ProofLib.Filter(p, prefix) + [n];
    } else {
      assert ProofLib.Filter(p, prefix + [n]) == ProofLib.Filter(p, prefix);
    }
  } else {
    assert prefix + noticeIf(emit, n) == prefix;
  }
}

lemma CountSpeechCloseReceipts(s: CloudSpeech, ending: Ending, p: SpeechNotice -> bool)
  ensures |ProofLib.Filter(p, closeWith(ending, s, [], cloud__shared__types_WaitTime.NoWait).out)| ==
    (if !s.capture.Muted? && p(SpeechNotice.ReleaseLiveCapture) then 1 else 0)
    + (if replyId(s.reply) != "" && p(ReplySettled(replyId(s.reply), false)) then 1 else 0)
    + (if revokeOwed(s.phase) && p(SpeechNotice.RevokeSession) then 1 else 0)
    + (if !failureOfEnding(ending).NoFailure? && p(SessionFailed(failureOfEnding(ending), !s.audioStarted, cloud__shared__types_WaitTime.NoWait)) then 1 else 0)
{
  var release := SpeechNotice.ReleaseLiveCapture;
  var settle := ReplySettled(replyId(s.reply), false);
  var revoke := SpeechNotice.RevokeSession;
  var failure := SessionFailed(failureOfEnding(ending), !s.audioStarted, cloud__shared__types_WaitTime.NoWait);
  hide *;
  reveal closeWith;
  var released := noticeIf(!s.capture.Muted?, release);
  var settled := released + noticeIf(replyId(s.reply) != "", settle);
  var revoked := settled + noticeIf(revokeOwed(s.phase), revoke);
  var failed := revoked + noticeIf(!failureOfEnding(ending).NoFailure?, failure);
  assert failed == closeWith(ending, s, [], cloud__shared__types_WaitTime.NoWait).out;
  ProofLib.FilterNil(p, []);
  assert [] + released == released;
  FilterOptionalSpeechNotice(p, [], !s.capture.Muted?, release);
  var releaseCount := if !s.capture.Muted? && p(release) then 1 else 0;
  assert |ProofLib.Filter(p, released)| == releaseCount;
  FilterOptionalSpeechNotice(p, released, replyId(s.reply) != "", settle);
  var settleCount := if replyId(s.reply) != "" && p(settle) then 1 else 0;
  assert |ProofLib.Filter(p, settled)| == releaseCount + settleCount;
  FilterOptionalSpeechNotice(p, settled, revokeOwed(s.phase), revoke);
  var revokeCount := if revokeOwed(s.phase) && p(revoke) then 1 else 0;
  assert |ProofLib.Filter(p, revoked)| == releaseCount + settleCount + revokeCount;
  FilterOptionalSpeechNotice(p, revoked, !failureOfEnding(ending).NoFailure?, failure);
  assert |ProofLib.Filter(p, failed)| == releaseCount + settleCount + revokeCount + (if !failureOfEnding(ending).NoFailure? && p(failure) then 1 else 0);
}

lemma CloseSpeechReceipts(before: CloudSpeech, ending: Ending, via: string)
  requires isOpen(before.phase)
  requires alwaysBatchRequestsAreDistinct(before)
  ensures stepARefusedKeyIsReportedOnceAndEndsItsRequest(before, via, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).state, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).out)
  ensures stepAReplySettlesOnce(before, via, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).state, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).out)
  ensures stepAnEndReleasesRevokesAndReportsOnce(before, via, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).state, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).out)
  ensures stepABatchRequestSettlesOnce(before, via, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).state, closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).out)
  ensures forall n :: n in closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait).out ==> settledId(n) == 0 && heardCapture(n) == -1
{
  var closed := closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait);
  var released := noticeIf(!before.capture.Muted?, SpeechNotice.ReleaseLiveCapture);
  var settled := noticeIf(replyId(before.reply) != "", ReplySettled(replyId(before.reply), false));
  var revoked := noticeIf(revokeOwed(before.phase), SpeechNotice.RevokeSession);
  var failed := noticeIf(!failureOfEnding(ending).NoFailure?, SessionFailed(failureOfEnding(ending), !before.audioStarted, cloud__shared__types_WaitTime.NoWait));
  assert closed.out == released + settled + revoked + failed;
  forall n | n in closed.out
    ensures keyReportVersion(n) == -1 && settledId(n) == 0 && heardCapture(n) == -1
    ensures failedBefore(n) == -1 || (failedBefore(n) == 1) == !before.audioStarted
  {
    assert n in released || n in settled || n in revoked || n in failed;
  }
  ProofLib.FilterNone((n: SpeechNotice) => (keyReportVersion(n) != -1), closed.out);
  assert stepARefusedKeyIsReportedOnceAndEndsItsRequest(before, via, closed.state, closed.out);
  CountSpeechCloseReceipts(before, ending, (n: SpeechNotice) => isReplySettled(n));
  assert stepAReplySettlesOnce(before, via, closed.state, closed.out);
  CountSpeechCloseReceipts(before, ending, (n: SpeechNotice) => (failedBefore(n) != -1));
  assert closing(before, closed.state);
  assert before.capture.Listening? ==> SpeechNotice.ReleaseLiveCapture in closed.out;
  assert revokeOwed(before.phase) ==> SpeechNotice.RevokeSession in closed.out;
  assert stepAnEndReleasesRevokesAndReportsOnce(before, via, closed.state, closed.out);
  UnchangedBatchSettlements(before, via, closed.state, closed.out);
}

lemma batchRequested_ensures(s: CloudSpeech, requestId: int, direction: cloud__shared__types_SpeechDirection)
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysOpenWorkUsesTheCurrentKey(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysOnlyALiveSessionCaptures(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysAnEndingSaysWhetherAudioStarted(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysADeviceEndIsAFailure(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> alwaysBatchRequestsAreDistinct(batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "batchRequested", batchRequested(s, requestId, direction), []))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> stepTheSessionOpensInOrder(s, batchRequested(s, requestId, direction)))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "batchRequested", batchRequested(s, requestId, direction), []))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> stepAReplySettlesOnce(s, "batchRequested", batchRequested(s, requestId, direction), []))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "batchRequested", batchRequested(s, requestId, direction), []))
  ensures (inv(s) ==> canBatchRequested(s, requestId, direction) ==> stepABatchRequestSettlesOnce(s, "batchRequested", batchRequested(s, requestId, direction), []))
{
  if inv(s) && canBatchRequested(s, requestId, direction) {
    var requested := batchRequested(s, requestId, direction);
    var added := BatchRequest(requestId, direction, s.credential, BatchVerdict.BatchPending);
    assert requested.batches == s.batches + [added];
    forall b | b in requested.batches
      ensures b.requestId >= 1 && |ProofLib.Filter((x: BatchRequest) => (x.requestId == b.requestId), requested.batches)| == 1
    {
      if b == added {
        assert forall x :: x in s.batches ==> x.requestId != b.requestId;
        ProofLib.FilterNone((x: BatchRequest) => (x.requestId == b.requestId), s.batches);
      } else {
        assert b in s.batches;
        assert b.requestId != added.requestId;
        assert |ProofLib.Filter((x: BatchRequest) => (x.requestId == b.requestId), s.batches)| == 1;
      }
      ProofLib.FilterAppend((x: BatchRequest) => (x.requestId == b.requestId), s.batches, added);
    }
  }
}

lemma batchCancelled_ensures(s: CloudSpeech, requestId: int)
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysOpenWorkUsesTheCurrentKey(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysOnlyALiveSessionCaptures(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysAnEndingSaysWhetherAudioStarted(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysADeviceEndIsAFailure(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> alwaysBatchRequestsAreDistinct(batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "batchCancelled", batchCancelled(s, requestId).state, batchCancelled(s, requestId).out))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> stepTheSessionOpensInOrder(s, batchCancelled(s, requestId).state))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "batchCancelled", batchCancelled(s, requestId).state, batchCancelled(s, requestId).out))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> stepAReplySettlesOnce(s, "batchCancelled", batchCancelled(s, requestId).state, batchCancelled(s, requestId).out))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "batchCancelled", batchCancelled(s, requestId).state, batchCancelled(s, requestId).out))
  ensures (inv(s) ==> canBatchCancelled(s, requestId) ==> stepABatchRequestSettlesOnce(s, "batchCancelled", batchCancelled(s, requestId).state, batchCancelled(s, requestId).out))
{
  if inv(s) && canBatchCancelled(s, requestId) {
    var cancelled := batchCancelled(s, requestId);
    assert cancelled.out == [BatchSettled(requestId, BatchVerdict.BatchCancelled)];
    assert [] + cancelled.out == cancelled.out;
    NoReplyOrSessionEndReceipt(s, "batchCancelled", cancelled.state, cancelled.out);
    SettlePendingBatch(s, requestId, BatchVerdict.BatchCancelled, "batchCancelled", []);
    assert stepABatchRequestSettlesOnce(s, "batchCancelled", cancelled.state, cancelled.out);
  }
}

lemma batchAnswered_ensures(s: CloudSpeech, requestId: int, answer: CloudAnswer)
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysOpenWorkUsesTheCurrentKey(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysOnlyALiveSessionCaptures(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysAnEndingSaysWhetherAudioStarted(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysADeviceEndIsAFailure(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> alwaysBatchRequestsAreDistinct(batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "batchAnswered", batchAnswered(s, requestId, answer).state, batchAnswered(s, requestId, answer).out))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> stepTheSessionOpensInOrder(s, batchAnswered(s, requestId, answer).state))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "batchAnswered", batchAnswered(s, requestId, answer).state, batchAnswered(s, requestId, answer).out))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> stepAReplySettlesOnce(s, "batchAnswered", batchAnswered(s, requestId, answer).state, batchAnswered(s, requestId, answer).out))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "batchAnswered", batchAnswered(s, requestId, answer).state, batchAnswered(s, requestId, answer).out))
  ensures (inv(s) ==> canBatchAnswered(s, requestId) ==> stepABatchRequestSettlesOnce(s, "batchAnswered", batchAnswered(s, requestId, answer).state, batchAnswered(s, requestId, answer).out))
{
  if inv(s) && canBatchAnswered(s, requestId) {
    var answered := batchAnswered(s, requestId, answer);
    var keyNotices := keyReport(answer, s.credential);
    var verdict := verdictOf(answer);
    var settlement := BatchSettled(requestId, verdict);
    assert answered.out == keyNotices + [settlement];
    KeyReportReceiptShape(answer, s.credential);
    assert forall n :: n in keyNotices ==> settledId(n) == 0;
    assert forall n :: n in answered.out ==> !isReplySettled(n) && failedBefore(n) == -1;
    NoReplyOrSessionEndReceipt(s, "batchAnswered", answered.state, answered.out);
    SettlePendingBatch(s, requestId, verdict, "batchAnswered", keyNotices);

    var reportsKey := (n: SpeechNotice) => (keyReportVersion(n) != -1);
    ProofLib.FilterAppend(reportsKey, keyNotices, settlement);
  }
}

lemma MappedBatchIdsStayDistinct(before: CloudSpeech, after: CloudSpeech)
  requires alwaysBatchRequestsAreDistinct(before)
  requires |before.batches| == |after.batches|
  requires forall i :: 0 <= i < |before.batches| ==> before.batches[i].requestId == after.batches[i].requestId
  ensures alwaysBatchRequestsAreDistinct(after)
{
  forall b | b in after.batches
    ensures b.requestId >= 1 && |ProofLib.Filter((x: BatchRequest) => (x.requestId == b.requestId), after.batches)| == 1
  {
    var i :| 0 <= i < |after.batches| && after.batches[i] == b;
    var prior := before.batches[i];
    assert prior in before.batches;
    assert prior.requestId == b.requestId;
    assert prior.requestId >= 1 && |ProofLib.Filter((x: BatchRequest) => (x.requestId == prior.requestId), before.batches)| == 1;
    ProofLib.FilterLengthPointwise((x: BatchRequest) => (x.requestId == b.requestId),
      (x: BatchRequest) => (x.requestId == b.requestId), before.batches, after.batches);
  }
}

lemma MatchesSelectedPending(before: CloudSpeech, b: BatchRequest, requestId: int)
  requires alwaysBatchRequestsAreDistinct(before)
  requires pending(before, requestId)
  requires b in before.batches && b.requestId == requestId
  ensures b.verdict.BatchPending?
{
  var selected :| selected in before.batches && selected.requestId == requestId && selected.verdict.BatchPending?;
  var sameId := (x: BatchRequest) => (x.requestId == b.requestId);
  var matches := ProofLib.Filter(sameId, before.batches);
  assert |matches| == 1;
  ProofLib.FilterMember(sameId, before.batches, b);
  ProofLib.FilterMember(sameId, before.batches, selected);
  assert b in matches && selected in matches;
  assert b == matches[0] && selected == matches[0];
}

lemma SettlePendingBatch(before: CloudSpeech, requestId: int, verdict: BatchVerdict, via: string, prefix: seq<SpeechNotice>)
  requires alwaysBatchRequestsAreDistinct(before)
  requires pending(before, requestId)
  requires !verdict.BatchPending?
  requires forall n :: n in prefix ==> settledId(n) == 0
  ensures alwaysBatchRequestsAreDistinct(settleBatch(requestId, verdict, before).state)
  ensures stepABatchRequestSettlesOnce(before, via, settleBatch(requestId, verdict, before).state, prefix + settleBatch(requestId, verdict, before).out)
{
  var settled := settleBatch(requestId, verdict, before);
  var after := settled.state;
  var notice := BatchSettled(requestId, verdict);
  var out := prefix + settled.out;
  assert out == prefix + [notice];
  assert |before.batches| == |after.batches|;
  forall i | 0 <= i < |before.batches|
    ensures before.batches[i].requestId == after.batches[i].requestId
    ensures after.batches[i] == (if before.batches[i].requestId == requestId then before.batches[i].(verdict := verdict) else before.batches[i])
  {
  }
  MappedBatchIdsStayDistinct(before, after);
  assert !pending(after, requestId) by {
    forall a | a in after.batches && a.requestId == requestId
      ensures !a.verdict.BatchPending?
    {
      var j :| 0 <= j < |after.batches| && after.batches[j] == a;
      assert before.batches[j].requestId == requestId;
      assert a.verdict == verdict;
    }
  }
  forall b | b in before.batches
    ensures exists a :: a in after.batches && a.requestId == b.requestId && (!b.verdict.BatchPending? ==> a.verdict == b.verdict)
    ensures |ProofLib.Filter((n: SpeechNotice) => (settledId(n) == b.requestId), out)| == (if b.verdict.BatchPending? && !pending(after, b.requestId) then 1 else 0)
  {
    var i :| 0 <= i < |before.batches| && before.batches[i] == b;
    var a := after.batches[i];
    assert a in after.batches && a.requestId == b.requestId;
    if b.requestId == requestId {
      MatchesSelectedPending(before, b, requestId);
    } else {
      assert a == b;
      assert b.verdict.BatchPending? ==> pending(after, b.requestId);
    }
    assert b.requestId >= 1;
    ProofLib.FilterNone((n: SpeechNotice) => (settledId(n) == b.requestId), prefix);
    ProofLib.FilterAppend((n: SpeechNotice) => (settledId(n) == b.requestId), prefix, notice);
  }
}

lemma frameArrived_ensures(s: CloudSpeech, frame: cloud__services__speechRelay_ServerFrame)
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysOpenWorkUsesTheCurrentKey(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysOnlyALiveSessionCaptures(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysAnEndingSaysWhetherAudioStarted(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysADeviceEndIsAFailure(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> alwaysBatchRequestsAreDistinct(frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "frameArrived", frameArrived(s, frame).state, frameArrived(s, frame).out))
  ensures (inv(s) ==> canFrameArrived(s) ==> stepTheSessionOpensInOrder(s, frameArrived(s, frame).state))
  ensures (inv(s) ==> canFrameArrived(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "frameArrived", frameArrived(s, frame).state, frameArrived(s, frame).out))
  ensures (inv(s) ==> canFrameArrived(s) ==> stepAReplySettlesOnce(s, "frameArrived", frameArrived(s, frame).state, frameArrived(s, frame).out))
  ensures (inv(s) ==> canFrameArrived(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "frameArrived", frameArrived(s, frame).state, frameArrived(s, frame).out))
  ensures (inv(s) ==> canFrameArrived(s) ==> stepABatchRequestSettlesOnce(s, "frameArrived", frameArrived(s, frame).state, frameArrived(s, frame).out))
{
  if inv(s) && canFrameArrived(s) {
    var actual := frameArrived(s, frame);
    RelayCallbackReceipts(s, "frameArrived", actual);
  }
}

lemma audioArrived_ensures(s: CloudSpeech, utteranceId: string, audioMs: int)
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysOpenWorkUsesTheCurrentKey(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysOnlyALiveSessionCaptures(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysAnEndingSaysWhetherAudioStarted(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysADeviceEndIsAFailure(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> alwaysBatchRequestsAreDistinct(audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "audioArrived", audioArrived(s, utteranceId, audioMs).state, audioArrived(s, utteranceId, audioMs).out))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> stepTheSessionOpensInOrder(s, audioArrived(s, utteranceId, audioMs).state))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "audioArrived", audioArrived(s, utteranceId, audioMs).state, audioArrived(s, utteranceId, audioMs).out))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> stepAReplySettlesOnce(s, "audioArrived", audioArrived(s, utteranceId, audioMs).state, audioArrived(s, utteranceId, audioMs).out))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "audioArrived", audioArrived(s, utteranceId, audioMs).state, audioArrived(s, utteranceId, audioMs).out))
  ensures (inv(s) ==> canAudioArrived(s, utteranceId, audioMs) ==> stepABatchRequestSettlesOnce(s, "audioArrived", audioArrived(s, utteranceId, audioMs).state, audioArrived(s, utteranceId, audioMs).out))
{
  if inv(s) && canAudioArrived(s, utteranceId, audioMs) {
    var actual := audioArrived(s, utteranceId, audioMs);
    RelayCallbackReceipts(s, "audioArrived", actual);
  }
}

lemma played_ensures(s: CloudSpeech, playedMs: int)
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysOpenWorkUsesTheCurrentKey(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysOnlyALiveSessionCaptures(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysAnEndingSaysWhetherAudioStarted(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysADeviceEndIsAFailure(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> alwaysBatchRequestsAreDistinct(played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "played", played(s, playedMs).state, played(s, playedMs).out))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> stepTheSessionOpensInOrder(s, played(s, playedMs).state))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "played", played(s, playedMs).state, played(s, playedMs).out))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> stepAReplySettlesOnce(s, "played", played(s, playedMs).state, played(s, playedMs).out))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "played", played(s, playedMs).state, played(s, playedMs).out))
  ensures (inv(s) ==> canPlayed(s, playedMs) ==> stepABatchRequestSettlesOnce(s, "played", played(s, playedMs).state, played(s, playedMs).out))
{
  if inv(s) && canPlayed(s, playedMs) {
    var actual := played(s, playedMs);
    RelayCallbackReceipts(s, "played", actual);
  }
}

lemma RelayCallbackReceipts(before: CloudSpeech, via: string, actual: SpeechStep)
  requires isOpen(before.phase)
  requires alwaysBatchRequestsAreDistinct(before)
  requires closing(before, actual.state) ==> actual == closeWith(endingOf(actual.state.phase), before, [], cloud__shared__types_WaitTime.NoWait)
  requires !closing(before, actual.state) ==> before.batches == actual.state.batches
  requires !closing(before, actual.state) ==> forall n :: n in actual.out ==> keyReportVersion(n) == -1 && failedBefore(n) == -1 && settledId(n) == 0
  requires !closing(before, actual.state) && replyId(before.reply) == replyId(actual.state.reply) ==>
    forall n :: n in actual.out ==> !isReplySettled(n)
  requires !closing(before, actual.state) && replyId(before.reply) != replyId(actual.state.reply) ==>
    replyId(before.reply) != "" &&
    (actual.out == [ReplySettled(replyId(before.reply), true)] ||
     actual.out == [CancelUtterance(replyId(before.reply)), ReplySettled(replyId(before.reply), false)])
  ensures stepARefusedKeyIsReportedOnceAndEndsItsRequest(before, via, actual.state, actual.out)
  ensures stepAReplySettlesOnce(before, via, actual.state, actual.out)
  ensures stepAnEndReleasesRevokesAndReportsOnce(before, via, actual.state, actual.out)
  ensures stepABatchRequestSettlesOnce(before, via, actual.state, actual.out)
{
  if closing(before, actual.state) {
    CloseSpeechReceipts(before, endingOf(actual.state.phase), via);
  } else {
    var out := actual.out;
    ProofLib.FilterNone((n: SpeechNotice) => (keyReportVersion(n) != -1), out);
    ProofLib.FilterNone((n: SpeechNotice) => (failedBefore(n) != -1), out);
    if replyId(before.reply) == replyId(actual.state.reply) {
      ProofLib.FilterNone((n: SpeechNotice) => isReplySettled(n), out);
    } else {
      var settledAt := |out| - 1;
      ProofLib.FilterOne((n: SpeechNotice) => isReplySettled(n), out, settledAt);
    }
    UnchangedBatchSettlements(before, via, actual.state, out);
  }
}

lemma cancelReply_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysOpenWorkUsesTheCurrentKey(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysOnlyALiveSessionCaptures(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysAnEndingSaysWhetherAudioStarted(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysADeviceEndIsAFailure(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> alwaysBatchRequestsAreDistinct(cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "cancelReply", cancelReply(s).state, cancelReply(s).out))
  ensures (inv(s) ==> canCancelReply(s) ==> stepTheSessionOpensInOrder(s, cancelReply(s).state))
  ensures (inv(s) ==> canCancelReply(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "cancelReply", cancelReply(s).state, cancelReply(s).out))
  ensures (inv(s) ==> canCancelReply(s) ==> stepAReplySettlesOnce(s, "cancelReply", cancelReply(s).state, cancelReply(s).out))
  ensures (inv(s) ==> canCancelReply(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "cancelReply", cancelReply(s).state, cancelReply(s).out))
  ensures (inv(s) ==> canCancelReply(s) ==> stepABatchRequestSettlesOnce(s, "cancelReply", cancelReply(s).state, cancelReply(s).out))
{
  if inv(s) && canCancelReply(s) {
    RelayCallbackReceipts(s, "cancelReply", cancelReply(s));
  }
}

lemma outputNotice_ensures(s: CloudSpeech, notice: os__voice__speechOutput_OutputNotice)
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysOpenWorkUsesTheCurrentKey(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysOnlyALiveSessionCaptures(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysAnEndingSaysWhetherAudioStarted(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysADeviceEndIsAFailure(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> alwaysBatchRequestsAreDistinct(outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "outputNotice", outputNotice(s, notice).state, outputNotice(s, notice).out))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> stepTheSessionOpensInOrder(s, outputNotice(s, notice).state))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "outputNotice", outputNotice(s, notice).state, outputNotice(s, notice).out))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> stepAReplySettlesOnce(s, "outputNotice", outputNotice(s, notice).state, outputNotice(s, notice).out))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "outputNotice", outputNotice(s, notice).state, outputNotice(s, notice).out))
  ensures (inv(s) ==> canOutputNotice(s, notice) ==> stepABatchRequestSettlesOnce(s, "outputNotice", outputNotice(s, notice).state, outputNotice(s, notice).out))
{
  if inv(s) && canOutputNotice(s, notice) {
    RelayCallbackReceipts(s, "outputNotice", outputNotice(s, notice));
  }
}

lemma captureAnswered_ensures(s: CloudSpeech, slot: os__voice__microphone_Refusal)
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysOpenWorkUsesTheCurrentKey(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysOnlyALiveSessionCaptures(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysAnEndingSaysWhetherAudioStarted(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysADeviceEndIsAFailure(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> alwaysBatchRequestsAreDistinct(captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "captureAnswered", captureAnswered(s, slot).state, captureAnswered(s, slot).out))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> stepTheSessionOpensInOrder(s, captureAnswered(s, slot).state))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "captureAnswered", captureAnswered(s, slot).state, captureAnswered(s, slot).out))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> stepAReplySettlesOnce(s, "captureAnswered", captureAnswered(s, slot).state, captureAnswered(s, slot).out))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "captureAnswered", captureAnswered(s, slot).state, captureAnswered(s, slot).out))
  ensures (inv(s) ==> canCaptureAnswered(s) ==> stepABatchRequestSettlesOnce(s, "captureAnswered", captureAnswered(s, slot).state, captureAnswered(s, slot).out))
{
  if inv(s) && canCaptureAnswered(s) {
    var actual := captureAnswered(s, slot);
    if slot.NoRefusal? {
      RelayCallbackReceipts(s, "captureAnswered", actual);
    } else {
      var unreserved := s.(capture := Capture.Muted);
      RelayCallbackReceipts(unreserved, "captureAnswered", actual);
      assert s.capture.Reserving? && !unreserved.capture.Listening?;
      assert stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "captureAnswered", actual.state, actual.out);
      assert stepAReplySettlesOnce(s, "captureAnswered", actual.state, actual.out);
      assert stepAnEndReleasesRevokesAndReportsOnce(s, "captureAnswered", actual.state, actual.out);
      assert stepABatchRequestSettlesOnce(s, "captureAnswered", actual.state, actual.out);
    }
  }
}

lemma minted_ensures(s: CloudSpeech, answer: CloudAnswer)
  ensures (inv(s) ==> canMinted(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> alwaysOpenWorkUsesTheCurrentKey(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> alwaysOnlyALiveSessionCaptures(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> alwaysAnEndingSaysWhetherAudioStarted(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> alwaysADeviceEndIsAFailure(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> alwaysBatchRequestsAreDistinct(minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "minted", minted(s, answer).state, minted(s, answer).out))
  ensures (inv(s) ==> canMinted(s) ==> stepTheSessionOpensInOrder(s, minted(s, answer).state))
  ensures (inv(s) ==> canMinted(s) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "minted", minted(s, answer).state, minted(s, answer).out))
  ensures (inv(s) ==> canMinted(s) ==> stepAReplySettlesOnce(s, "minted", minted(s, answer).state, minted(s, answer).out))
  ensures (inv(s) ==> canMinted(s) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "minted", minted(s, answer).state, minted(s, answer).out))
  ensures (inv(s) ==> canMinted(s) ==> stepABatchRequestSettlesOnce(s, "minted", minted(s, answer).state, minted(s, answer).out))
{
  if inv(s) && canMinted(s) {
    var actual := minted(s, answer);
    if answer.Answered? {
      RelayCallbackReceipts(s, "minted", actual);
    } else {
      var prefix := keyReport(answer, s.credential);
      var failure := SessionFailed(failureOf(answer), true, waitOf(answer));
      var revoked := prefix + [SpeechNotice.RevokeSession];
      assert s.capture.Muted? && s.reply.NoReply? && !s.audioStarted;
      assert !failureOf(answer).NoFailure?;
      assert actual.out == revoked + [failure];
      KeyReportReceiptShape(answer, s.credential);
      var reportsKey := (n: SpeechNotice) => (keyReportVersion(n) != -1);
      ProofLib.FilterAppend(reportsKey, prefix, SpeechNotice.RevokeSession);
      ProofLib.FilterAppend(reportsKey, revoked, failure);
      assert stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "minted", actual.state, actual.out);
      forall n | n in actual.out
        ensures !isReplySettled(n) && settledId(n) == 0
      {
        assert n in prefix || n == SpeechNotice.RevokeSession || n == failure;
      }
      ProofLib.FilterNone((n: SpeechNotice) => isReplySettled(n), actual.out);
      var failedAt := |actual.out| - 1;
      assert actual.out[failedAt] == failure;
      ProofLib.FilterOne((n: SpeechNotice) => (failedBefore(n) != -1), actual.out, failedAt);
      assert stepAnEndReleasesRevokesAndReportsOnce(s, "minted", actual.state, actual.out);
      UnchangedBatchSettlements(s, "minted", actual.state, actual.out);
    }
  }
}

lemma KeyReportReceiptShape(answer: CloudAnswer, version: int)
  ensures forall n :: n in keyReport(answer, version) ==> n.ReportRefusedKey? && keyReportVersion(n) == version
  ensures |ProofLib.Filter((n: SpeechNotice) => (keyReportVersion(n) != -1), keyReport(answer, version))| <= 1
{
  var prefix := keyReport(answer, version);
  var reportsKey := (n: SpeechNotice) => (keyReportVersion(n) != -1);
  ProofLib.FilterNil(reportsKey, []);
  if |prefix| > 0 {
    assert prefix == [prefix[0]];
    ProofLib.FilterAppend(reportsKey, [], prefix[0]);
  }
}

lemma credentialChanged_ensures(s: CloudSpeech, version: int)
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysOpenWorkUsesTheCurrentKey(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysOnlyALiveSessionCaptures(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysAnEndingSaysWhetherAudioStarted(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysADeviceEndIsAFailure(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> alwaysBatchRequestsAreDistinct(credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "credentialChanged", credentialChanged(s, version).state, credentialChanged(s, version).out))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> stepTheSessionOpensInOrder(s, credentialChanged(s, version).state))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "credentialChanged", credentialChanged(s, version).state, credentialChanged(s, version).out))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> stepAReplySettlesOnce(s, "credentialChanged", credentialChanged(s, version).state, credentialChanged(s, version).out))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "credentialChanged", credentialChanged(s, version).state, credentialChanged(s, version).out))
  ensures (inv(s) ==> canCredentialChanged(s, version) ==> stepABatchRequestSettlesOnce(s, "credentialChanged", credentialChanged(s, version).state, credentialChanged(s, version).out))
{
  hide *;
  reveal inv, canCredentialChanged, keyGone, isOpen, ProofLib.Filter;
  if inv(s) && canCredentialChanged(s, version) {
    var actual := credentialChanged(s, version);
    var prior := s.batches;
    var changed := seq(|prior|, i requires 0 <= i < |prior| => keyGone(prior[i]));
    var waiting := ProofLib.Filter((b: BatchRequest) => b.verdict.BatchPending?, prior);
    var receipts := seq(|waiting|, i requires 0 <= i < |waiting| => BatchSettled(waiting[i].requestId, keyGone(waiting[i]).verdict));
    var ending := if s.audioStarted then FailedAfterAudio(core__capabilityRouting_Failure.AccountIneligible) else FailedBeforeAudio(core__capabilityRouting_Failure.AccountIneligible);
    var closed := closeWith(ending, s, [], cloud__shared__types_WaitTime.NoWait);
    var suffix := if isOpen(s.phase) then closed.out else [];
    assert actual.state == (if isOpen(s.phase) then closed.state else s).(credential := version, batches := changed)
      && actual.out == receipts + suffix by {
      reveal credentialChanged, failWith, closeWith;
    }
    assert forall i :: 0 <= i < |prior| ==> changed[i].requestId == prior[i].requestId;
    MappedBatchIdsStayDistinct(s, actual.state);
    forall n | n in receipts
      ensures n.BatchSettled?
    {
      var i :| 0 <= i < |receipts| && receipts[i] == n;
    }
    if isOpen(s.phase) {
      assert actual.state.phase == closed.state.phase && actual.state.reply == closed.state.reply;
      CloseSpeechReceipts(s, ending, "credentialChanged");
      BatchPrefixKeepsSpeechReceipts(s, "credentialChanged", closed, actual, receipts);
    } else {
      assert actual.out == receipts;
      assert stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "credentialChanged", actual.state, actual.out) by {
        reveal keyReportVersion, stepARefusedKeyIsReportedOnceAndEndsItsRequest;
        ProofLib.FilterNone((n: SpeechNotice) => (keyReportVersion(n) != -1), actual.out);
      }
      assert forall n :: n in actual.out ==> !isReplySettled(n) && failedBefore(n) == -1 by {
        reveal isReplySettled, failedBefore;
      }
      assert !closing(s, actual.state) by { reveal closing; }
      NoReplyOrSessionEndReceipt(s, "credentialChanged", actual.state, actual.out);
    }
    assert forall i :: 0 <= i < |receipts| ==> settledId(receipts[i]) == waiting[i].requestId by { reveal settledId; }
    assert forall n :: n in suffix ==> settledId(n) == 0 && heardCapture(n) == -1;
    KeyChangeSettlesWaitingBatches(s, actual.state, waiting, receipts, suffix);
    assert inv(actual.state) by {
      reveal closeWith, asksOf, waitedOf, endingOf, hasEnded, failedAfterAudio, failedBeforeAudio, failureOfEnding, turnOwner;
      reveal alwaysConsentIsAskedAtMostTwiceWithinItsDeadline, alwaysOpenWorkUsesTheCurrentKey;
      reveal alwaysOnlyALiveSessionCaptures, alwaysAReplyNeverPlaysAheadOfItsAudio, alwaysAnEndingSaysWhetherAudioStarted;
      reveal alwaysADeviceEndIsAFailure;
    }
    assert stepTheSessionOpensInOrder(s, actual.state) by {
      reveal closeWith, stepTheSessionOpensInOrder, openingRank;
    }
    assert stepOnlyTheCaptureATurnBeganInPublishesIt(s, "credentialChanged", actual.state, actual.out) by {
      reveal stepOnlyTheCaptureATurnBeganInPublishesIt, heardCapture;
    }
  }
}

lemma BatchPrefixKeepsSpeechReceipts(before: CloudSpeech, via: string, closed: SpeechStep, actual: SpeechStep, prefix: seq<SpeechNotice>)
  requires stepARefusedKeyIsReportedOnceAndEndsItsRequest(before, via, closed.state, closed.out)
  requires stepAReplySettlesOnce(before, via, closed.state, closed.out)
  requires stepAnEndReleasesRevokesAndReportsOnce(before, via, closed.state, closed.out)
  requires actual.state.phase == closed.state.phase && actual.state.reply == closed.state.reply
  requires actual.out == prefix + closed.out
  requires forall n :: n in prefix ==> n.BatchSettled?
  ensures stepARefusedKeyIsReportedOnceAndEndsItsRequest(before, via, actual.state, actual.out)
  ensures stepAReplySettlesOnce(before, via, actual.state, actual.out)
  ensures stepAnEndReleasesRevokesAndReportsOnce(before, via, actual.state, actual.out)
{
  var out := actual.out;
  var reportsKey := (n: SpeechNotice) => (keyReportVersion(n) != -1);
  var settlesReply := (n: SpeechNotice) => isReplySettled(n);
  var reportsFailure := (n: SpeechNotice) => (failedBefore(n) != -1);
  assert closing(before, closed.state) == closing(before, actual.state);
  assert endingOf(closed.state.phase) == endingOf(actual.state.phase);
  assert replyId(closed.state.reply) == replyId(actual.state.reply);
  forall i | 0 <= i < |prefix|
    ensures !reportsKey(prefix[i]) && !settlesReply(prefix[i]) && !reportsFailure(prefix[i])
  {
    assert prefix[i] in prefix;
    assert prefix[i].BatchSettled?;
  }
  ProofLib.FilterNone(reportsKey, prefix);
  ProofLib.FilterNone(settlesReply, prefix);
  ProofLib.FilterNone(reportsFailure, prefix);
  assert |ProofLib.Filter(reportsKey, prefix)| == 0;
  assert |ProofLib.Filter(settlesReply, prefix)| == 0;
  assert |ProofLib.Filter(reportsFailure, prefix)| == 0;
  assert out == prefix + closed.out;
  FilterSpeechNoticeConcat(reportsKey, prefix, closed.out);
  FilterSpeechNoticeConcat(settlesReply, prefix, closed.out);
  FilterSpeechNoticeConcat(reportsFailure, prefix, closed.out);
  assert |ProofLib.Filter(reportsKey, out)| == |ProofLib.Filter(reportsKey, closed.out)|;
  assert |ProofLib.Filter(settlesReply, out)| == |ProofLib.Filter(settlesReply, closed.out)|;
  assert |ProofLib.Filter(reportsFailure, out)| == |ProofLib.Filter(reportsFailure, closed.out)|;
  forall n | n in out
    ensures keyReportVersion(n) == -1 || (keyReportVersion(n) == before.credential && (closing(before, actual.state) || via == "batchAnswered"))
    ensures failedBefore(n) == -1 || (failedBefore(n) == 1) == !before.audioStarted
  {
    if n in prefix {
      assert n.BatchSettled?;
    } else {
      assert n in closed.out;
    }
  }
  assert SpeechNotice.ReleaseLiveCapture in closed.out ==> SpeechNotice.ReleaseLiveCapture in out;
  assert SpeechNotice.RevokeSession in closed.out ==> SpeechNotice.RevokeSession in out;
  assert stepARefusedKeyIsReportedOnceAndEndsItsRequest(before, via, actual.state, out);
  assert stepAReplySettlesOnce(before, via, actual.state, out);
  assert stepAnEndReleasesRevokesAndReportsOnce(before, via, actual.state, out);
}

lemma FilterSpeechNoticeConcat(p: SpeechNotice -> bool, prefix: seq<SpeechNotice>, suffix: seq<SpeechNotice>)
  ensures |ProofLib.Filter(p, prefix + suffix)| == |ProofLib.Filter(p, prefix)| + |ProofLib.Filter(p, suffix)|
  decreases |suffix|
{
  if |suffix| == 0 {
    assert prefix + suffix == prefix;
    ProofLib.FilterNil(p, suffix);
  } else {
    var leading := suffix[..|suffix| - 1];
    var last := suffix[|suffix| - 1];
    assert suffix == leading + [last];
    assert prefix + suffix == (prefix + leading) + [last];
    FilterSpeechNoticeConcat(p, prefix, leading);
    ProofLib.FilterAppend(p, prefix + leading, last);
    ProofLib.FilterAppend(p, leading, last);
    if p(last) {
      assert |ProofLib.Filter(p, prefix + leading) + [last]| == |ProofLib.Filter(p, prefix + leading)| + 1;
      assert |ProofLib.Filter(p, leading) + [last]| == |ProofLib.Filter(p, leading)| + 1;
    }
  }
}

lemma KeyChangeSettlesWaitingBatches(before: CloudSpeech, after: CloudSpeech, waiting: seq<BatchRequest>, receipts: seq<SpeechNotice>, suffix: seq<SpeechNotice>)
  requires alwaysBatchRequestsAreDistinct(before)
  requires |before.batches| == |after.batches|
  requires forall i :: 0 <= i < |before.batches| ==> after.batches[i] == keyGone(before.batches[i])
  requires waiting == ProofLib.Filter((b: BatchRequest) => b.verdict.BatchPending?, before.batches)
  requires |receipts| == |waiting|
  requires forall i :: 0 <= i < |receipts| ==> settledId(receipts[i]) == waiting[i].requestId
  requires forall n :: n in suffix ==> settledId(n) == 0
  ensures forall a :: a in after.batches ==> !a.verdict.BatchPending?
  ensures stepABatchRequestSettlesOnce(before, "credentialChanged", after, receipts + suffix)
{
  assert forall a :: a in after.batches ==> !a.verdict.BatchPending? by {
    forall a | a in after.batches
      ensures !a.verdict.BatchPending?
    {
      var i :| 0 <= i < |after.batches| && after.batches[i] == a;
      assert a == keyGone(before.batches[i]);
    }
  }
  forall b | b in before.batches
    ensures exists a :: a in after.batches && a.requestId == b.requestId && (!b.verdict.BatchPending? ==> a.verdict == b.verdict)
    ensures |ProofLib.Filter((n: SpeechNotice) => (settledId(n) == b.requestId), receipts + suffix)| == (if b.verdict.BatchPending? && !pending(after, b.requestId) then 1 else 0)
  {
    var index :| 0 <= index < |before.batches| && before.batches[index] == b;
    var updated := after.batches[index];
    assert updated in after.batches && updated.requestId == b.requestId;
    assert !b.verdict.BatchPending? ==> updated == b;
    assert !pending(after, b.requestId);
    var matches := (x: BatchRequest) => (x.requestId == b.requestId);
    var awaiting := (x: BatchRequest) => x.verdict.BatchPending?;
    var settles := (n: SpeechNotice) => (settledId(n) == b.requestId);
    assert |ProofLib.Filter(matches, before.batches)| == 1 && b.requestId >= 1;
    if b.verdict.BatchPending? {
      ProofLib.FilterOfFilterShorter(awaiting, matches, before.batches);
      ProofLib.FilterMember(awaiting, before.batches, b);
      ProofLib.FilterMember(matches, waiting, b);
      assert b in ProofLib.Filter(matches, waiting);
    } else {
      assert exists j :: 0 <= j < |before.batches| && matches(before.batches[j]) && !(awaiting(before.batches[j]) && matches(before.batches[j]));
      ProofLib.FilterOfFilterLength(awaiting, matches, matches, before.batches);
    }
    assert |ProofLib.Filter(matches, waiting)| == (if b.verdict.BatchPending? then 1 else 0);
    ProofLib.FilterLengthPointwise(matches, settles, waiting, receipts);
    ProofLib.FilterNone(settles, suffix);
    FilterSpeechNoticeConcat(settles, receipts, suffix);
  }
}

// A device end fails the open session as any failure closes it, and records its cause.
lemma deviceEnded_ensures(s: CloudSpeech, cause: DeviceCause)
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysOpenWorkUsesTheCurrentKey(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysOnlyALiveSessionCaptures(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysAnEndingSaysWhetherAudioStarted(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysADeviceEndIsAFailure(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> alwaysBatchRequestsAreDistinct(deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> stepARefusedKeyIsReportedOnceAndEndsItsRequest(s, "deviceEnded", deviceEnded(s, cause).state, deviceEnded(s, cause).out))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> stepTheSessionOpensInOrder(s, deviceEnded(s, cause).state))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> stepOnlyTheCaptureATurnBeganInPublishesIt(s, "deviceEnded", deviceEnded(s, cause).state, deviceEnded(s, cause).out))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> stepAReplySettlesOnce(s, "deviceEnded", deviceEnded(s, cause).state, deviceEnded(s, cause).out))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> stepAnEndReleasesRevokesAndReportsOnce(s, "deviceEnded", deviceEnded(s, cause).state, deviceEnded(s, cause).out))
  ensures (inv(s) ==> canDeviceEnded(s, cause) ==> stepABatchRequestSettlesOnce(s, "deviceEnded", deviceEnded(s, cause).state, deviceEnded(s, cause).out))
{
  if inv(s) && canDeviceEnded(s, cause) {
    var failure := deviceFailure(cause);
    var ending := if s.audioStarted then FailedAfterAudio(failure) else FailedBeforeAudio(failure);
    var closed := closeWith(ending, s, [], cloud__shared__types_WaitTime.NoWait);
    assert isOpen(s.phase);
    assert deviceEnded(s, cause) == SpeechStep(closed.state.(endedBy := cause), closed.out);
    CloseSpeechReceipts(s, ending, "deviceEnded");
    DeviceEndKeepsBatchSettlements(s, closed, deviceEnded(s, cause).state, "deviceEnded");
  }
}

// Recording a device cause on a closed session keeps what the close settled of its batch requests.
lemma DeviceEndKeepsBatchSettlements(before: CloudSpeech, closed: SpeechStep, after: CloudSpeech, via: string)
  requires after == closed.state.(endedBy := after.endedBy)
  requires stepABatchRequestSettlesOnce(before, via, closed.state, closed.out)
  ensures stepABatchRequestSettlesOnce(before, via, after, closed.out)
{
  hide *;
  reveal stepABatchRequestSettlesOnce, pending;
  assert after.batches == closed.state.batches;
}
