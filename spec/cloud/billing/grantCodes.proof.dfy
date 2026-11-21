lemma GrantCanonicalUnit(code: int)
  requires code in crockfordAlphabetUnits
  ensures code != 55351
  ensures normalizeGrantUnit(code) == [code]
{
  assert 48 <= code <= 90;
  assert code != 73 && code != 76 && code != 79;
  assert !core__streamUnits_whitespace(code);
}

lemma GrantCanonicalStep(prefix: seq<int>, code: int)
  requires |prefix| <= grantCodeLength
  requires code in crockfordAlphabetUnits
  ensures normalizeGrantStep(SecretCodeWalk(0, prefix), code) == SecretCodeWalk(0, prefix + [code])
{
  GrantCanonicalUnit(code);
}

lemma {:induction false} GrantCanonicalPrefix(units: seq<int>)
  requires |units| <= grantCodeLength
  requires forall code :: code in units ==> code in crockfordAlphabetUnits
  ensures Std.Collections.Seq.FoldLeft((walk: SecretCodeWalk, code: int) => normalizeGrantStep(walk, code), SecretCodeWalk(0, []), units) == SecretCodeWalk(0, units)
  decreases |units|
{
  if |units| > 0 {
    var prefix := units[..|units|-1];
    var last := units[|units|-1];
    assert units == prefix + [last];
    forall code | code in prefix
      ensures code in crockfordAlphabetUnits
    {
      assert code in units;
    }
    GrantCanonicalPrefix(prefix);
    assert last in crockfordAlphabetUnits;
    GrantCanonicalStep(prefix, last);
    ProofLib.FoldLeftAppend((walk: SecretCodeWalk, code: int) => normalizeGrantStep(walk, code), SecretCodeWalk(0, []), prefix, last);
  }
}

lemma lawCanonicalCodesSurviveNormalization_ensures(units: seq<int>)
  ensures (lawCanonicalCodesSurviveNormalization(units) == true)
{
  if declassifyGrantCodeValid(units) {
    GrantCanonicalPrefix(units);
  }
}

lemma GrantDrawPrefix(draws: seq<int>)
  requires forall code :: code in draws ==> 0 <= code <= 255
  ensures |Std.Collections.Seq.FoldLeft((units: SecretCodeUnits, code: int) => appendGrantDraw(units, code), [], draws)| == |draws|
  ensures forall digit ::
    digit in Std.Collections.Seq.FoldLeft((units: SecretCodeUnits, code: int) => appendGrantDraw(units, code), [], draws) ==>
      digit in crockfordAlphabetUnits
  decreases |draws|
{
  if |draws| > 0 {
    var prefix := draws[..|draws|-1];
    var last := draws[|draws|-1];
    assert draws == prefix + [last];
    forall code | code in prefix
      ensures 0 <= code <= 255
    {
      assert code in draws;
    }
    GrantDrawPrefix(prefix);
    var encoded := Std.Collections.Seq.FoldLeft((units: SecretCodeUnits, code: int) => appendGrantDraw(units, code), [], prefix);
    assert last in draws;
    assert 0 <= last <= 255;
    var offset := remainder_cloud__billing__grantCodes(last, 32);
    assert offset == last % 32;
    assert 0 <= offset < |crockfordAlphabetUnits|;
    var nextDigit := crockfordAlphabetUnits[offset];
    assert nextDigit in crockfordAlphabetUnits;
    assert appendGrantDraw(encoded, last) == encoded + [nextDigit];
    ProofLib.FoldLeftAppend((units: SecretCodeUnits, code: int) => appendGrantDraw(units, code), [], prefix, last);
    forall digit | digit in encoded + [nextDigit]
      ensures digit in crockfordAlphabetUnits
    {
      assert digit in encoded || digit == nextDigit;
    }
  }
}

lemma lawByteDrawsMakeCanonicalCodes_ensures(draws: seq<int>)
  ensures (lawByteDrawsMakeCanonicalCodes(draws) == true)
{
  if |draws| == grantCodeLength && (forall code :: code in draws ==> 0 <= code <= 255) {
    GrantDrawPrefix(draws);
  }
}

lemma GrantCountRule(c: Code)
  ensures alwaysOneGrantPerOrganizationAndId(c) ==
    !(exists g :: (g in c.grants &&
      |ProofLib.Filter((h: Grant) => ((h.organizationId == g.organizationId) || (h.grantId == g.grantId)), c.grants)| != 1))
{
}

lemma GrantLookupFromList(c: Code, organizationId: string)
  requires hasRedeemed(c, organizationId)
  ensures grantOf(c, organizationId) in c.grants
  ensures grantOf(c, organizationId).organizationId == organizationId
{
  var g :| g in c.grants && g.organizationId == organizationId;
  var p := (h: Grant) => (h.organizationId == organizationId);
  ProofLib.FilterMember(p, c.grants, g);
  var held := ProofLib.Filter(p, c.grants);
  assert |held| > 0;
  assert grantOf(c, organizationId) == held[0];
  ProofLib.FilterMember(p, c.grants, held[0]);
}

lemma GrantLookupFindsUnique(c: Code, g: Grant)
  requires alwaysOneGrantPerOrganizationAndId(c)
  requires g in c.grants
  ensures grantOf(c, g.organizationId) == g
{
  assert hasRedeemed(c, g.organizationId);
  GrantLookupFromList(c, g.organizationId);
  var held := grantOf(c, g.organizationId);
  GrantCountRule(c);
  var p := (h: Grant) => ((h.organizationId == g.organizationId) || (h.grantId == g.grantId));
  var matches := ProofLib.Filter(p, c.grants);
  assert |matches| == 1;
  ProofLib.FilterMember(p, c.grants, g);
  ProofLib.FilterMember(p, c.grants, held);
  assert matches == [matches[0]];
}

lemma GrantAppendPreservesUnique(c: Code, after: Code, added: Grant)
  requires alwaysOneGrantPerOrganizationAndId(c)
  requires after.grants == c.grants + [added]
  requires forall previous :: previous in c.grants ==> previous.organizationId != added.organizationId && previous.grantId != added.grantId
  ensures alwaysOneGrantPerOrganizationAndId(after)
{
  GrantCountRule(c);
  GrantCountRule(after);
  forall g | g in after.grants
    ensures |ProofLib.Filter((h: Grant) => ((h.organizationId == g.organizationId) || (h.grantId == g.grantId)), after.grants)| == 1
  {
    var p := (h: Grant) => ((h.organizationId == g.organizationId) || (h.grantId == g.grantId));
    ProofLib.FilterAppend(p, c.grants, added);
    if g == added {
      forall i | 0 <= i < |c.grants|
        ensures !p(c.grants[i])
      {
        assert c.grants[i] in c.grants;
      }
      ProofLib.FilterNone(p, c.grants);
    } else {
      assert g in c.grants;
      assert !p(added);
    }
  }
}

lemma GrantMappingPreservesUnique(c: Code, after: Code)
  requires alwaysOneGrantPerOrganizationAndId(c)
  requires |c.grants| == |after.grants|
  requires forall i :: 0 <= i < |c.grants| ==>
    c.grants[i].organizationId == after.grants[i].organizationId && c.grants[i].grantId == after.grants[i].grantId
  ensures alwaysOneGrantPerOrganizationAndId(after)
{
  GrantCountRule(c);
  GrantCountRule(after);
  forall g | g in after.grants
    ensures |ProofLib.Filter((h: Grant) => ((h.organizationId == g.organizationId) || (h.grantId == g.grantId)), after.grants)| == 1
  {
    var chosen :| 0 <= chosen < |after.grants| && after.grants[chosen] == g;
    var previous := c.grants[chosen];
    var beforeMatches := (h: Grant) => ((h.organizationId == previous.organizationId) || (h.grantId == previous.grantId));
    var afterMatches := (h: Grant) => ((h.organizationId == g.organizationId) || (h.grantId == g.grantId));
    assert previous in c.grants;
    assert |ProofLib.Filter(beforeMatches, c.grants)| == 1;
    forall i | 0 <= i < |c.grants|
      ensures beforeMatches(c.grants[i]) == afterMatches(after.grants[i])
    {
      assert previous.organizationId == g.organizationId && previous.grantId == g.grantId;
    }
    ProofLib.FilterLengthPointwise(beforeMatches, afterMatches, c.grants, after.grants);
  }
}

lemma redeem_ensures(c: Code, organizationId: string, accountActive: bool, idempotencyKey: string, keyUsedForAnotherCode: bool, familyHeld: bool, paidPlanOpen: bool, grantId: string, now: int)
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> alwaysAMintedCodeIsWellFormed(redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> alwaysEveryGrantFitsItsCode(redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> alwaysAnswerIsHeldOrWellFormed(redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> alwaysOneGrantPerOrganizationAndId(redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> alwaysWithinTheRedemptionLimit(redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> alwaysRevokedNoEarlierThanItBegan(redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> stepTermsNeverChangeOnceMinted(c, redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> stepGrantsAreNeverTakenBack(c, redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> stepOnlyAFreshRedemptionIssuesAGrant(c, "redeem", redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state, redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).out))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> stepDisabledStaysDisabled(c, redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> stepRevocationIsFinal(c, redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state))
  ensures (inv(c) ==> canRedeem(c, organizationId, idempotencyKey, grantId, now) ==> stepOnlyRevocationRetiresMonths(c, "redeem", redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state, redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).out))
{
  if inv(c) && canRedeem(c, organizationId, idempotencyKey, grantId, now) {
    var answer := redeemAnswer(c, organizationId, accountActive, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now);
    var after := redeem(c, organizationId, accountActive, idempotencyKey, keyUsedForAnotherCode, familyHeld, paidPlanOpen, grantId, now).state;
    if answer.Answered? {
      if hasRedeemed(c, organizationId) {
        GrantLookupFromList(c, organizationId);
        assert answer == Answered(organizationId, grantOf(c, organizationId).grantId, true);
        assert after.grants == c.grants;
        assert grantOf(after, organizationId) == grantOf(c, organizationId);
      } else {
        assert answer == Answered(organizationId, grantId, false);
        var added := Grant(grantId, organizationId, idempotencyKey, now, grantEndOf(c.term, now), GrantStanding.InForce);
        assert after.grants == c.grants + [added];
        GrantAppendPreservesUnique(c, after, added);
        assert added in after.grants;
        GrantLookupFindsUnique(after, added);
      }
      assert alwaysAnswerIsHeldOrWellFormed(after);
    } else {
      assert after.grants == c.grants;
    }
  }
}

lemma revokeGrant_ensures(c: Code, organizationId: string, now: int)
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> alwaysAMintedCodeIsWellFormed(revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> alwaysEveryGrantFitsItsCode(revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> alwaysAnswerIsHeldOrWellFormed(revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> alwaysOneGrantPerOrganizationAndId(revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> alwaysWithinTheRedemptionLimit(revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> alwaysRevokedNoEarlierThanItBegan(revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> stepTermsNeverChangeOnceMinted(c, revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> stepGrantsAreNeverTakenBack(c, revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> stepOnlyAFreshRedemptionIssuesAGrant(c, "revokeGrant", revokeGrant(c, organizationId, now).state, revokeGrant(c, organizationId, now).out))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> stepDisabledStaysDisabled(c, revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> stepRevocationIsFinal(c, revokeGrant(c, organizationId, now).state))
  ensures (inv(c) ==> canRevokeGrant(c, organizationId, now) ==> stepOnlyRevocationRetiresMonths(c, "revokeGrant", revokeGrant(c, organizationId, now).state, revokeGrant(c, organizationId, now).out))
{
  if inv(c) && canRevokeGrant(c, organizationId, now) {
    GrantTermsPreservedOnRevocation(c, organizationId, now);
    var step := revokeGrant(c, organizationId, now);
    var after := step.state;
    GrantLookupFromList(c, organizationId);
    var held := grantOf(c, organizationId);
    var position :| 0 <= position < |c.grants| && c.grants[position] == held;
    assert |after.grants| == |c.grants|;
    forall i | 0 <= i < |c.grants|
      ensures after.grants[i] == (if c.grants[i].organizationId == organizationId then c.grants[i].(standing := RevokedAt(now)) else c.grants[i])
    {
      assert after.grants[i] == (if c.grants[i].organizationId == organizationId then c.grants[i].(standing := RevokedAt(now)) else c.grants[i]);
    }
    forall i | 0 <= i < |c.grants|
      ensures c.grants[i].organizationId == after.grants[i].organizationId && c.grants[i].grantId == after.grants[i].grantId
    {
      assert after.grants[i] == (if c.grants[i].organizationId == organizationId then c.grants[i].(standing := RevokedAt(now)) else c.grants[i]);
    }
    GrantMappingPreservesUnique(c, after);
    forall g | g in after.grants
      ensures revokedInTime(g)
    {
      var i :| 0 <= i < |after.grants| && after.grants[i] == g;
      var previous := c.grants[i];
      assert previous in c.grants;
      if previous.organizationId == organizationId {
        GrantLookupFindsUnique(c, previous);
        assert previous == held;
      }
    }
    forall previous | previous in c.grants
      ensures exists g :: g in after.grants && g.grantId == previous.grantId && g.organizationId == previous.organizationId && g.startsAt == previous.startsAt && g.ends == previous.ends
      ensures isInForce(previous) || (exists g :: g in after.grants && g.grantId == previous.grantId && g.organizationId == previous.organizationId && g.standing == previous.standing)
    {
      var i :| 0 <= i < |c.grants| && c.grants[i] == previous;
      var mapped := after.grants[i];
      assert mapped in after.grants;
      if previous.organizationId == organizationId {
        GrantLookupFindsUnique(c, previous);
        assert previous == held;
      }
    }
    assert after.last == c.last;
    if c.last.Answered? {
      GrantLookupFromList(c, c.last.organizationId);
      var answered := grantOf(c, c.last.organizationId);
      var i :| 0 <= i < |c.grants| && c.grants[i] == answered;
      var current := after.grants[i];
      assert current in after.grants;
      GrantLookupFindsUnique(after, current);
    }
    assert after.grants[position] in after.grants;
    assert after.grants[position] == held.(standing := RevokedAt(now));
    assert !isInForce(after.grants[position]);
    assert step.out == [RetireGrantMonths(held.grantId)];
  }
}

lemma GrantTermsPreservedOnRevocation(c: Code, organizationId: string, now: int)
  requires alwaysEveryGrantFitsItsCode(c)
  ensures alwaysEveryGrantFitsItsCode(revokeGrant(c, organizationId, now).state)
{
  var after := revokeGrant(c, organizationId, now).state;
  assert after.term == c.term;
  assert |after.grants| == |c.grants|;
  forall g | g in after.grants
    ensures grantFits(after, g)
  {
    var i :| 0 <= i < |after.grants| && after.grants[i] == g;
    var previous := c.grants[i];
    assert previous in c.grants;
    assert grantFits(c, previous);
    assert g == (if previous.organizationId == organizationId then previous.(standing := RevokedAt(now)) else previous);
    assert g.grantId == previous.grantId && g.organizationId == previous.organizationId &&
      g.idempotencyKey == previous.idempotencyKey && g.startsAt == previous.startsAt && g.ends == previous.ends;
    assert grantEndOf(after.term, g.startsAt) == grantEndOf(c.term, previous.startsAt);
  }
}
