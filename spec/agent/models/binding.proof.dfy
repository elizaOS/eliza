lemma startCall_ensures(s: ModelBinding, handler: ModelHandler, now: int)
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysUnboundHoldsNothing(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysCredentialFollowsBackend(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysCallsUseAHeldCredential(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysNoBackendNeverCalls(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysFailingAccountHasALastFailure(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysLastFailureIsNotInTheFuture(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysActiveLimitNamesASettledCall(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> alwaysCredentialRefusalNamesTheHeldKey(startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> stepBindingFixedOnceBound(s, startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> stepClockNeverGoesBack(s, startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> stepNoCallBeforeRetryAt(s, "startCall", startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> stepChangedLimitNamesTheNewlyRefusedCall(s, "startCall", startCall(s, handler, now)))
  ensures (inv(s) ==> canStartCall(s, handler, now) ==> stepPushKeepsCallsAndOtherStates(s, "startCall", startCall(s, handler, now)))
{
  if inv(s) && canStartCall(s, handler, now) {
    var after := startCall(s, handler, now);
    assert agent__host__launch_needsCredential(s.backend);
    assert s.credentialVersion >= 1;
    forall call | call in after.calls
      ensures 0 <= call.id < after.nextCall && 1 <= call.credentialVersion <= after.credentialVersion
    {
      if call in s.calls {
        assert 0 <= call.id < s.nextCall && 1 <= call.credentialVersion <= s.credentialVersion;
      } else {
        assert call == Call(s.nextCall, s.credentialVersion);
      }
    }
  }
}

lemma refuseCall_ensures(s: ModelBinding, id: int, now: int, e: cloud__client_CloudError)
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysUnboundHoldsNothing(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysCredentialFollowsBackend(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysCallsUseAHeldCredential(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysNoBackendNeverCalls(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysFailingAccountHasALastFailure(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysLastFailureIsNotInTheFuture(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysActiveLimitNamesASettledCall(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> alwaysCredentialRefusalNamesTheHeldKey(refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> stepBindingFixedOnceBound(s, refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> stepClockNeverGoesBack(s, refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> stepNoCallBeforeRetryAt(s, "refuseCall", refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> stepChangedLimitNamesTheNewlyRefusedCall(s, "refuseCall", refuseCall(s, id, now, e)))
  ensures (inv(s) ==> canRefuseCall(s, id) ==> stepPushKeepsCallsAndOtherStates(s, "refuseCall", refuseCall(s, id, now, e)))
{
  if inv(s) && canRefuseCall(s, id) {
    var after := refuseCall(s, id, now, e);
    RefusedCallsAreFiltered(s, id, now, e);
    FilteredCallsUseHeldCredential(s, after, id);
    if limitedAt(after.accountState, after.clock) || after.rateLimitCallId != s.rateLimitCallId {
      if after.rateLimitCallId == id {
        assert 0 <= id < s.nextCall;
      } else {
        assert after.rateLimitCallId == s.rateLimitCallId;
        assert after.accountState == s.accountState;
        assert limitedAt(s.accountState, s.clock);
      }
      FilteredCallsExclude(s, after, id, after.rateLimitCallId);
    }
  }
}

lemma answerCall_ensures(s: ModelBinding, id: int, now: int)
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysUnboundHoldsNothing(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysCredentialFollowsBackend(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysCallsUseAHeldCredential(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysNoBackendNeverCalls(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysFailingAccountHasALastFailure(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysLastFailureIsNotInTheFuture(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysActiveLimitNamesASettledCall(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> alwaysCredentialRefusalNamesTheHeldKey(answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> stepBindingFixedOnceBound(s, answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> stepClockNeverGoesBack(s, answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> stepNoCallBeforeRetryAt(s, "answerCall", answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> stepChangedLimitNamesTheNewlyRefusedCall(s, "answerCall", answerCall(s, id, now)))
  ensures (inv(s) ==> canAnswerCall(s, id) ==> stepPushKeepsCallsAndOtherStates(s, "answerCall", answerCall(s, id, now)))
{
  if inv(s) && canAnswerCall(s, id) {
    var after := answerCall(s, id, now);
    AnsweredCallsAreFiltered(s, id, now);
    FilteredCallsUseHeldCredential(s, after, id);
    if limitedAt(after.accountState, after.clock) {
      assert after.accountState == s.accountState;
      assert limitedAt(s.accountState, s.clock);
      FilteredCallsExclude(s, after, id, after.rateLimitCallId);
    }
  }
}

lemma RefusedCallsAreFiltered(s: ModelBinding, id: int, now: int, e: cloud__client_CloudError)
  ensures refuseCall(s, id, now, e).calls == ProofLib.Filter((c: Call) => (c.id != id), s.calls)
{
}

lemma AnsweredCallsAreFiltered(s: ModelBinding, id: int, now: int)
  ensures answerCall(s, id, now).calls == ProofLib.Filter((c: Call) => (c.id != id), s.calls)
{
}

lemma FilteredCallsUseHeldCredential(before: ModelBinding, after: ModelBinding, id: int)
  requires alwaysCallsUseAHeldCredential(before)
  requires after.calls == ProofLib.Filter((c: Call) => (c.id != id), before.calls)
  requires after.nextCall == before.nextCall && after.credentialVersion == before.credentialVersion
  ensures alwaysCallsUseAHeldCredential(after)
{
  forall call | call in after.calls
    ensures 0 <= call.id < after.nextCall && 1 <= call.credentialVersion <= after.credentialVersion
  {
    ProofLib.FilterMember((c: Call) => (c.id != id), before.calls, call);
    assert 0 <= call.id < before.nextCall && 1 <= call.credentialVersion <= before.credentialVersion;
  }
}

lemma FilteredCallsExclude(before: ModelBinding, after: ModelBinding, id: int, excluded: int)
  requires after.calls == ProofLib.Filter((c: Call) => (c.id != id), before.calls)
  requires excluded == id || !(exists call: Call :: call in before.calls && call.id == excluded)
  ensures !(exists call: Call :: call in after.calls && call.id == excluded)
{
  forall call | call in after.calls
    ensures call.id != excluded
  {
    ProofLib.FilterMember((c: Call) => (c.id != id), before.calls, call);
  }
}
