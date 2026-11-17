lemma runNow_ensures(t: Trigger, key: string)
  ensures (inv(t) ==> canRunNow(t, key) ==> alwaysRunningTriggerIsNotArchived(runNow(t, key)))
  ensures (inv(t) ==> canRunNow(t, key) ==> alwaysArchivedTriggerIsDisabled(runNow(t, key)))
  ensures (inv(t) ==> canRunNow(t, key) ==> alwaysCheckHoldsTheTriggerForTheOwner(runNow(t, key)))
  ensures (inv(t) ==> canRunNow(t, key) ==> alwaysWriteHasOwnerAndCurrentRevision(runNow(t, key)))
  ensures (inv(t) ==> canRunNow(t, key) ==> stepRunNowKeyIsUsedOnce(t, "runNow", runNow(t, key)))
  ensures (inv(t) ==> canRunNow(t, key) ==> stepStaleRunWriteKeepsTheSavedRevision(t, "runNow", runNow(t, key)))
  ensures (inv(t) ==> canRunNow(t, key) ==> stepOnlyAnUnarchivedTriggerIsEnabled(t, "runNow", runNow(t, key)))
{
  ProofLib.FilterCons((set_x: string) => !((set_x in t.runKeys)), [key]);
  ProofLib.FilterNil((set_x: string) => !((set_x in t.runKeys)), [key][1..]);
}
