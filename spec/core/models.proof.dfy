lemma AttemptIdentityFilters(s: Dispatch)
  ensures alwaysRegistrationAttemptedOnce(s) == (forall a :: a in s.attempts ==> |ProofLib.Filter((b: Attempt) => (a.registration.id == b.registration.id), s.attempts)| == 1)
{}

lemma RegistrationIdentityFilters(rs: seq<Registration>)
  ensures uniqueRegistrations(rs) == (forall r :: r in rs ==> |ProofLib.Filter((other: Registration) => (other.id == r.id), rs)| == 1)
{}

lemma RetryExactFilter(rs: seq<Registration>, exhausted: seq<int>)
  ensures tryRegistration(rs, exhausted) == ProofLib.Filter((r: Registration) => !((r.provider in exhausted)), (if ((0 <= 0) && (0 < |rs|)) then (rs[0..0] + rs[(0 + 1)..]) else rs))
{}

lemma RetryParts(rs: seq<Registration>, exhausted: seq<int>)
  requires |rs| > 0
  ensures tryRegistration(rs, exhausted) == ProofLib.Filter((r: Registration) => !((r.provider in exhausted)), rs[1..])
{
  RetryExactFilter(rs, exhausted);
  assert rs[0..0] == [];
  assert rs[0..0] + rs[(0 + 1)..] == rs[1..];
}

lemma FilterRegistrationTail(rs: seq<Registration>, exhausted: seq<int>)
  requires |rs| > 0 && uniqueRegistrations(rs)
  ensures uniqueRegistrations(tryRegistration(rs, exhausted))
  ensures forall r :: r in tryRegistration(rs, exhausted) ==> r in rs && r.id != rs[0].id
{
  RetryParts(rs, exhausted); RegistrationIdentityFilters(rs);
  var following := tryRegistration(rs, exhausted);
  RegistrationIdentityFilters(following);
  ProofLib.FilterSubset((r: Registration) => !((r.provider in exhausted)), rs[1..]);
  forall r | r in following
    ensures r in rs && r.id != rs[0].id && |ProofLib.Filter((other: Registration) => (other.id == r.id), following)| == 1
  {
    assert r in rs[1..] && r in rs;
    ProofLib.FilterCons((other: Registration) => (other.id == r.id), rs);
    ProofLib.FilterMember((other: Registration) => (other.id == r.id), rs[1..], r);
    assert |ProofLib.Filter((other: Registration) => (other.id == r.id), rs[1..])| > 0;
    ProofLib.FilterOfFilterShorter((r: Registration) => !((r.provider in exhausted)), (other: Registration) => (other.id == r.id), rs[1..]);
    ProofLib.FilterMember((other: Registration) => (other.id == r.id), following, r);
  }
}

lemma AppendInvocation(s: Dispatch, after: Dispatch, added: Attempt)
  requires alwaysRegistrationAttemptedOnce(s)
  requires !(exists a :: a in s.attempts && a.registration.id == added.registration.id)
  requires after.attempts == s.attempts + [added]
  ensures alwaysRegistrationAttemptedOnce(after)
{
  AttemptIdentityFilters(s); AttemptIdentityFilters(after);
  forall a | a in after.attempts
    ensures |ProofLib.Filter((b: Attempt) => (a.registration.id == b.registration.id), after.attempts)| == 1
  {
    ProofLib.FilterAppend((b: Attempt) => (a.registration.id == b.registration.id), s.attempts, added);
    if a.registration.id == added.registration.id {
      ProofLib.FilterNone((b: Attempt) => (a.registration.id == b.registration.id), s.attempts);
    } else { assert a in s.attempts; }
  }
}

lemma observeOutcome_ensures(s: Dispatch, resultKind: Outcome)
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysAdmittedRequestComplete(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysRegistrationAttemptedOnce(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysTerminalOutcomeEndsChain(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysAnswerNamesProvider(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysExhaustedProvidersSkipped(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysConfiguredHasNoAttempts(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysRemainingRegistrationsFresh(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysActiveDispatchHasRegistration(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> alwaysDispatchDeadlockFree(observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> stepSourceBytesPreserved(s, observeOutcome(s, resultKind)))
  ensures (inv(s) ==> canObserveOutcome(s, resultKind) ==> stepNoRetryAfterCancellation(s, observeOutcome(s, resultKind)))
{
  if inv(s) && canObserveOutcome(s, resultKind) {
    var after := observeOutcome(s, resultKind);
    var head := s.remaining[0];
    assert head in s.remaining;
    AppendInvocation(s, after, Attempt(head, resultKind));
    if after.phase.Admitted? {
      FilterRegistrationTail(s.remaining, after.exhausted);
      assert after.remaining == tryRegistration(s.remaining, after.exhausted);
      forall r | r in after.remaining ensures !(exists a :: a in after.attempts && a.registration.id == r.id)
      { assert r in s.remaining && r.id != head.id; }
    }
  }
}
