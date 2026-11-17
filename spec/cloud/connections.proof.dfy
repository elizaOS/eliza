lemma AttemptOfBridge(a: Authorization, caller: int)
  ensures attemptOf(a, caller) == (if 0 < |ProofLib.Filter((t: IntentAttempt) => (t.caller == caller), a.attempts)| then ProofLib.Filter((t: IntentAttempt) => (t.caller == caller), a.attempts)[0] else newAttempt(0))
{}

lemma AttemptOfDecision(a: Authorization, caller: int)
  requires alwaysPreparedDecisionsAreDecisions(a)
  ensures var t := attemptOf(a, caller); (t.target.IntentDelivered? || terminalStatus(t.target)) && (t.signed ==> t.target.IntentApproved?)
{
  AttemptOfBridge(a, caller);
  ProofLib.FilterSubset((t: IntentAttempt) => (t.caller == caller), a.attempts);
}

lemma WithAttemptDecisions(a: Authorization, attempt: IntentAttempt)
  requires alwaysPreparedDecisionsAreDecisions(a)
  requires (attempt.target.IntentDelivered? || terminalStatus(attempt.target)) && (attempt.signed ==> attempt.target.IntentApproved?)
  ensures alwaysPreparedDecisionsAreDecisions(a.(attempts := withAttempt(a, attempt)))
{
  var xs := withAttempt(a, attempt);
  forall t | t in xs
    ensures (t.target.IntentDelivered? || terminalStatus(t.target)) && (t.signed ==> t.target.IntentApproved?)
  {
    var i :| 0 <= i < |xs| && xs[i] == t;
    assert a.attempts[i] in a.attempts;
  }
}

lemma storageFailure_ensures(a: Authorization, caller: int)
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysOnlyApprovalsAreDelivered(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysEventsMatchTheIntent(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysDecisionIsStable(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysAcceptedWithinLifetime(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysCancelledByTheOwningTenant(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysSignatureOnlyOnApproval(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysPreparedDecisionsAreDecisions(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysClockCountsUpFromZero(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysPendingStateIsUnused(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> alwaysEachActivationConsumedAStateOrCode(storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> stepActivationOnlyByCallbackOrNativeCode(a, "storageFailure", storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> stepConsumedStatesStayConsumed(a, storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> stepNativeCodesStayConsumed(a, storageFailure(a, caller)))
  ensures (inv(a) ==> canStorageFailure(a, caller) ==> stepRefusedNativeLinkChangesNoConnection(a, "storageFailure", storageFailure(a, caller)))
{
  if inv(a) && canStorageFailure(a, caller) {
    AttemptOfDecision(a, caller);
    WithAttemptDecisions(a, attemptOf(a, caller).(phase := AttemptPhase.AttemptDone));
  }
}

lemma commitDecision_ensures(a: Authorization, caller: int)
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysOnlyApprovalsAreDelivered(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysEventsMatchTheIntent(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysDecisionIsStable(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysAcceptedWithinLifetime(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysCancelledByTheOwningTenant(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysSignatureOnlyOnApproval(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysPreparedDecisionsAreDecisions(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysClockCountsUpFromZero(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysPendingStateIsUnused(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> alwaysEachActivationConsumedAStateOrCode(commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> stepActivationOnlyByCallbackOrNativeCode(a, "commitDecision", commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> stepConsumedStatesStayConsumed(a, commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> stepNativeCodesStayConsumed(a, commitDecision(a, caller)))
  ensures (inv(a) ==> canCommitDecision(a, caller) ==> stepRefusedNativeLinkChangesNoConnection(a, "commitDecision", commitDecision(a, caller)))
{
  if inv(a) && canCommitDecision(a, caller) {
    AttemptOfDecision(a, caller);
    WithAttemptDecisions(a, attemptOf(a, caller).(phase := AttemptPhase.AttemptDone));
  }
}

lemma completeCallback_ensures(a: Authorization, stateNonce: int, org: int)
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysOnlyApprovalsAreDelivered(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysEventsMatchTheIntent(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysDecisionIsStable(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysAcceptedWithinLifetime(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysCancelledByTheOwningTenant(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysSignatureOnlyOnApproval(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysPreparedDecisionsAreDecisions(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysClockCountsUpFromZero(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysPendingStateIsUnused(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> alwaysEachActivationConsumedAStateOrCode(completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> stepActivationOnlyByCallbackOrNativeCode(a, "completeCallback", completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> stepConsumedStatesStayConsumed(a, completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> stepNativeCodesStayConsumed(a, completeCallback(a, stateNonce, org)))
  ensures (inv(a) ==> canCompleteCallback(a, stateNonce, org) ==> stepRefusedNativeLinkChangesNoConnection(a, "completeCallback", completeCallback(a, stateNonce, org)))
{
  if inv(a) && canCompleteCallback(a, stateNonce, org) {
    assert completeCallback(a, stateNonce, org).consumedStates == a.consumedStates + ProofLib.Filter((set_x: int) => !((set_x in a.consumedStates)), [stateNonce]);
    ProofLib.FilterCons((set_x: int) => !((set_x in a.consumedStates)), [stateNonce]);
    ProofLib.FilterNil((set_x: int) => !((set_x in a.consumedStates)), [stateNonce][1..]);
  }
}

lemma linkNativeCode_ensures(a: Authorization, code: int, org: int, facts: NativeLinkFacts)
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysOnlyApprovalsAreDelivered(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysEventsMatchTheIntent(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysDecisionIsStable(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysAcceptedWithinLifetime(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysCancelledByTheOwningTenant(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysSignatureOnlyOnApproval(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysPreparedDecisionsAreDecisions(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysClockCountsUpFromZero(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysPendingStateIsUnused(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> alwaysEachActivationConsumedAStateOrCode(linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> stepActivationOnlyByCallbackOrNativeCode(a, "linkNativeCode", linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> stepConsumedStatesStayConsumed(a, linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> stepNativeCodesStayConsumed(a, linkNativeCode(a, code, org, facts)))
  ensures (inv(a) ==> canLinkNativeCode(a, code, org, facts) ==> stepRefusedNativeLinkChangesNoConnection(a, "linkNativeCode", linkNativeCode(a, code, org, facts)))
{
  if inv(a) && canLinkNativeCode(a, code, org, facts) && nativeLinkOutcome(a, code, facts).NativeLinked? {
    assert !(code in a.consumedCodes);
    assert linkNativeCode(a, code, org, facts).consumedCodes == a.consumedCodes + ProofLib.Filter((set_x: int) => !((set_x in a.consumedCodes)), [code]);
    ProofLib.FilterCons((set_x: int) => !((set_x in a.consumedCodes)), [code]);
    ProofLib.FilterNil((set_x: int) => !((set_x in a.consumedCodes)), [code][1..]);
  }
}
