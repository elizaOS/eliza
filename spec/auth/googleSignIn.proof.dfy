lemma IdsBridge(s: GoogleSignIn)
  ensures alwaysRedemptionIdsUnique(s) <==> s.nextRedemption >= 1 && s.spentBy < s.nextRedemption && ProofLib.DistinctBy(s.redemptions, (o: Redemption) => o.id)
  ensures alwaysAtMostOneGrant(s) <==> |ProofLib.Filter((r: Redemption) => granted(r), s.redemptions)| <= 1
{
  var rs := s.redemptions;
  assert alwaysRedemptionIdsUnique(s) <==> s.nextRedemption >= 1 && s.spentBy < s.nextRedemption && forall r :: r in rs ==> |ProofLib.Filter((o: Redemption) => (o.id == r.id), rs)| == 1;
  forall i | 0 <= i < |rs|
    ensures |ProofLib.Filter((o: Redemption) => (o.id == rs[i].id), rs)| == 1 <==> forall j :: 0 <= j < |rs| && j != i ==> rs[j].id != rs[i].id
  {
    ProofLib.FilterCountOneIffUnique((o: Redemption) => (o.id == rs[i].id), rs, (o: Redemption) => o.id, i);
  }
  if ProofLib.DistinctBy(rs, (o: Redemption) => o.id) {
    forall r | r in rs ensures |ProofLib.Filter((o: Redemption) => (o.id == r.id), rs)| == 1 {
      var i :| 0 <= i < |rs| && rs[i] == r;
    }
  }
}

lemma FilterUpdateLength<T>(p: T -> bool, xs: seq<T>, i: int, v: T)
  requires 0 <= i < |xs|
  ensures |ProofLib.Filter(p, xs[i := v])| + (if p(xs[i]) then 1 else 0) == |ProofLib.Filter(p, xs)| + (if p(v) then 1 else 0)
  decreases |xs|
{
  ProofLib.FilterCons(p, xs);
  ProofLib.FilterCons(p, xs[i := v]);
  if i > 0 {
    assert xs[i := v][1..] == xs[1..][i - 1 := v];
    FilterUpdateLength(p, xs[1..], i - 1, v);
  } else {
    assert xs[i := v][1..] == xs[1..];
  }
}

lemma RedemptionIn(s: GoogleSignIn, id: int)
  ensures redemption(s, id) == noRedemption || (redemption(s, id) in s.redemptions && redemption(s, id).id == id)
{
  var found := ProofLib.Filter((r: Redemption) => (r.id == id), s.redemptions);
  ProofLib.FilterSubset((r: Redemption) => (r.id == id), s.redemptions);
  assert redemption(s, id) == (if 0 < |found| then found[0] else noRedemption);
  if 0 < |found| {
    ProofLib.FilterMember((r: Redemption) => (r.id == id), s.redemptions, found[0]);
  }
}

lemma WithPhaseAt(s: GoogleSignIn, id: int, ph: RedemptionPhase, i: int)
  requires alwaysRedemptionIdsUnique(s) && 0 <= i < |s.redemptions| && s.redemptions[i].id == id
  ensures withPhase(s, id, ph) == s.redemptions[i := s.redemptions[i].(phase := ph)]
  ensures forall j :: 0 <= j < |s.redemptions| && j != i ==> s.redemptions[j].id != id
  ensures forall x :: x in withPhase(s, id, ph) ==> x == s.redemptions[i].(phase := ph) || x in s.redemptions
  ensures forall j :: 0 <= j < |s.redemptions| ==> withPhase(s, id, ph)[j].id == s.redemptions[j].id
  ensures |ProofLib.Filter((r: Redemption) => granted(r), withPhase(s, id, ph))| + (if granted(s.redemptions[i]) then 1 else 0) == |ProofLib.Filter((r: Redemption) => granted(r), s.redemptions)| + (if granted(s.redemptions[i].(phase := ph)) then 1 else 0)
{
  IdsBridge(s);
  var after := s.redemptions[i := s.redemptions[i].(phase := ph)];
  assert withPhase(s, id, ph) == after;
  forall x | x in after ensures x == s.redemptions[i].(phase := ph) || x in s.redemptions {
    var j :| 0 <= j < |after| && after[j] == x;
  }
  FilterUpdateLength((r: Redemption) => granted(r), s.redemptions, i, s.redemptions[i].(phase := ph));
}

lemma PhaseChange(s: GoogleSignIn, id: int, ph: RedemptionPhase, after: GoogleSignIn) returns (i: int)
  requires inv(s) && redemption(s, id) != noRedemption && after.redemptions == withPhase(s, id, ph)
  requires after.nextRedemption == s.nextRedemption && after.spentBy == s.spentBy
  ensures 0 <= i < |s.redemptions| && s.redemptions[i] == redemption(s, id) && s.redemptions[i].id == id
  ensures after.redemptions == s.redemptions[i := s.redemptions[i].(phase := ph)]
  ensures forall j :: 0 <= j < |s.redemptions| && j != i ==> s.redemptions[j].id != id
  ensures forall x :: x in after.redemptions ==> x == s.redemptions[i].(phase := ph) || x in s.redemptions
  ensures |ProofLib.Filter((r: Redemption) => granted(r), after.redemptions)| + (if granted(s.redemptions[i]) then 1 else 0) == |ProofLib.Filter((r: Redemption) => granted(r), s.redemptions)| + (if granted(s.redemptions[i].(phase := ph)) then 1 else 0)
  ensures alwaysRedemptionIdsUnique(after)
  ensures s.lockOwner == 0 || exists r :: r in after.redemptions && r.id == s.lockOwner
{
  RedemptionIn(s, id);
  i :| 0 <= i < |s.redemptions| && s.redemptions[i] == redemption(s, id);
  WithPhaseAt(s, id, ph, i);
  IdsBridge(s);
  IdsBridge(after);
  if s.lockOwner != 0 {
    var k :| 0 <= k < |s.redemptions| && s.redemptions[k].id == s.lockOwner;
    assert after.redemptions[k] in after.redemptions;
  }
}

lemma AppendRedemption(s: GoogleSignIn, v: Redemption, after: GoogleSignIn)
  requires inv(s) && v.id == s.nextRedemption && !granted(v)
  requires after.redemptions == s.redemptions + [v] && after.nextRedemption == s.nextRedemption + 1 && after.spentBy == s.spentBy
  ensures alwaysAtMostOneGrant(after) && alwaysRedemptionIdsUnique(after)
{
  IdsBridge(s);
  IdsBridge(after);
  ProofLib.FilterAppend((r: Redemption) => granted(r), s.redemptions, v);
  ProofLib.DistinctByConcat(s.redemptions, [v], (o: Redemption) => o.id);
}

lemma deviceReturns_ensures(s: GoogleSignIn, returnedAttempt: int, form: ReturnForm)
  ensures (inv(s) ==> alwaysIdTokenSignInHadListedAudience(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysClockNeverNegative(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysAwaitedAttemptIsNumbered(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysRefusedReturnKeepsAttempt(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysMatchedFailureSpendsWithoutExchange(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysOneExchangePerAttempt(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysOneLockOwnerWithMatchingBindings(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysAtMostOneGrant(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysRedemptionIdsUnique(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysValidatedRedemptionMatchesBindings(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysSpentCodeBelongsToAttempt(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysGrantFollowsLiveConsume(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysGrantUsesIssuedLane(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysWrongBindingSpendsNothing(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysAdmissionNeedsCurrentEpoch(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysCancellingHoldsNoVerifier(deviceReturns(s, returnedAttempt, form)))
  ensures (inv(s) ==> alwaysTicketNotAhead(deviceReturns(s, returnedAttempt, form)))
{
  if inv(s) && returnRefusal(s, returnedAttempt, form).NothingYet? && form.CodeReturned? {
    var after := deviceReturns(s, returnedAttempt, form);
    AppendRedemption(s, Redemption(s.nextRedemption, Binding.AllBindingsMatch, (if codeLive(s) then RedemptionPhase.Peeked else RedemptionPhase.RedemptionRefused), true), after);
    forall a | a in after.exchanges ensures |ProofLib.Filter((b: int) => (b == a), after.exchanges)| == 1 {
      ProofLib.FilterAppend((b: int) => (b == a), s.exchanges, s.attempt);
      if a == s.attempt {
        ProofLib.FilterNone((b: int) => (b == a), s.exchanges);
      }
    }
  }
}

lemma presentCode_ensures(s: GoogleSignIn, binding: Binding)
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysIdTokenSignInHadListedAudience(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysClockNeverNegative(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysAwaitedAttemptIsNumbered(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysRefusedReturnKeepsAttempt(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysMatchedFailureSpendsWithoutExchange(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysOneExchangePerAttempt(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysOneLockOwnerWithMatchingBindings(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysAtMostOneGrant(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysRedemptionIdsUnique(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysValidatedRedemptionMatchesBindings(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysSpentCodeBelongsToAttempt(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysGrantFollowsLiveConsume(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysGrantUsesIssuedLane(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysWrongBindingSpendsNothing(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysAdmissionNeedsCurrentEpoch(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysCancellingHoldsNoVerifier(presentCode(s, binding)))
  ensures (inv(s) ==> canPresentCode(s, binding) ==> alwaysTicketNotAhead(presentCode(s, binding)))
{
  if inv(s) && canPresentCode(s, binding) {
    AppendRedemption(s, Redemption(s.nextRedemption, binding, (if codeLive(s) then RedemptionPhase.Peeked else RedemptionPhase.RedemptionRefused), false), presentCode(s, binding));
  }
}

lemma validate_ensures(s: GoogleSignIn, id: int)
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysIdTokenSignInHadListedAudience(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysClockNeverNegative(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysAwaitedAttemptIsNumbered(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysRefusedReturnKeepsAttempt(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysMatchedFailureSpendsWithoutExchange(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysOneExchangePerAttempt(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysOneLockOwnerWithMatchingBindings(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysAtMostOneGrant(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysRedemptionIdsUnique(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysValidatedRedemptionMatchesBindings(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysSpentCodeBelongsToAttempt(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysGrantFollowsLiveConsume(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysGrantUsesIssuedLane(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysWrongBindingSpendsNothing(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysAdmissionNeedsCurrentEpoch(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysCancellingHoldsNoVerifier(validate(s, id)))
  ensures (inv(s) ==> canValidate(s, id) ==> alwaysTicketNotAhead(validate(s, id)))
{
  if inv(s) && canValidate(s, id) {
    var after := validate(s, id);
    var i := PhaseChange(s, id, (if ((s.now < s.payloadExpiresAt) && redemption(s, id).binding.AllBindingsMatch?) then RedemptionPhase.Validated else RedemptionPhase.RedemptionRefused), after);
    IdsBridge(after);
  }
}

lemma acquire_ensures(s: GoogleSignIn, id: int)
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysIdTokenSignInHadListedAudience(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysClockNeverNegative(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysAwaitedAttemptIsNumbered(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysRefusedReturnKeepsAttempt(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysMatchedFailureSpendsWithoutExchange(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysOneExchangePerAttempt(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysOneLockOwnerWithMatchingBindings(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysAtMostOneGrant(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysRedemptionIdsUnique(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysValidatedRedemptionMatchesBindings(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysSpentCodeBelongsToAttempt(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysGrantFollowsLiveConsume(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysGrantUsesIssuedLane(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysWrongBindingSpendsNothing(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysAdmissionNeedsCurrentEpoch(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysCancellingHoldsNoVerifier(acquire(s, id)))
  ensures (inv(s) ==> canAcquire(s, id) ==> alwaysTicketNotAhead(acquire(s, id)))
{
  if inv(s) && canAcquire(s, id) {
    var after := acquire(s, id);
    var i := PhaseChange(s, id, (if (s.lockOwner == 0) then RedemptionPhase.Locked else RedemptionPhase.LockBusy), after);
    IdsBridge(after);
    assert after.redemptions[i] in after.redemptions;
  }
}

lemma consumeCode_ensures(s: GoogleSignIn, id: int)
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysIdTokenSignInHadListedAudience(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysClockNeverNegative(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysAwaitedAttemptIsNumbered(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysRefusedReturnKeepsAttempt(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysMatchedFailureSpendsWithoutExchange(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysOneExchangePerAttempt(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysOneLockOwnerWithMatchingBindings(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysAtMostOneGrant(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysRedemptionIdsUnique(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysValidatedRedemptionMatchesBindings(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysSpentCodeBelongsToAttempt(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysGrantFollowsLiveConsume(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysGrantUsesIssuedLane(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysWrongBindingSpendsNothing(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysAdmissionNeedsCurrentEpoch(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysCancellingHoldsNoVerifier(consumeCode(s, id)))
  ensures (inv(s) ==> canConsumeCode(s, id) ==> alwaysTicketNotAhead(consumeCode(s, id)))
{
  if inv(s) && canConsumeCode(s, id) {
    var after := consumeCode(s, id);
    var i := PhaseChange(s, id, (if codeLive(s) then RedemptionPhase.CodeConsumed else RedemptionPhase.CodeMissing), after.(spentBy := s.spentBy));
    IdsBridge(after);
  }
}

lemma reply_ensures(s: GoogleSignIn, id: int)
  ensures (inv(s) ==> canReply(s, id) ==> alwaysIdTokenSignInHadListedAudience(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysClockNeverNegative(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysAwaitedAttemptIsNumbered(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysRefusedReturnKeepsAttempt(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysMatchedFailureSpendsWithoutExchange(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysOneExchangePerAttempt(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysOneLockOwnerWithMatchingBindings(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysAtMostOneGrant(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysRedemptionIdsUnique(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysValidatedRedemptionMatchesBindings(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysSpentCodeBelongsToAttempt(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysGrantFollowsLiveConsume(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysGrantUsesIssuedLane(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysWrongBindingSpendsNothing(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysAdmissionNeedsCurrentEpoch(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysCancellingHoldsNoVerifier(reply(s, id)))
  ensures (inv(s) ==> canReply(s, id) ==> alwaysTicketNotAhead(reply(s, id)))
{
  if inv(s) && canReply(s, id) {
    var after := reply(s, id);
    var ph := (if redemption(s, id).phase.CodeMissing? then RedemptionPhase.RedemptionRefused else (if s.lane.MfaLane? then RedemptionPhase.GrantedMfa else RedemptionPhase.GrantedSession));
    var i := PhaseChange(s, id, ph, after);
    IdsBridge(after);
    if granted(s.redemptions[i].(phase := ph)) {
      forall j | 0 <= j < |s.redemptions| ensures !granted(s.redemptions[j]) {
        assert s.redemptions[j] in s.redemptions;
      }
      ProofLib.FilterNone((r: Redemption) => granted(r), s.redemptions);
    }
  }
}
