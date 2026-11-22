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
  ProofLib.FilterNone((n: SpeechNotice) => isReplySettled(n), out);
  ProofLib.FilterNone((n: SpeechNotice) => (failedBefore(n) != -1), out);
  assert stepAReplySettlesOnce(before, via, after, out);
  assert stepAnEndReleasesRevokesAndReportsOnce(before, via, after, out);
  UnchangedBatchSettlements(before, via, after, out);
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
