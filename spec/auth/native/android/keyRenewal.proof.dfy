lemma check_ensures(k: KeyRenewal, due: bool, supported: bool)
  ensures (inv(k) ==> canCheck(k) ==> alwaysOnePredecessorDispatch(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysSentRequestNeverClaimedAgain(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysNeverRenewsAfterConfirmedSuccessor(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysAckRequiresDurableCustody(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysActiveSuccessorRecoverable(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysCodeWaitHoldsTheRequest(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysConfirmedReceiptIsActive(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysPublicationRequiresConfirmedReceipt(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysPartialPublicationRecoverable(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysOldKeyRevokedOnlyAfterInstall(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysAnnouncedOnlyWhenRenewed(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysWorkingKeyKept(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysSavedKeyAcceptedOrReportedRefused(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysSavedKeyFollowsRenewal(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysNewerActionWins(check(k, due, supported)))
  ensures (inv(k) ==> canCheck(k) ==> alwaysNewerJournalPreserved(check(k, due, supported)))
{
  if inv(k) && canCheck(k) {
    var after := check(k, due, supported);
    assert after == k.(phase := after.phase, verdict := after.verdict, worker := after.worker);
  }
}
