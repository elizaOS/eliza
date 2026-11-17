lemma RestartFilter(k: KeyCache)
  ensures restart(k).retiredIds == (if (k.ephemeralId > 0) then (k.retiredIds + ProofLib.Filter((set_x: int) => !((set_x in k.retiredIds)), [k.ephemeralId])) else k.retiredIds)
{
}

lemma restart_ensures(k: KeyCache)
  ensures (inv(k) ==> canRestart(k) ==> alwaysKeyIdentity(restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> alwaysProductionKeyIsPrivate(restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> alwaysEarlierProcessKeyNeverReads(restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> alwaysLiveKeysAreNeverRetired(restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> alwaysPrivateConfigurationHasKey(restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> stepEphemeralKeyStableWithinProcess(k, "restart", restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> stepRestartKeepsConfiguredKey(k, "restart", restart(k)))
  ensures (inv(k) ==> canRestart(k) ==> stepWarningsOnlyIncreaseOnDevelopmentFallback(k, "restart", restart(k)))
{
  RestartFilter(k);
  forall id
    ensures id in restart(k).retiredIds <==> id in k.retiredIds || (k.ephemeralId > 0 && id == k.ephemeralId)
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in k.retiredIds)), [k.ephemeralId], id);
  }
}
