lemma requestBootstrap_ensures(r: Roles)
  ensures (inv(r) ==> canRequestBootstrap(r) ==> alwaysRetriesBounded(requestBootstrap(r)))
  ensures (inv(r) ==> canRequestBootstrap(r) ==> alwaysSyncedRolesAreExact(requestBootstrap(r)))
  ensures (inv(r) ==> canRequestBootstrap(r) ==> stepPendingBootstrapCoalesces(r, requestBootstrap(r)))
  ensures (inv(r) ==> canRequestBootstrap(r) ==> stepAllowlistChangeUnsyncs(r, requestBootstrap(r)))
  ensures (inv(r) ==> canRequestBootstrap(r) ==> stepAllowlistChangesOneAccount(r, requestBootstrap(r)))
{
  if inv(r) && canRequestBootstrap(r) {
    AllowlistChanges(r, requestBootstrap(r));
  }
}

lemma setAllowlist_ensures(r: Roles, account: int, allowed: bool)
  ensures (inv(r) ==> canSetAllowlist(r, account, allowed) ==> alwaysRetriesBounded(setAllowlist(r, account, allowed)))
  ensures (inv(r) ==> canSetAllowlist(r, account, allowed) ==> alwaysSyncedRolesAreExact(setAllowlist(r, account, allowed)))
  ensures (inv(r) ==> canSetAllowlist(r, account, allowed) ==> stepPendingBootstrapCoalesces(r, setAllowlist(r, account, allowed)))
  ensures (inv(r) ==> canSetAllowlist(r, account, allowed) ==> stepAllowlistChangeUnsyncs(r, setAllowlist(r, account, allowed)))
  ensures (inv(r) ==> canSetAllowlist(r, account, allowed) ==> stepAllowlistChangesOneAccount(r, setAllowlist(r, account, allowed)))
{
  if inv(r) && canSetAllowlist(r, account, allowed) {
    ProofLib.FilterMember((set_x: int) => !((set_x in r.allowlisted)), [account], 1);
    ProofLib.FilterMember((set_x: int) => !((set_x in r.allowlisted)), [account], 2);
    ProofLib.FilterMember((set_x: int) => !((set_x in [account])), r.allowlisted, 1);
    ProofLib.FilterMember((set_x: int) => !((set_x in [account])), r.allowlisted, 2);
    AllowlistChanges(r, setAllowlist(r, account, allowed));
  }
}

lemma storageUnavailable_ensures(r: Roles)
  ensures (inv(r) ==> canStorageUnavailable(r) ==> alwaysRetriesBounded(storageUnavailable(r)))
  ensures (inv(r) ==> canStorageUnavailable(r) ==> alwaysSyncedRolesAreExact(storageUnavailable(r)))
  ensures (inv(r) ==> canStorageUnavailable(r) ==> stepPendingBootstrapCoalesces(r, storageUnavailable(r)))
  ensures (inv(r) ==> canStorageUnavailable(r) ==> stepAllowlistChangeUnsyncs(r, storageUnavailable(r)))
  ensures (inv(r) ==> canStorageUnavailable(r) ==> stepAllowlistChangesOneAccount(r, storageUnavailable(r)))
{
  if inv(r) && canStorageUnavailable(r) {
    AllowlistChanges(r, storageUnavailable(r));
  }
}

lemma giveUp_ensures(r: Roles)
  ensures (inv(r) ==> canGiveUp(r) ==> alwaysRetriesBounded(giveUp(r)))
  ensures (inv(r) ==> canGiveUp(r) ==> alwaysSyncedRolesAreExact(giveUp(r)))
  ensures (inv(r) ==> canGiveUp(r) ==> stepPendingBootstrapCoalesces(r, giveUp(r)))
  ensures (inv(r) ==> canGiveUp(r) ==> stepAllowlistChangeUnsyncs(r, giveUp(r)))
  ensures (inv(r) ==> canGiveUp(r) ==> stepAllowlistChangesOneAccount(r, giveUp(r)))
{
  if inv(r) && canGiveUp(r) {
    AllowlistChanges(r, giveUp(r));
  }
}

lemma synchronize_ensures(r: Roles)
  ensures (inv(r) ==> canSynchronize(r) ==> alwaysRetriesBounded(synchronize(r)))
  ensures (inv(r) ==> canSynchronize(r) ==> alwaysSyncedRolesAreExact(synchronize(r)))
  ensures (inv(r) ==> canSynchronize(r) ==> stepPendingBootstrapCoalesces(r, synchronize(r)))
  ensures (inv(r) ==> canSynchronize(r) ==> stepAllowlistChangeUnsyncs(r, synchronize(r)))
  ensures (inv(r) ==> canSynchronize(r) ==> stepAllowlistChangesOneAccount(r, synchronize(r)))
{
  if inv(r) && canSynchronize(r) {
    AllowlistChanges(r, synchronize(r));
  }
}

lemma AllowlistChanges(before: Roles, after: Roles)
  ensures stepAllowlistChangesOneAccount(before, after) == !(((1 in before.allowlisted) != (1 in after.allowlisted)) && ((2 in before.allowlisted) != (2 in after.allowlisted)))
{
  ProofLib.FilterCons((a: int) => ((a in before.allowlisted) != (a in after.allowlisted)), accounts);
  ProofLib.FilterCons((a: int) => ((a in before.allowlisted) != (a in after.allowlisted)), accounts[1..]);
  ProofLib.FilterNil((a: int) => ((a in before.allowlisted) != (a in after.allowlisted)), accounts[1..][1..]);
}
