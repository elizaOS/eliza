lemma lawMailLeaseUpgradeKeepsTheOwner_ensures(s: DeviceCredential, expected: MailLeaseUpgrade, attempt: int, credentialId: string, keyExpiresAt: int)
  ensures (lawMailLeaseUpgradeKeepsTheOwner(s, expected, attempt, credentialId, keyExpiresAt) == true)
{
  var after := mailLeaseUpgradeAcknowledged(expected, attempt, credentialId, keyExpiresAt, s);
  if mailLeaseUpgradeMayAcknowledge(s, expected) && canAcknowledged(s, attempt, credentialId, keyExpiresAt) {
    assert s.attempt.Acknowledging?;
    assert s.attempt.account == expected.account && accountOf(s) == expected.account;
    assert s.attempt.lease.Offered?;
    assert s.attempt.version > expected.version >= 1;
    assert accountOf(after.state) == s.attempt.account;
    assert leaseVersionOf(after.state.lease) == s.attempt.version;
  } else {
    assert after.state.custody == s.custody;
    assert after.out == [];
  }
}

lemma revokeAnswered_ensures(s: DeviceCredential, version: int, reply: RevokeReply)
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysCountersAreNatural(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysSignInIsTheNewestAction(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysKeysAreMintedInOrder(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysLeaseBelongsToTheActiveKey(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysLeaseWaitersAreCounted(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysARenewalKeepsTheAccount(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysDutiesNameRetiredKeys(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysSessionBelongsToTheActiveKey(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> alwaysRefreshWaitersAreCounted(revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepGenerationCountsOwnerActions(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepEachNewKeyIsAnnouncedOnce(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepAReplacedKeyNamesItsSuccessor(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepOneLeaseRefreshInFlight(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepARenewalStartsOnlyFromTheLease(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepARenewalKeepsTheActiveKey(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepAKeyLeavesOnlyWithItsDuty(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepALeaseLeavesOnlyWithItsDuty(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepAnEndedKeyNamesNoSuccessor(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepRestartKeepsCustody(s, "revokeAnswered", revokeAnswered(s, version, reply)))
  ensures (inv(s) ==> canRevokeAnswered(s, version) ==> stepOneRefreshInFlight(s, "revokeAnswered", revokeAnswered(s, version, reply), []))
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
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysLeaseBelongsToTheActiveKey(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysLeaseWaitersAreCounted(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysARenewalKeepsTheAccount(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysDutiesNameRetiredKeys(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysSessionBelongsToTheActiveKey(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> alwaysRefreshWaitersAreCounted(elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepGenerationCountsOwnerActions(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepEachNewKeyIsAnnouncedOnce(s, "elapse", elapse(s, ms), []))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepAReplacedKeyNamesItsSuccessor(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepOneLeaseRefreshInFlight(s, "elapse", elapse(s, ms), []))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepARenewalStartsOnlyFromTheLease(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepARenewalKeepsTheActiveKey(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepAKeyLeavesOnlyWithItsDuty(s, "elapse", elapse(s, ms), []))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepALeaseLeavesOnlyWithItsDuty(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepAnEndedKeyNamesNoSuccessor(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepRestartKeepsCustody(s, "elapse", elapse(s, ms)))
  ensures (inv(s) ==> canElapse(s, ms) ==> stepOneRefreshInFlight(s, "elapse", elapse(s, ms), []))
{
  if inv(s) && canElapse(s, ms) {
    var after := elapse(s, ms);
    assert after.duties == ProofLib.Filter((d: Duty) => (d.lapsesAt > (s.now + ms)), s.duties);
    FilteredCredentialDutiesStayRetired(s, after, (d: Duty) => (d.lapsesAt > (s.now + ms)));
  }
}

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

lemma beginSignIn_ensures(s: DeviceCredential)
  ensures (inv(s) ==> alwaysCountersAreNatural(beginSignIn(s)))
  ensures (inv(s) ==> alwaysSignInIsTheNewestAction(beginSignIn(s)))
  ensures (inv(s) ==> alwaysKeysAreMintedInOrder(beginSignIn(s)))
  ensures (inv(s) ==> alwaysLeaseBelongsToTheActiveKey(beginSignIn(s)))
  ensures (inv(s) ==> alwaysLeaseWaitersAreCounted(beginSignIn(s)))
  ensures (inv(s) ==> alwaysARenewalKeepsTheAccount(beginSignIn(s)))
  ensures (inv(s) ==> alwaysDutiesNameRetiredKeys(beginSignIn(s)))
  ensures (inv(s) ==> alwaysSessionBelongsToTheActiveKey(beginSignIn(s)))
  ensures (inv(s) ==> alwaysRefreshWaitersAreCounted(beginSignIn(s)))
  ensures (inv(s) ==> stepGenerationCountsOwnerActions(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepEachNewKeyIsAnnouncedOnce(s, "beginSignIn", beginSignIn(s), []))
  ensures (inv(s) ==> stepAReplacedKeyNamesItsSuccessor(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepOneLeaseRefreshInFlight(s, "beginSignIn", beginSignIn(s), []))
  ensures (inv(s) ==> stepARenewalStartsOnlyFromTheLease(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepARenewalKeepsTheActiveKey(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepAKeyLeavesOnlyWithItsDuty(s, "beginSignIn", beginSignIn(s), []))
  ensures (inv(s) ==> stepALeaseLeavesOnlyWithItsDuty(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepAnEndedKeyNamesNoSuccessor(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepRestartKeepsCustody(s, "beginSignIn", beginSignIn(s)))
  ensures (inv(s) ==> stepOneRefreshInFlight(s, "beginSignIn", beginSignIn(s), []))
{
  if inv(s) {
    UnlinkedDutyPreservesSuccessorCount(s.duties, pendingDuty(s.attempt, signOutAttempts));
  }
}

lemma acknowledged_ensures(s: DeviceCredential, attempt: int, credentialId: string, keyExpiresAt: int)
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysCountersAreNatural(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysSignInIsTheNewestAction(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysKeysAreMintedInOrder(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysLeaseBelongsToTheActiveKey(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysLeaseWaitersAreCounted(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysARenewalKeepsTheAccount(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysDutiesNameRetiredKeys(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysSessionBelongsToTheActiveKey(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> alwaysRefreshWaitersAreCounted(acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepGenerationCountsOwnerActions(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepEachNewKeyIsAnnouncedOnce(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state, acknowledged(s, attempt, credentialId, keyExpiresAt).out))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepAReplacedKeyNamesItsSuccessor(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepOneLeaseRefreshInFlight(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state, acknowledged(s, attempt, credentialId, keyExpiresAt).out))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepARenewalStartsOnlyFromTheLease(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepARenewalKeepsTheActiveKey(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepAKeyLeavesOnlyWithItsDuty(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state, acknowledged(s, attempt, credentialId, keyExpiresAt).out))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepALeaseLeavesOnlyWithItsDuty(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepAnEndedKeyNamesNoSuccessor(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepRestartKeepsCustody(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state))
  ensures (inv(s) ==> canAcknowledged(s, attempt, credentialId, keyExpiresAt) ==> stepOneRefreshInFlight(s, "acknowledged", acknowledged(s, attempt, credentialId, keyExpiresAt).state, acknowledged(s, attempt, credentialId, keyExpiresAt).out))
{
  if inv(s) && canAcknowledged(s, attempt, credentialId, keyExpiresAt) && s.custody.Active? {
    var pending := s.attempt;
    var active := s.custody;
    assert pending.Acknowledging?;
    assert pending.credentialId != "";
    var after := acknowledged(s, attempt, credentialId, keyExpiresAt).state;
    var keptLease := if pending.lease.Renewal? then NoLease else s.lease;
    var added := keyDuty(active, keptLease, signOutAttempts, pending.credentialId);
    assert |added| == 1;
    var retired := added[0];
    assert retired.version == active.version && retired.successor == pending.credentialId;
    assert after.duties == s.duties + [retired];
    assert retired in after.duties;
    assert credentialIdOf(after) == pending.credentialId;
  }
}

lemma signInEnded_ensures(s: DeviceCredential, attempt: int)
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysCountersAreNatural(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysSignInIsTheNewestAction(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysKeysAreMintedInOrder(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysLeaseBelongsToTheActiveKey(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysLeaseWaitersAreCounted(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysARenewalKeepsTheAccount(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysDutiesNameRetiredKeys(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysSessionBelongsToTheActiveKey(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> alwaysRefreshWaitersAreCounted(signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepGenerationCountsOwnerActions(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepEachNewKeyIsAnnouncedOnce(s, "signInEnded", signInEnded(s, attempt), []))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepAReplacedKeyNamesItsSuccessor(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepOneLeaseRefreshInFlight(s, "signInEnded", signInEnded(s, attempt), []))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepARenewalStartsOnlyFromTheLease(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepARenewalKeepsTheActiveKey(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepAKeyLeavesOnlyWithItsDuty(s, "signInEnded", signInEnded(s, attempt), []))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepALeaseLeavesOnlyWithItsDuty(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepAnEndedKeyNamesNoSuccessor(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepRestartKeepsCustody(s, "signInEnded", signInEnded(s, attempt)))
  ensures (inv(s) ==> canSignInEnded(s, attempt) ==> stepOneRefreshInFlight(s, "signInEnded", signInEnded(s, attempt), []))
{
  if inv(s) && canSignInEnded(s, attempt) {
    UnlinkedDutyPreservesSuccessorCount(s.duties, pendingDuty(s.attempt, signOutAttempts));
  }
}

lemma signOut_ensures(s: DeviceCredential)
  ensures (inv(s) ==> alwaysCountersAreNatural(signOut(s).state))
  ensures (inv(s) ==> alwaysSignInIsTheNewestAction(signOut(s).state))
  ensures (inv(s) ==> alwaysKeysAreMintedInOrder(signOut(s).state))
  ensures (inv(s) ==> alwaysLeaseBelongsToTheActiveKey(signOut(s).state))
  ensures (inv(s) ==> alwaysLeaseWaitersAreCounted(signOut(s).state))
  ensures (inv(s) ==> alwaysARenewalKeepsTheAccount(signOut(s).state))
  ensures (inv(s) ==> alwaysDutiesNameRetiredKeys(signOut(s).state))
  ensures (inv(s) ==> alwaysSessionBelongsToTheActiveKey(signOut(s).state))
  ensures (inv(s) ==> alwaysRefreshWaitersAreCounted(signOut(s).state))
  ensures (inv(s) ==> stepGenerationCountsOwnerActions(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepEachNewKeyIsAnnouncedOnce(s, "signOut", signOut(s).state, signOut(s).out))
  ensures (inv(s) ==> stepAReplacedKeyNamesItsSuccessor(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepOneLeaseRefreshInFlight(s, "signOut", signOut(s).state, signOut(s).out))
  ensures (inv(s) ==> stepARenewalStartsOnlyFromTheLease(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepARenewalKeepsTheActiveKey(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepAKeyLeavesOnlyWithItsDuty(s, "signOut", signOut(s).state, signOut(s).out))
  ensures (inv(s) ==> stepALeaseLeavesOnlyWithItsDuty(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepAnEndedKeyNamesNoSuccessor(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepRestartKeepsCustody(s, "signOut", signOut(s).state))
  ensures (inv(s) ==> stepOneRefreshInFlight(s, "signOut", signOut(s).state, signOut(s).out))
{
  EndedByPreservesSuccessorCount(s, signOutAttempts, "signOut");
}

lemma reset_ensures(s: DeviceCredential)
  ensures (inv(s) ==> alwaysCountersAreNatural(reset(s).state))
  ensures (inv(s) ==> alwaysSignInIsTheNewestAction(reset(s).state))
  ensures (inv(s) ==> alwaysKeysAreMintedInOrder(reset(s).state))
  ensures (inv(s) ==> alwaysLeaseBelongsToTheActiveKey(reset(s).state))
  ensures (inv(s) ==> alwaysLeaseWaitersAreCounted(reset(s).state))
  ensures (inv(s) ==> alwaysARenewalKeepsTheAccount(reset(s).state))
  ensures (inv(s) ==> alwaysDutiesNameRetiredKeys(reset(s).state))
  ensures (inv(s) ==> alwaysSessionBelongsToTheActiveKey(reset(s).state))
  ensures (inv(s) ==> alwaysRefreshWaitersAreCounted(reset(s).state))
  ensures (inv(s) ==> stepGenerationCountsOwnerActions(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepEachNewKeyIsAnnouncedOnce(s, "reset", reset(s).state, reset(s).out))
  ensures (inv(s) ==> stepAReplacedKeyNamesItsSuccessor(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepOneLeaseRefreshInFlight(s, "reset", reset(s).state, reset(s).out))
  ensures (inv(s) ==> stepARenewalStartsOnlyFromTheLease(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepARenewalKeepsTheActiveKey(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepAKeyLeavesOnlyWithItsDuty(s, "reset", reset(s).state, reset(s).out))
  ensures (inv(s) ==> stepALeaseLeavesOnlyWithItsDuty(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepAnEndedKeyNamesNoSuccessor(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepRestartKeepsCustody(s, "reset", reset(s).state))
  ensures (inv(s) ==> stepOneRefreshInFlight(s, "reset", reset(s).state, reset(s).out))
{
  EndedByPreservesSuccessorCount(s, resetAttempts, "reset");
}

lemma UnlinkedDutyPreservesSuccessorCount(held: seq<Duty>, added: seq<Duty>)
  requires |added| <= 1
  requires |added| == 1 ==> added[0].successor == ""
  ensures |ProofLib.Filter((d: Duty) => (d.successor != ""), held + added)| ==
    |ProofLib.Filter((d: Duty) => (d.successor != ""), held)|
{
  if |added| == 1 {
    assert added == [added[0]];
    ProofLib.FilterAppend((d: Duty) => (d.successor != ""), held, added[0]);
  } else {
    assert added == [];
    assert held + added == held;
  }
}

lemma EndedByPreservesSuccessorCount(s: DeviceCredential, tries: int, action: string)
  ensures stepAnEndedKeyNamesNoSuccessor(s, action, endedBy(tries, s).state)
{
  var active := keyDuty(s.custody, s.lease, tries, "");
  var pending := pendingDuty(s.attempt, tries);
  UnlinkedDutyPreservesSuccessorCount(s.duties, active);
  UnlinkedDutyPreservesSuccessorCount(s.duties + active, pending);
}
