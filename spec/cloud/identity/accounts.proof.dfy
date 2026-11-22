// Proofs that opening, linking and unlinking keep each identity once.

lemma DistinctView(a: Account)
  ensures alwaysIdentitiesAreDistinct(a) == !(exists i :: i in a.identities && !(|ProofLib.Filter((j: Identity) => (j == i), a.identities)| == 1))
{
}

lemma UnlinkView(a: Account, identity: Identity)
  ensures unlink(a, identity).identities == ProofLib.Filter((i: Identity) => (i != identity), a.identities)
{
}

lemma CountInSingle(x: Identity, i: Identity)
  requires i == x
  ensures |ProofLib.Filter((j: Identity) => (j == i), [x])| == 1
{
  ProofLib.FilterOne((j: Identity) => (j == i), [x], 0);
}

lemma CountAbsent(xs: seq<Identity>, x: Identity)
  requires !(x in xs)
  ensures |ProofLib.Filter((j: Identity) => (j == x), xs)| == 0
{
  ProofLib.FilterNone((j: Identity) => (j == x), xs);
}

lemma CountPresent(xs: seq<Identity>, i: Identity)
  requires i in xs
  ensures |ProofLib.Filter((j: Identity) => (j == i), xs)| >= 1
{
  ProofLib.FilterMember((j: Identity) => (j == i), xs, i);
}

lemma openAccount_ensures(a: Account, userId: string, organizationId: string, identity: Identity, verifiedEmail: bool, subjectOwner: Owner, emailOwner: Owner, referralCode: string)
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysLiveAccountHasReferralCode(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysUnopenedIsNotReferred(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysIdentitiesAreDistinct(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysLiveAccountCanSignIn(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysErasedHoldsNoIdentityOrCode(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysOpenedAccountHasItsOrganization(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysNeverReferredByItself(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> alwaysNeverReferredByOwnCode(openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> stepAccountKeepsItsUserAndOrganization(a, openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> stepStatusNeverGoesBack(a, openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> stepReferralIsFinal(a, openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode)))
  ensures (inv(a) ==> canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) ==> stepOnlyANewReferralCountsItsReferrer(a, openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode), []))
{
  if inv(a) && canOpenAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode) {
    var after := openAccount(a, userId, organizationId, identity, verifiedEmail, subjectOwner, emailOwner, referralCode);
    assert after.identities == [identity];
    forall i | i in after.identities
      ensures |ProofLib.Filter((j: Identity) => (j == i), after.identities)| == 1
    {
      CountInSingle(identity, i);
    }
    DistinctView(after);
  }
}

lemma link_ensures(a: Account, identity: Identity, subjectOwner: Owner)
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysLiveAccountHasReferralCode(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysUnopenedIsNotReferred(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysIdentitiesAreDistinct(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysLiveAccountCanSignIn(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysErasedHoldsNoIdentityOrCode(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysOpenedAccountHasItsOrganization(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysNeverReferredByItself(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> alwaysNeverReferredByOwnCode(link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> stepAccountKeepsItsUserAndOrganization(a, link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> stepStatusNeverGoesBack(a, link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> stepReferralIsFinal(a, link(a, identity, subjectOwner)))
  ensures (inv(a) ==> canLink(a, identity, subjectOwner) ==> stepOnlyANewReferralCountsItsReferrer(a, link(a, identity, subjectOwner), []))
{
  if inv(a) && canLink(a, identity, subjectOwner) {
    var after := link(a, identity, subjectOwner);
    var xs := a.identities;
    assert after.identities == xs + [identity];
    DistinctView(a);
    forall i | i in after.identities
      ensures |ProofLib.Filter((j: Identity) => (j == i), after.identities)| == 1
    {
      ProofLib.FilterAppend((j: Identity) => (j == i), xs, identity);
      if i == identity {
        CountAbsent(xs, identity);
      } else {
        assert i in xs;
      }
    }
    DistinctView(after);
  }
}

lemma unlink_ensures(a: Account, identity: Identity)
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysLiveAccountHasReferralCode(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysUnopenedIsNotReferred(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysIdentitiesAreDistinct(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysLiveAccountCanSignIn(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysErasedHoldsNoIdentityOrCode(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysOpenedAccountHasItsOrganization(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysNeverReferredByItself(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> alwaysNeverReferredByOwnCode(unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> stepAccountKeepsItsUserAndOrganization(a, unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> stepStatusNeverGoesBack(a, unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> stepReferralIsFinal(a, unlink(a, identity)))
  ensures (inv(a) ==> canUnlink(a, identity) ==> stepOnlyANewReferralCountsItsReferrer(a, unlink(a, identity), []))
{
  if inv(a) && canUnlink(a, identity) {
    var after := unlink(a, identity);
    var xs := a.identities;
    UnlinkView(a, identity);
    var ys := ProofLib.Filter((i: Identity) => (i != identity), xs);
    assert after.identities == ys;
    DistinctView(a);
    forall i | i in ys
      ensures |ProofLib.Filter((j: Identity) => (j == i), ys)| == 1
    {
      ProofLib.FilterMember((i: Identity) => (i != identity), xs, i);
      assert i in xs;
      ProofLib.FilterOfFilterShorter((i: Identity) => (i != identity), (j: Identity) => (j == i), xs);
      CountPresent(ys, i);
    }
    DistinctView(after);
  }
}
