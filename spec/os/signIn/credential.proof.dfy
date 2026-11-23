lemma revokeAnswered_ensures(s: DeviceCredential, version: int, reply: RevokeReply)
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysCountersAreNatural(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysSignInIsTheNewestAction(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysKeysAreMintedInOrder(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysDutiesNameRetiredKeys(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysSessionBelongsToTheActiveKey(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysRefreshWaitersAreCounted(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepGenerationCountsOwnerActions(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepEachNewKeyIsAnnouncedOnce(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepAKeyLeavesOnlyWithItsDuty(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepRestartKeepsCustody(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepOneRefreshInFlight(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepARenewalKeepsTheActiveKey(s, "revokeAnswered", revokeAnswered(s, version, reply)))
{
  if inv(s) && canRevokeAnswered(s, version) {
    var after := revokeAnswered(s, version, reply);
    if reply.RevokeSettled? {
      assert after.duties == ProofLib.Filter((d: Duty) => (d.version != version), s.duties);
      FilteredCredentialDutiesStayRetired(s, after, (d: Duty) => (d.version != version));
    } else {
      forall d | d in after.duties
        ensures d.version >= 1 && d.version <= after.lastVersion
          && 0 <= d.tries <= signOutAttempts
          && d.version != activeVersion(after) && d.version != pendingVersion(after)
      {
        var i :| 0 <= i < |after.duties| && after.duties[i] == d;
        assert |after.duties| == |s.duties|;
        var prior := s.duties[i];
        assert d == (if ((prior.version == version) && (prior.tries > 0)) then prior.(tries := (prior.tries - 1)) else prior);
        RetiredCredentialDutyKeepsItsBounds(s, after, prior, d);
      }
      assert alwaysDutiesNameRetiredKeys(after);
    }
  }
}

lemma elapse_ensures(s: DeviceCredential, ms: int)
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysCountersAreNatural(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysSignInIsTheNewestAction(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysKeysAreMintedInOrder(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysDutiesNameRetiredKeys(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysSessionBelongsToTheActiveKey(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysRefreshWaitersAreCounted(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepGenerationCountsOwnerActions(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepEachNewKeyIsAnnouncedOnce(s, "elapse", elapse(s, ms), []))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepAKeyLeavesOnlyWithItsDuty(s, "elapse", elapse(s, ms), []))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepRestartKeepsCustody(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepOneRefreshInFlight(s, "elapse", elapse(s, ms), []))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepARenewalKeepsTheActiveKey(s, "elapse", elapse(s, ms)))
{
  if inv(s) && canElapse(s, ms) {
    var after := elapse(s, ms);
    assert after.duties == ProofLib.Filter((d: Duty) => (d.lapsesAt > (s.now + ms)), s.duties);
    FilteredCredentialDutiesStayRetired(s, after, (d: Duty) => (d.lapsesAt > (s.now + ms)));
  }
}

// A filter leaves each kept duty unchanged. Time, sessions, and the list
// itself do not determine which key is the active or pending key.
lemma FilteredCredentialDutiesStayRetired(before: DeviceCredential, after: DeviceCredential, keep: Duty -> bool)
  requires alwaysDutiesNameRetiredKeys(before)
  requires before.lastVersion == after.lastVersion && before.custody == after.custody && before.attempt == after.attempt
  requires after.duties == ProofLib.Filter(keep, before.duties)
  ensures alwaysDutiesNameRetiredKeys(after)
{
  forall d | d in after.duties
    ensures d.version >= 1 && d.version <= after.lastVersion
      && 0 <= d.tries <= signOutAttempts
      && d.version != activeVersion(after) && d.version != pendingVersion(after)
  {
    ProofLib.FilterMember(keep, before.duties, d);
    RetiredCredentialDutyKeepsItsBounds(before, after, d, d);
  }
}

// An unanswered request can reduce a positive try count by one. It keeps
// the retired key's version and cannot create a negative try count.
lemma RetiredCredentialDutyKeepsItsBounds(before: DeviceCredential, after: DeviceCredential, prior: Duty, current: Duty)
  requires alwaysDutiesNameRetiredKeys(before) && prior in before.duties
  requires before.lastVersion == after.lastVersion && before.custody == after.custody && before.attempt == after.attempt
  requires current.version == prior.version && 0 <= current.tries <= prior.tries
  ensures current.version >= 1 && current.version <= after.lastVersion
  ensures 0 <= current.tries <= signOutAttempts
  ensures current.version != activeVersion(after) && current.version != pendingVersion(after)
{
  assert activeVersion(before) == activeVersion(after);
  assert pendingVersion(before) == pendingVersion(after);
}
