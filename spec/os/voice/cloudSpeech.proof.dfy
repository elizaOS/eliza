lemma begin_ensures(s: CloudSpeech)
  ensures (inv(s) ==> canBegin(s) ==> alwaysConsentIsAskedAtMostTwiceWithinItsDeadline(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysOpenWorkUsesTheCurrentKey(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysOnlyALiveSessionCaptures(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysAReplyNeverPlaysAheadOfItsAudio(begin(s).state))
  ensures (inv(s) ==> canBegin(s) ==> alwaysAnEndingSaysWhetherAudioStarted(begin(s).state))
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
  reveal alwaysAnEndingSaysWhetherAudioStarted, alwaysBatchRequestsAreDistinct;
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
    assert actual.out == [SpeechNotice.ReleaseLiveCapture];
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
{
  var closed := closeWith(ending, before, [], cloud__shared__types_WaitTime.NoWait);
  var released := noticeIf(!before.capture.Muted?, SpeechNotice.ReleaseLiveCapture);
  var settled := noticeIf(replyId(before.reply) != "", ReplySettled(replyId(before.reply), false));
  var revoked := noticeIf(revokeOwed(before.phase), SpeechNotice.RevokeSession);
  var failed := noticeIf(!failureOfEnding(ending).NoFailure?, SessionFailed(failureOfEnding(ending), !before.audioStarted, cloud__shared__types_WaitTime.NoWait));
  assert closed.out == released + settled + revoked + failed;
  forall n | n in closed.out
    ensures keyReportVersion(n) == -1 && settledId(n) == 0
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
    forall n | n in keyNotices
      ensures n.ReportRefusedKey? && keyReportVersion(n) == s.credential && settledId(n) == 0
    {
    }
    assert forall n :: n in answered.out ==> !isReplySettled(n) && failedBefore(n) == -1;
    NoReplyOrSessionEndReceipt(s, "batchAnswered", answered.state, answered.out);
    SettlePendingBatch(s, requestId, verdict, "batchAnswered", keyNotices);

    var reportsKey := (n: SpeechNotice) => (keyReportVersion(n) != -1);
    ProofLib.FilterNil(reportsKey, []);
    if |keyNotices| > 0 {
      assert keyNotices == [keyNotices[0]];
      ProofLib.FilterAppend(reportsKey, [], keyNotices[0]);
    }
    assert |ProofLib.Filter(reportsKey, keyNotices)| <= 1;
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
