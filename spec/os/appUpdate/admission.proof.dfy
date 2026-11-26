lemma lawOneKeyNeverApprovesStable_ensures(roles: ChannelRoles, rootKeys: seq<int>, approver: int)
  ensures (lawOneKeyNeverApprovesStable(roles, rootKeys, approver) == true)
{
  if channelRolesValid(roles, rootKeys) {
    var ms := roles.stableKeys.members;
    if approver in ms {
      ProofLib.FilterSamePredicate((k: int) => (k in [approver, approver]), (x: int) => (x == approver), ms);
    } else {
      ProofLib.FilterNone((k: int) => (k in [approver, approver]), ms);
    }
  }
}

lemma lawOtherKeysNeverApproveStable_ensures(roles: ChannelRoles, rootKeys: seq<int>)
  ensures (lawOtherKeysNeverApproveStable(roles, rootKeys) == true)
{
  if channelRolesValid(roles, rootKeys) {
    var ms := roles.stableKeys.members;
    var approvers := roles.betaKeys.members + rootKeys;
    forall i | 0 <= i < |ms|
      ensures !(ms[i] in approvers)
    {
      assert ms[i] in ms;
    }
    ProofLib.FilterNone((k: int) => (k in approvers), ms);
  }
}

lemma lawEligibleNeedsEveryAuthority_ensures(host: HostPolicy, r: Release, device: Device, bounds: AdmissionBounds, floor: LaneFloor)
  ensures (lawEligibleNeedsEveryAuthority(host, r, device, bounds, floor) == true)
{
  reveal Std.Collections.Seq.Filter();
}

lemma lawRevokedRecoveryNeverLoads_ensures(r: Release, floor: LaneFloor, globalSecurityFloor: int)
  ensures (lawRevokedRecoveryNeverLoads(r, floor, globalSecurityFloor) == true)
{
  if os__image__apk_isDigest(r.recovery.sha256) {
    var rev := floor.revoked + [r.recovery.sha256];
    assert r.recovery.sha256 in rev;
  }
}
