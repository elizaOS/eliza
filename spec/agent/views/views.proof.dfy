lemma beginInstall_ensures(v: Views, installation: int)
  ensures (inv(v) ==> canBeginInstall(v, installation) ==> alwaysLiveInstallationsAreUnrevoked(beginInstall(v, installation)))
  ensures (inv(v) ==> canBeginInstall(v, installation) ==> alwaysClosedHoldsNothing(beginInstall(v, installation)))
  ensures (inv(v) ==> canBeginInstall(v, installation) ==> alwaysResultHasAnEntry(beginInstall(v, installation)))
  ensures (inv(v) ==> canBeginInstall(v, installation) ==> stepAnswerComesFromActiveInstallation(v, "beginInstall", beginInstall(v, installation)))
{
  RevokedWithMembers(v, v.pending);
}

lemma commitInstall_ensures(v: Views)
  ensures (inv(v) ==> canCommitInstall(v) ==> alwaysLiveInstallationsAreUnrevoked(commitInstall(v)))
  ensures (inv(v) ==> canCommitInstall(v) ==> alwaysClosedHoldsNothing(commitInstall(v)))
  ensures (inv(v) ==> canCommitInstall(v) ==> alwaysResultHasAnEntry(commitInstall(v)))
  ensures (inv(v) ==> canCommitInstall(v) ==> stepAnswerComesFromActiveInstallation(v, "commitInstall", commitInstall(v)))
{
  RevokedWithMembers(v, v.active);
}

lemma revokeInstall_ensures(v: Views)
  ensures (inv(v) ==> canRevokeInstall(v) ==> alwaysLiveInstallationsAreUnrevoked(revokeInstall(v)))
  ensures (inv(v) ==> canRevokeInstall(v) ==> alwaysClosedHoldsNothing(revokeInstall(v)))
  ensures (inv(v) ==> canRevokeInstall(v) ==> alwaysResultHasAnEntry(revokeInstall(v)))
  ensures (inv(v) ==> canRevokeInstall(v) ==> stepAnswerComesFromActiveInstallation(v, "revokeInstall", revokeInstall(v)))
{
  RevokedWithMembers(v, v.active);
}

lemma RevokedWithMembers(v: Views, installation: int)
  ensures forall x :: x in revokedWith(v, installation) <==> (x in v.revoked || (installation != 0 && x == installation))
{
  if installation != 0 {
    assert revokedWith(v, installation) == v.revoked + ProofLib.Filter((set_x: int) => !((set_x in v.revoked)), [installation]);
    forall x ensures x in ProofLib.Filter((set_x: int) => !((set_x in v.revoked)), [installation]) <==> (x == installation && x !in v.revoked) {
      ProofLib.FilterMember((set_x: int) => !((set_x in v.revoked)), [installation], x);
    }
  }
}
