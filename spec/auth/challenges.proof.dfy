lemma openChallenge_ensures(s: ChallengeStore, purpose: string)
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> alwaysOneChallengePerPurpose(openChallenge(s, purpose)))
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> alwaysOnePublisherPerChallenge(openChallenge(s, purpose)))
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> alwaysConsumedTokenStaysAbsent(openChallenge(s, purpose)))
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> stepConsumedNeverRevives(s, openChallenge(s, purpose)))
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> stepRevokedClaimStaysRevoked(s, openChallenge(s, purpose)))
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> stepExpiredChallengeIsFrozen(s, openChallenge(s, purpose)))
  ensures (inv(s) ==> canOpenChallenge(s, purpose) ==> stepOneChallengeChanges(s, openChallenge(s, purpose)))
{
  if inv(s) && canOpenChallenge(s, purpose) {
    var cs := s.challenges;
    var n := Challenge(purpose, 0, 0, false, false, s.now + challengeLifetime);
    var after := openChallenge(s, purpose);
    assert after.challenges == cs + [n];
    PurposeBridge(s);
    PurposeBridge(after);
    forall i, j | 0 <= i < |after.challenges| && 0 <= j < |after.challenges| && i != j
      ensures after.challenges[i].purpose != after.challenges[j].purpose
    {
      if i == |cs| { assert cs[j] in cs; } else if j == |cs| { assert cs[i] in cs; }
    }
    OneChangeBridge(s, after);
    ProofLib.FilterAppend((c: Challenge) => !((c in s.challenges)), cs, n);
    ProofLib.FilterNone((c: Challenge) => !((c in s.challenges)), cs);
  }
}

lemma elapse_ensures(s: ChallengeStore)
  ensures (inv(s) ==> alwaysOneChallengePerPurpose(elapse(s)))
  ensures (inv(s) ==> alwaysOnePublisherPerChallenge(elapse(s)))
  ensures (inv(s) ==> alwaysConsumedTokenStaysAbsent(elapse(s)))
  ensures (inv(s) ==> stepConsumedNeverRevives(s, elapse(s)))
  ensures (inv(s) ==> stepRevokedClaimStaysRevoked(s, elapse(s)))
  ensures (inv(s) ==> stepExpiredChallengeIsFrozen(s, elapse(s)))
  ensures (inv(s) ==> stepOneChallengeChanges(s, elapse(s)))
{
  OneChangeBridge(s, elapse(s));
  ProofLib.FilterNone((c: Challenge) => !((c in s.challenges)), s.challenges);
}

lemma publish_ensures(s: ChallengeStore, purpose: string, owner: int)
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> alwaysOneChallengePerPurpose(publish(s, purpose, owner)))
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> alwaysOnePublisherPerChallenge(publish(s, purpose, owner)))
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> alwaysConsumedTokenStaysAbsent(publish(s, purpose, owner)))
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> stepConsumedNeverRevives(s, publish(s, purpose, owner)))
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> stepRevokedClaimStaysRevoked(s, publish(s, purpose, owner)))
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> stepExpiredChallengeIsFrozen(s, publish(s, purpose, owner)))
  ensures (inv(s) ==> canPublish(s, purpose, owner) ==> stepOneChallengeChanges(s, publish(s, purpose, owner)))
{
  if inv(s) && canPublish(s, purpose, owner) {
    var i := PurposeAt(s, purpose);
    var c := s.challenges[i];
    var v := if c.claim == 0 then c.(claim := owner, issuer := owner, live := true) else c;
    var after := publish(s, purpose, owner);
    assert after.challenges == s.challenges[i := v];
    Update(s, after, i, v);
  }
}

lemma consume_ensures(s: ChallengeStore, purpose: string, owner: int)
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> alwaysOneChallengePerPurpose(consume(s, purpose, owner)))
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> alwaysOnePublisherPerChallenge(consume(s, purpose, owner)))
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> alwaysConsumedTokenStaysAbsent(consume(s, purpose, owner)))
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> stepConsumedNeverRevives(s, consume(s, purpose, owner)))
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> stepRevokedClaimStaysRevoked(s, consume(s, purpose, owner)))
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> stepExpiredChallengeIsFrozen(s, consume(s, purpose, owner)))
  ensures (inv(s) ==> canConsume(s, purpose, owner) ==> stepOneChallengeChanges(s, consume(s, purpose, owner)))
{
  if inv(s) && canConsume(s, purpose, owner) {
    var i := PurposeAt(s, purpose);
    var c := s.challenges[i];
    var v := c.(live := false, consumed := true);
    var after := consume(s, purpose, owner);
    assert after.challenges == s.challenges[i := v];
    assert c in s.challenges;
    Update(s, after, i, v);
  }
}

lemma revoke_ensures(s: ChallengeStore, purpose: string, owner: int)
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> alwaysOneChallengePerPurpose(revoke(s, purpose, owner)))
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> alwaysOnePublisherPerChallenge(revoke(s, purpose, owner)))
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> alwaysConsumedTokenStaysAbsent(revoke(s, purpose, owner)))
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> stepConsumedNeverRevives(s, revoke(s, purpose, owner)))
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> stepRevokedClaimStaysRevoked(s, revoke(s, purpose, owner)))
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> stepExpiredChallengeIsFrozen(s, revoke(s, purpose, owner)))
  ensures (inv(s) ==> canRevoke(s, purpose, owner) ==> stepOneChallengeChanges(s, revoke(s, purpose, owner)))
{
  if inv(s) && canRevoke(s, purpose, owner) {
    var i := PurposeAt(s, purpose);
    var c := s.challenges[i];
    var v := c.(claim := -1);
    var after := revoke(s, purpose, owner);
    assert after.challenges == s.challenges[i := v];
    assert c in s.challenges;
    Update(s, after, i, v);
  }
}

lemma PurposeBridge(s: ChallengeStore)
  ensures alwaysOneChallengePerPurpose(s) <==> ProofLib.DistinctBy(s.challenges, (o: Challenge) => o.purpose)
{
  var cs := s.challenges;
  assert alwaysOneChallengePerPurpose(s) <==> forall c :: c in cs ==> |ProofLib.Filter((o: Challenge) => (o.purpose == c.purpose), cs)| == 1;
  forall i | 0 <= i < |cs|
    ensures |ProofLib.Filter((o: Challenge) => (o.purpose == cs[i].purpose), cs)| == 1 <==> forall j :: 0 <= j < |cs| && j != i ==> cs[j].purpose != cs[i].purpose
  {
    ProofLib.FilterCountOneIffUnique((o: Challenge) => (o.purpose == cs[i].purpose), cs, (o: Challenge) => o.purpose, i);
  }
  if ProofLib.DistinctBy(cs, (o: Challenge) => o.purpose) {
    forall c | c in cs ensures |ProofLib.Filter((o: Challenge) => (o.purpose == c.purpose), cs)| == 1 {
      var i :| 0 <= i < |cs| && cs[i] == c;
    }
  }
}

lemma OneChangeBridge(before: ChallengeStore, after: ChallengeStore)
  ensures stepOneChallengeChanges(before, after) <==> |ProofLib.Filter((c: Challenge) => !((c in before.challenges)), after.challenges)| <= 1
{
}

lemma PurposeAt(s: ChallengeStore, purpose: string) returns (i: int)
  requires alwaysOneChallengePerPurpose(s) && hasChallenge(s, purpose)
  ensures 0 <= i < |s.challenges| && s.challenges[i].purpose == purpose && s.challenges[i] == challengeFor(s, purpose)
  ensures forall j :: 0 <= j < |s.challenges| && j != i ==> s.challenges[j].purpose != purpose
{
  PurposeBridge(s);
  var cs := s.challenges;
  var c :| c in cs && c.purpose == purpose;
  i :| 0 <= i < |cs| && cs[i] == c;
  ProofLib.FilterOne((c: Challenge) => (c.purpose == purpose), cs, i);
  ProofLib.FilterMember((c: Challenge) => (c.purpose == purpose), cs, cs[i]);
  assert challengeFor(s, purpose) == ProofLib.Filter((c: Challenge) => (c.purpose == purpose), cs)[0];
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

lemma Update(s: ChallengeStore, after: ChallengeStore, i: int, v: Challenge)
  requires inv(s) && 0 <= i < |s.challenges| && v.purpose == s.challenges[i].purpose && s.now < s.challenges[i].expiresAt
  requires after.now == s.now && after.challenges == s.challenges[i := v]
  ensures alwaysOneChallengePerPurpose(after)
  ensures stepOneChallengeChanges(s, after)
  ensures stepExpiredChallengeIsFrozen(s, after)
  ensures (s.challenges[i].consumed ==> v.consumed && !v.live) ==> stepConsumedNeverRevives(s, after)
  ensures (s.challenges[i].claim == -1 ==> v.claim == -1 && v.issuer == s.challenges[i].issuer) ==> stepRevokedClaimStaysRevoked(s, after)
  ensures forall x :: x in after.challenges ==> x == v || x in s.challenges
{
  var cs := s.challenges;
  var ys := after.challenges;
  PurposeBridge(s);
  PurposeBridge(after);
  assert forall j :: 0 <= j < |ys| ==> ys[j].purpose == cs[j].purpose;
  forall x | x in ys ensures x == v || x in cs {
    var j :| 0 <= j < |ys| && ys[j] == x;
    if j != i { assert cs[j] in cs; }
  }
  OneChangeBridge(s, after);
  ProofLib.FilterNone((c: Challenge) => !((c in s.challenges)), cs);
  FilterUpdateLength((c: Challenge) => !((c in s.challenges)), cs, i, v);
  forall c | c in cs && !(s.now < c.expiresAt) ensures c in ys {
    var k :| 0 <= k < |cs| && cs[k] == c;
    assert ys[k] == c;
  }
  if s.challenges[i].consumed ==> v.consumed && !v.live {
    forall b | b in cs && b.consumed ensures exists a :: a in ys && a.purpose == b.purpose && a.consumed && !a.live {
      var k :| 0 <= k < |cs| && cs[k] == b;
      assert ys[k] in ys;
    }
  }
  if s.challenges[i].claim == -1 ==> v.claim == -1 && v.issuer == s.challenges[i].issuer {
    forall b | b in cs && b.claim == -1 ensures exists a :: a in ys && a.purpose == b.purpose && a.claim == -1 && a.issuer == b.issuer {
      var k :| 0 <= k < |cs| && cs[k] == b;
      assert ys[k] in ys;
    }
  }
}
