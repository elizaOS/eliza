lemma InternalActorTokenFacts(s: InternalActors)
  ensures alwaysRegistrationTokensAreUnique(s) ==
    (s.nextToken > 0 && (forall row :: row in s.registrations ==> (0 < row.token < s.nextToken &&
      |ProofLib.Filter((other: InternalRegistration) => other.token == row.token, s.registrations)| == 1)))
{}

lemma register_ensures(s: InternalActors, by_: InternalCaller, runtime: string, actor: string)
  ensures (inv(s) ==> canRegister(s, by_, runtime, actor) ==> alwaysRegistrationTokensAreUnique(register(s, by_, runtime, actor)))
{
  if inv(s) && canRegister(s, by_, runtime, actor) {
    var row := InternalRegistration(s.nextToken, runtime, actor);
    var after := register(s, by_, runtime, actor);
    InternalActorTokenFacts(s);
    InternalActorTokenFacts(after);
    assert after.registrations == s.registrations + [row];
    forall current | current in after.registrations
      ensures 0 < current.token < after.nextToken
      ensures |ProofLib.Filter((other: InternalRegistration) => other.token == current.token, after.registrations)| == 1
    {
      var key := (other: InternalRegistration) => other.token == current.token;
      ProofLib.FilterAppend(key, s.registrations, row);
      if current == row {
        ProofLib.FilterNone(key, s.registrations);
      } else {
        assert current in s.registrations;
        assert current.token < s.nextToken;
      }
    }
  }
}

lemma dispose_ensures(s: InternalActors, by_: InternalCaller, token: int)
  ensures (inv(s) ==> canDispose(s, by_) ==> alwaysRegistrationTokensAreUnique(dispose(s, by_, token)))
{
  if inv(s) && canDispose(s, by_) {
    var keep := (row: InternalRegistration) => row.token != token;
    var after := dispose(s, by_, token);
    assert after.registrations == ProofLib.Filter(keep, s.registrations);
    InternalActorTokenFacts(s);
    InternalActorTokenFacts(after);
    forall current | current in after.registrations
      ensures 0 < current.token < after.nextToken
      ensures |ProofLib.Filter((other: InternalRegistration) => other.token == current.token, after.registrations)| == 1
    {
      var key := (other: InternalRegistration) => other.token == current.token;
      ProofLib.FilterMember(keep, s.registrations, current);
      ProofLib.FilterOfFilterShorter(keep, key, s.registrations);
      ProofLib.FilterMember(key, after.registrations, current);
    }
  }
}

lemma lawDisposeKeepsOtherReferences_ensures(s: InternalActors, token: int, entry: InternalRegistration)
  ensures (lawDisposeKeepsOtherReferences(s, token, entry) == true)
{
  var keep := (row: InternalRegistration) => row.token != token;
  assert dispose(s, InternalCaller.ManagedRuntime, token).registrations == ProofLib.Filter(keep, s.registrations);
  ProofLib.FilterMember(keep, s.registrations, entry);
}
