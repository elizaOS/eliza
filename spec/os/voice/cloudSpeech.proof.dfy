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
  forall b | b in before.batches
    ensures |ProofLib.Filter((n: SpeechNotice) => (settledId(n) == b.requestId), out)| == 0
  {
    assert b.requestId >= 1;
    ProofLib.FilterNone((n: SpeechNotice) => (settledId(n) == b.requestId), out);
  }
  assert stepABatchRequestSettlesOnce(before, via, after, out);
}
