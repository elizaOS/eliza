lemma beginSelection_ensures(s: AccountPool, slot: int, request: SelectionRequest)
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> alwaysPickWasEligibleAtCompletion(beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> alwaysAccountKeysDistinct(beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> alwaysOneSelectionPerSlot(beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> alwaysCursorsNeverNegative(beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> alwaysAffinityStaysInProvider(beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> alwaysCredentialFromPoolRoot(beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> stepPriorityPickRanksFirst(s, "beginSelection", beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> stepStampsOnlyFreshPicks(s, "beginSelection", beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> stepLeastUsedPickRanksFirst(s, "beginSelection", beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> stepAffinityReuseKeepsCursor(s, "beginSelection", beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> stepNoPickOnlyWhenNoneEligible(s, "beginSelection", beginSelection(s, slot, request)))
  ensures (inv(s) ==> canBeginSelection(s, slot, request) ==> stepEligibleAccountIsPicked(s, "beginSelection", beginSelection(s, slot, request)))
{
  if inv(s) && canBeginSelection(s, slot, request) {
    BeginRules(s, slot, request);
  }
}

lemma setHealth_ensures(s: AccountPool, key: int, health: PoolHealth)
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> alwaysPickWasEligibleAtCompletion(setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> alwaysAccountKeysDistinct(setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> alwaysOneSelectionPerSlot(setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> alwaysCursorsNeverNegative(setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> alwaysAffinityStaysInProvider(setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> alwaysCredentialFromPoolRoot(setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> stepPriorityPickRanksFirst(s, "setHealth", setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> stepStampsOnlyFreshPicks(s, "setHealth", setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> stepLeastUsedPickRanksFirst(s, "setHealth", setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> stepAffinityReuseKeepsCursor(s, "setHealth", setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> stepNoPickOnlyWhenNoneEligible(s, "setHealth", setHealth(s, key, health)))
  ensures (inv(s) ==> canSetHealth(s, key, health) ==> stepEligibleAccountIsPicked(s, "setHealth", setHealth(s, key, health)))
{
  if inv(s) && canSetHealth(s, key, health) {
    AccountsShape(s, setHealth(s, key, health));
  }
}

lemma setEnabled_ensures(s: AccountPool, key: int, on: bool)
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> alwaysPickWasEligibleAtCompletion(setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> alwaysAccountKeysDistinct(setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> alwaysOneSelectionPerSlot(setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> alwaysCursorsNeverNegative(setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> alwaysAffinityStaysInProvider(setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> alwaysCredentialFromPoolRoot(setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> stepPriorityPickRanksFirst(s, "setEnabled", setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> stepStampsOnlyFreshPicks(s, "setEnabled", setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> stepLeastUsedPickRanksFirst(s, "setEnabled", setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> stepAffinityReuseKeepsCursor(s, "setEnabled", setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> stepNoPickOnlyWhenNoneEligible(s, "setEnabled", setEnabled(s, key, on)))
  ensures (inv(s) ==> canSetEnabled(s, key, on) ==> stepEligibleAccountIsPicked(s, "setEnabled", setEnabled(s, key, on)))
{
  if inv(s) && canSetEnabled(s, key, on) {
    AccountsShape(s, setEnabled(s, key, on));
  }
}

lemma recordUse_ensures(s: AccountPool, key: int)
  ensures (inv(s) ==> canRecordUse(s, key) ==> alwaysPickWasEligibleAtCompletion(recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> alwaysAccountKeysDistinct(recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> alwaysOneSelectionPerSlot(recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> alwaysCursorsNeverNegative(recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> alwaysAffinityStaysInProvider(recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> alwaysCredentialFromPoolRoot(recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> stepPriorityPickRanksFirst(s, "recordUse", recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> stepStampsOnlyFreshPicks(s, "recordUse", recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> stepLeastUsedPickRanksFirst(s, "recordUse", recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> stepAffinityReuseKeepsCursor(s, "recordUse", recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> stepNoPickOnlyWhenNoneEligible(s, "recordUse", recordUse(s, key)))
  ensures (inv(s) ==> canRecordUse(s, key) ==> stepEligibleAccountIsPicked(s, "recordUse", recordUse(s, key)))
{
  if inv(s) && canRecordUse(s, key) {
    AccountsShape(s, recordUse(s, key));
  }
}

lemma restart_ensures(s: AccountPool)
  ensures (inv(s) ==> canRestart(s) ==> alwaysPickWasEligibleAtCompletion(restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> alwaysAccountKeysDistinct(restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> alwaysOneSelectionPerSlot(restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> alwaysCursorsNeverNegative(restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> alwaysAffinityStaysInProvider(restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> alwaysCredentialFromPoolRoot(restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> stepPriorityPickRanksFirst(s, "restart", restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> stepStampsOnlyFreshPicks(s, "restart", restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> stepLeastUsedPickRanksFirst(s, "restart", restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> stepAffinityReuseKeepsCursor(s, "restart", restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> stepNoPickOnlyWhenNoneEligible(s, "restart", restart(s)))
  ensures (inv(s) ==> canRestart(s) ==> stepEligibleAccountIsPicked(s, "restart", restart(s)))
{
  if inv(s) && canRestart(s) {
    AccountsShape(s, restart(s));
    forall x | x in s.selections ensures !(x.reused && selectionOf(s, x.slot).phase.Waiting?) {
      SelectionOfIn(s, x.slot);
    }
  }
}

lemma finishSelection_ensures(s: AccountPool, slot: int)
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> alwaysPickWasEligibleAtCompletion(finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> alwaysAccountKeysDistinct(finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> alwaysOneSelectionPerSlot(finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> alwaysCursorsNeverNegative(finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> alwaysAffinityStaysInProvider(finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> alwaysCredentialFromPoolRoot(finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> stepPriorityPickRanksFirst(s, "finishSelection", finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> stepStampsOnlyFreshPicks(s, "finishSelection", finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> stepLeastUsedPickRanksFirst(s, "finishSelection", finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> stepAffinityReuseKeepsCursor(s, "finishSelection", finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> stepNoPickOnlyWhenNoneEligible(s, "finishSelection", finishSelection(s, slot)))
  ensures (inv(s) ==> canFinishSelection(s, slot) ==> stepEligibleAccountIsPicked(s, "finishSelection", finishSelection(s, slot)))
{
  if inv(s) && canFinishSelection(s, slot) {
    FinishSelectionRules(s, slot);
    FinishStepRules(s, slot);
    FinishPoolRules(s, slot);
  }
}

lemma resolveCredential_ensures(s: AccountPool, slot: int)
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> alwaysPickWasEligibleAtCompletion(resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> alwaysAccountKeysDistinct(resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> alwaysOneSelectionPerSlot(resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> alwaysCursorsNeverNegative(resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> alwaysAffinityStaysInProvider(resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> alwaysCredentialFromPoolRoot(resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> stepPriorityPickRanksFirst(s, "resolveCredential", resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> stepStampsOnlyFreshPicks(s, "resolveCredential", resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> stepLeastUsedPickRanksFirst(s, "resolveCredential", resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> stepAffinityReuseKeepsCursor(s, "resolveCredential", resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> stepNoPickOnlyWhenNoneEligible(s, "resolveCredential", resolveCredential(s, slot)))
  ensures (inv(s) ==> canResolveCredential(s, slot) ==> stepEligibleAccountIsPicked(s, "resolveCredential", resolveCredential(s, slot)))
{
  if inv(s) && canResolveCredential(s, slot) {
    ResolveRules(s, slot);
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  Keys(initial);
  Slots(initial);
}

lemma Keys(s: AccountPool)
  ensures alwaysAccountKeysDistinct(s) <==> ProofLib.DistinctBy(s.accounts, (a: PoolAccount) => a.key) && forall a :: a in s.accounts ==> a.key > 0
{
  AlwaysAccountKeysDistinctFilter(s);
  forall i | 0 <= i < |s.accounts|
    ensures |ProofLib.Filter((b: PoolAccount) => (b.key == s.accounts[i].key), s.accounts)| == 1 <==> forall j :: 0 <= j < |s.accounts| && j != i ==> s.accounts[j].key != s.accounts[i].key
  {
    ProofLib.FilterCountOneIffUnique((b: PoolAccount) => (b.key == s.accounts[i].key), s.accounts, (a: PoolAccount) => a.key, i);
  }
  if ProofLib.DistinctBy(s.accounts, (a: PoolAccount) => a.key) {
    forall a | a in s.accounts ensures |ProofLib.Filter((b: PoolAccount) => (b.key == a.key), s.accounts)| == 1 {
      var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
    }
  } else {
    var i, j :| 0 <= i < |s.accounts| && 0 <= j < |s.accounts| && i != j && s.accounts[i].key == s.accounts[j].key;
    assert s.accounts[i] in s.accounts;
  }
}

lemma Slots(s: AccountPool)
  ensures alwaysOneSelectionPerSlot(s) <==> ProofLib.DistinctBy(s.selections, (x: Selection) => x.slot) && forall x :: x in s.selections ==> (x.phase.Waiting? ==> !x.reused)
{
  AlwaysOneSelectionPerSlotFilter(s);
  forall i | 0 <= i < |s.selections|
    ensures |ProofLib.Filter((o: Selection) => (o.slot == s.selections[i].slot), s.selections)| == 1 <==> forall j :: 0 <= j < |s.selections| && j != i ==> s.selections[j].slot != s.selections[i].slot
  {
    ProofLib.FilterCountOneIffUnique((o: Selection) => (o.slot == s.selections[i].slot), s.selections, (x: Selection) => x.slot, i);
  }
  if ProofLib.DistinctBy(s.selections, (x: Selection) => x.slot) {
    forall x | x in s.selections ensures |ProofLib.Filter((o: Selection) => (o.slot == x.slot), s.selections)| == 1 {
      var i :| 0 <= i < |s.selections| && s.selections[i] == x;
    }
  } else {
    var i, j :| 0 <= i < |s.selections| && 0 <= j < |s.selections| && i != j && s.selections[i].slot == s.selections[j].slot;
    assert s.selections[i] in s.selections;
  }
}

lemma AccountsShape(s: AccountPool, t: AccountPool)
  requires |t.accounts| == |s.accounts|
  requires forall i :: 0 <= i < |s.accounts| ==> t.accounts[i].key == s.accounts[i].key && t.accounts[i].provider == s.accounts[i].provider
  ensures alwaysAccountKeysDistinct(t) == alwaysAccountKeysDistinct(s)
  ensures forall k :: accountOf(t, k).provider == accountOf(s, k).provider
  ensures t.affinity == s.affinity ==> alwaysAffinityStaysInProvider(t) == alwaysAffinityStaysInProvider(s)
{
  Keys(s);
  Keys(t);
  forall a | a in t.accounts ensures exists b :: b in s.accounts && b.key == a.key {
    var i :| 0 <= i < |t.accounts| && t.accounts[i] == a;
    assert s.accounts[i] in s.accounts;
  }
  forall a | a in s.accounts ensures exists b :: b in t.accounts && b.key == a.key {
    var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
    assert t.accounts[i] in t.accounts;
  }
  forall k ensures accountOf(t, k).provider == accountOf(s, k).provider {
    AccountOfFilter(s, k);
    AccountOfFilter(t, k);
    ProofLib.FilterPointwise((a: PoolAccount) => (a.key == k), (a: PoolAccount) => (a.key == k), (x: PoolAccount, y: PoolAccount) => x.provider == y.provider, t.accounts, s.accounts);
  }
  AlwaysAffinityStaysInProviderFilter(s);
  AlwaysAffinityStaysInProviderFilter(t);
}

lemma AccountOfKey(s: AccountPool, acct: PoolAccount)
  requires ProofLib.DistinctBy(s.accounts, (a: PoolAccount) => a.key) && acct in s.accounts
  ensures accountOf(s, acct.key) == acct
{
  AccountOfFilter(s, acct.key);
  var i :| 0 <= i < |s.accounts| && s.accounts[i] == acct;
  ProofLib.FilterOne((a: PoolAccount) => (a.key == acct.key), s.accounts, i);
  ProofLib.FilterMember((a: PoolAccount) => (a.key == acct.key), s.accounts, acct);
}

lemma SelectionOfIn(s: AccountPool, slot: int)
  ensures (selectionOf(s, slot) in s.selections && selectionOf(s, slot).slot == slot) || (selectionOf(s, slot).phase.NonePicked? && !selectionOf(s, slot).reused)
{
  SelectionOfFilter(s, slot);
  if 0 < |ProofLib.Filter((x: Selection) => (x.slot == slot), s.selections)| {
    var fs := ProofLib.Filter((x: Selection) => (x.slot == slot), s.selections);
    assert fs[0] in fs;
    ProofLib.FilterMember((x: Selection) => (x.slot == slot), s.selections, fs[0]);
  }
}

lemma SelectionOfSlot(s: AccountPool, sel: Selection)
  requires ProofLib.DistinctBy(s.selections, (x: Selection) => x.slot) && sel in s.selections
  ensures selectionOf(s, sel.slot) == sel
{
  SelectionOfFilter(s, sel.slot);
  var i :| 0 <= i < |s.selections| && s.selections[i] == sel;
  ProofLib.FilterOne((x: Selection) => (x.slot == sel.slot), s.selections, i);
  ProofLib.FilterMember((x: Selection) => (x.slot == sel.slot), s.selections, sel);
}

lemma BeginRules(s: AccountPool, slot: int, request: SelectionRequest)
  requires inv(s)
  ensures alwaysPickWasEligibleAtCompletion(beginSelection(s, slot, request))
  ensures alwaysOneSelectionPerSlot(beginSelection(s, slot, request))
  ensures alwaysCredentialFromPoolRoot(beginSelection(s, slot, request))
{
  var after := beginSelection(s, slot, request);
  var kept := ProofLib.Filter((o: Selection) => (o.slot != slot), s.selections);
  var nx := after.selections[|after.selections| - 1];
  assert after.selections == kept + [nx];
  forall x | x in kept ensures x in s.selections && x.slot != slot {
    ProofLib.FilterMember((o: Selection) => (o.slot != slot), s.selections, x);
  }
  Slots(s);
  Slots(after);
  ProofLib.FilterKeepsDistinctBy((o: Selection) => (o.slot != slot), s.selections, (x: Selection) => x.slot);
  ProofLib.DistinctByConcat(kept, [nx], (x: Selection) => x.slot);
}

lemma ResolveRules(s: AccountPool, slot: int)
  requires inv(s) && canResolveCredential(s, slot)
  ensures alwaysOneSelectionPerSlot(resolveCredential(s, slot))
  ensures alwaysCredentialFromPoolRoot(resolveCredential(s, slot))
{
  var after := resolveCredential(s, slot);
  SelectionOfIn(s, slot);
  Slots(s);
  Slots(after);
  forall x | x in after.selections ensures x.credentialRoot == 0 || (x.phase.Picked? && x.credentialRoot == after.poolRoot) {
    var i :| 0 <= i < |after.selections| && after.selections[i] == x;
    assert s.selections[i] in s.selections;
    if s.selections[i].slot == slot {
      SelectionOfSlot(s, s.selections[i]);
    }
  }
  forall x | x in after.selections ensures x.phase.Waiting? ==> !x.reused {
    var i :| 0 <= i < |after.selections| && after.selections[i] == x;
    assert s.selections[i] in s.selections;
  }
}

lemma PriorityFold(xs: seq<PoolAccount>)
  requires forall a :: a in xs ==> a.key > 0
  ensures |xs| == 0 ==> byPriority(xs) == noAccount
  ensures |xs| > 0 ==> byPriority(xs) in xs && forall o :: o in xs ==> priorityFirst(byPriority(xs), o)
  decreases |xs|
{
  if |xs| > 0 {
    var ys := xs[..|xs| - 1];
    assert xs == ys + [xs[|xs| - 1]];
    ProofLib.FoldLeftAppend((best: PoolAccount, a: PoolAccount) => (if ((best.key == 0) || !(priorityFirst(best, a))) then a else best), noAccount, ys, xs[|xs| - 1]);
    PriorityFold(ys);
  }
}

lemma LeastFold(xs: seq<PoolAccount>)
  requires forall a :: a in xs ==> a.key > 0
  ensures |xs| == 0 ==> byLeastUse(xs) == noAccount
  ensures |xs| > 0 ==> byLeastUse(xs) in xs && forall o :: o in xs ==> leastUsedFirst(byLeastUse(xs), o)
  decreases |xs|
{
  if |xs| > 0 {
    var ys := xs[..|xs| - 1];
    assert xs == ys + [xs[|xs| - 1]];
    ProofLib.FoldLeftAppend((best: PoolAccount, a: PoolAccount) => (if ((best.key == 0) || leastUsedFirst(a, best)) then a else best), noAccount, ys, xs[|xs| - 1]);
    LeastFold(ys);
  }
}

lemma RemainderInRange(a: int, b: int)
  requires a >= 0 && b > 0
  ensures 0 <= remainder_auth__accountPool(a, b) < b
{
  assert quotient_auth__accountPool(a, b) == a / b;
}

lemma FinishShape(s: AccountPool, slot: int) returns (x0: Selection, cands: seq<PoolAccount>, pick: PoolAccount, reuse: bool, uses: int)
  requires inv(s) && canFinishSelection(s, slot)
  ensures x0 == selectionOf(s, slot) && x0 in s.selections && x0.slot == slot && x0.phase.Waiting? && !x0.reused && x0.credentialRoot == 0
  ensures cands == eligible(s, x0)
  ensures forall a :: a in cands ==> a in s.accounts && (a.key in x0.snapshot) && inScope(a, x0) && available(a, s.now)
  ensures (pick.key > 0) == (|cands| > 0)
  ensures pick.key > 0 ==> pick in cands
  ensures !reuse && x0.strategy.ByPriority? ==> forall o :: o in cands ==> priorityFirst(pick, o)
  ensures !reuse && x0.strategy.LeastUsed? ==> forall o :: o in cands ==> leastUsedFirst(pick, o)
  ensures 1 <= uses <= maxAffinityUses
  ensures |finishSelection(s, slot).selections| == |s.selections|
  ensures forall i :: 0 <= i < |s.selections| ==> finishSelection(s, slot).selections[i] == (if s.selections[i].slot == slot then s.selections[i].(phase := (if (pick.key > 0) then SelectionPhase.Picked else SelectionPhase.NonePicked), picked := pick, pickedAt := s.now, reused := reuse) else s.selections[i])
  ensures |finishSelection(s, slot).accounts| == |s.accounts|
  ensures forall i :: 0 <= i < |s.accounts| ==> finishSelection(s, slot).accounts[i].key == s.accounts[i].key && finishSelection(s, slot).accounts[i].provider == s.accounts[i].provider
  ensures finishSelection(s, slot).affinity == (if ((x0.session > 0) && (pick.key > 0)) then (ProofLib.Filter((f: Affinity) => !(((f.provider == x0.provider) && (f.session == x0.session))), s.affinity) + [Affinity(x0.provider, x0.session, pick.key, uses)]) else s.affinity)
  ensures (pick.key == 0 || reuse) ==> finishSelection(s, slot).cursors == s.cursors
  ensures forall c :: c in finishSelection(s, slot).cursors ==> c.index >= 0
{
  x0 := selectionOf(s, slot);
  cands := eligible(s, x0);
  var cached := affinityOf(s, x0.provider, x0.session);
  reuse := ((((x0.session > 0) && (cached.uses > 0)) && (cached.uses < maxAffinityUses)) && (exists a :: a in cands && (a.key == cached.account)));
  var idx := (if (|cands| > 0) then remainder_auth__accountPool((cursorOf(s, x0.provider) + 1), |cands|) else 0);
  pick := (if reuse then accountOf(s, cached.account) else (if x0.strategy.ByPriority? then byPriority(cands) else (if x0.strategy.LeastUsed? then byLeastUse(cands) else (if ((0 <= idx) && (idx < |cands|)) then cands[idx] else noAccount))));
  uses := (if reuse then (cached.uses + 1) else 1);
  SelectionOfIn(s, slot);
  Slots(s);
  Keys(s);
  EligibleFilter(s, x0);
  forall a | a in cands ensures a in s.accounts && (a.key in x0.snapshot) && inScope(a, x0) && available(a, s.now) {
    ProofLib.FilterMember((a: PoolAccount) => (((a.key in x0.snapshot) && inScope(a, x0)) && available(a, s.now)), s.accounts, a);
  }
  CursorOfFilter(s, x0.provider);
  if 0 < |ProofLib.Filter((c: Cursor) => (c.provider == x0.provider), s.cursors)| {
    var cs := ProofLib.Filter((c: Cursor) => (c.provider == x0.provider), s.cursors);
    assert cs[0] in cs;
    ProofLib.FilterMember((c: Cursor) => (c.provider == x0.provider), s.cursors, cs[0]);
  }
  if |cands| > 0 {
    RemainderInRange(cursorOf(s, x0.provider) + 1, |cands|);
  }
  if reuse {
    var a :| a in cands && a.key == cached.account;
    AccountOfKey(s, a);
  } else if x0.strategy.ByPriority? {
    PriorityFold(cands);
  } else if x0.strategy.LeastUsed? {
    LeastFold(cands);
  }
  var after := finishSelection(s, slot);
  forall c | c in after.cursors ensures c.index >= 0 {
    if !(c in s.cursors) && c != Cursor(x0.provider, idx) {
      ProofLib.FilterMember((c: Cursor) => (c.provider != x0.provider), s.cursors, c);
    }
  }
}

lemma FinishSelectionRules(s: AccountPool, slot: int)
  requires inv(s) && canFinishSelection(s, slot)
  ensures alwaysPickWasEligibleAtCompletion(finishSelection(s, slot))
  ensures alwaysOneSelectionPerSlot(finishSelection(s, slot))
  ensures alwaysCredentialFromPoolRoot(finishSelection(s, slot))
{
  var x0, cands, pick, reuse, uses := FinishShape(s, slot);
  var after := finishSelection(s, slot);
  Slots(s);
  Slots(after);
  forall x | x in after.selections
    ensures x.phase.Picked? ==> (x.picked.key in x.snapshot) && inScope(x.picked, x) && available(x.picked, x.pickedAt)
    ensures x.phase.Waiting? ==> !x.reused
    ensures x.credentialRoot == 0 || (x.phase.Picked? && x.credentialRoot == after.poolRoot)
  {
    var i :| 0 <= i < |after.selections| && after.selections[i] == x;
    assert s.selections[i] in s.selections;
    if s.selections[i].slot == slot {
      SelectionOfSlot(s, s.selections[i]);
    }
  }
}

lemma FinishStepRules(s: AccountPool, slot: int)
  requires inv(s) && canFinishSelection(s, slot)
  ensures stepPriorityPickRanksFirst(s, "finishSelection", finishSelection(s, slot))
  ensures stepLeastUsedPickRanksFirst(s, "finishSelection", finishSelection(s, slot))
  ensures stepAffinityReuseKeepsCursor(s, "finishSelection", finishSelection(s, slot))
  ensures stepNoPickOnlyWhenNoneEligible(s, "finishSelection", finishSelection(s, slot))
  ensures stepEligibleAccountIsPicked(s, "finishSelection", finishSelection(s, slot))
{
  var x0, cands, pick, reuse, uses := FinishShape(s, slot);
  var after := finishSelection(s, slot);
  Slots(s);
  forall x | x in after.selections
    ensures x.slot != slot ==> x == selectionOf(s, x.slot) && (x.phase.Waiting? ==> !x.reused)
    ensures x.slot == slot ==> selectionOf(s, x.slot) == x0
    ensures x.slot == slot ==> x == x0.(phase := (if (pick.key > 0) then SelectionPhase.Picked else SelectionPhase.NonePicked), picked := pick, pickedAt := s.now, reused := reuse)
  {
    var i :| 0 <= i < |after.selections| && after.selections[i] == x;
    assert s.selections[i] in s.selections;
    SelectionOfSlot(s, s.selections[i]);
  }
}

lemma FinishPoolRules(s: AccountPool, slot: int)
  requires inv(s) && canFinishSelection(s, slot)
  ensures alwaysAccountKeysDistinct(finishSelection(s, slot))
  ensures alwaysCursorsNeverNegative(finishSelection(s, slot))
  ensures alwaysAffinityStaysInProvider(finishSelection(s, slot))
{
  var x0, cands, pick, reuse, uses := FinishShape(s, slot);
  var after := finishSelection(s, slot);
  AccountsShape(s, after);
  if (x0.session > 0) && (pick.key > 0) {
    Keys(s);
    AccountOfKey(s, pick);
    AffinityAppend(s, after, x0.provider, x0.session, pick.key, uses);
  }
}

lemma AffinityAppend(s: AccountPool, after: AccountPool, provider: string, session: int, account: int, uses: int)
  requires alwaysAffinityStaysInProvider(s)
  requires 1 <= uses <= maxAffinityUses
  requires forall k :: accountOf(after, k).provider == accountOf(s, k).provider
  requires accountOf(s, account).provider == provider
  requires after.affinity == ProofLib.Filter((f: Affinity) => !(((f.provider == provider) && (f.session == session))), s.affinity) + [Affinity(provider, session, account, uses)]
  ensures alwaysAffinityStaysInProvider(after)
{
  var q := (f: Affinity) => !(((f.provider == provider) && (f.session == session)));
  var kept := ProofLib.Filter(q, s.affinity);
  var nf := Affinity(provider, session, account, uses);
  AlwaysAffinityStaysInProviderFilter(s);
  AlwaysAffinityStaysInProviderFilter(after);
  forall f | f in kept ensures f in s.affinity && q(f) {
    ProofLib.FilterMember(q, s.affinity, f);
  }
  forall f | f in after.affinity
    ensures |ProofLib.Filter((o: Affinity) => ((o.provider == f.provider) && (o.session == f.session)), after.affinity)| == 1
  {
    var p := (o: Affinity) => ((o.provider == f.provider) && (o.session == f.session));
    ProofLib.FilterAppend(p, kept, nf);
    if f == nf {
      forall i | 0 <= i < |kept| ensures !p(kept[i]) {
        assert kept[i] in kept;
      }
      ProofLib.FilterNone(p, kept);
    } else {
      assert f in kept;
      ProofLib.FilterOfFilterLength(q, p, p, s.affinity);
      ProofLib.FilterMember(p, kept, f);
      assert f in ProofLib.Filter(p, kept);
    }
  }
}
lemma AlwaysAccountKeysDistinctFilter(s: AccountPool)
  ensures alwaysAccountKeysDistinct(s) == (!((exists a :: a in s.accounts && !(((a.key > 0) && (|ProofLib.Filter((b: PoolAccount) => (b.key == a.key), s.accounts)| == 1))))))
{
}

lemma AlwaysOneSelectionPerSlotFilter(s: AccountPool)
  ensures alwaysOneSelectionPerSlot(s) == (!((exists x :: x in s.selections && !(((|ProofLib.Filter((o: Selection) => (o.slot == x.slot), s.selections)| == 1) && (!(x.phase.Waiting?) || !(x.reused)))))))
{
}

lemma AlwaysAffinityStaysInProviderFilter(s: AccountPool)
  ensures alwaysAffinityStaysInProvider(s) == (!((exists f :: f in s.affinity && !(((((f.uses >= 1) && (f.uses <= maxAffinityUses)) && (accountOf(s, f.account).provider == f.provider)) && (|ProofLib.Filter((o: Affinity) => ((o.provider == f.provider) && (o.session == f.session)), s.affinity)| == 1))))))
{
}

lemma AccountOfFilter(s: AccountPool, key: int)
  ensures accountOf(s, key) == (if ((0 <= 0) && (0 < |ProofLib.Filter((a: PoolAccount) => (a.key == key), s.accounts)|)) then ProofLib.Filter((a: PoolAccount) => (a.key == key), s.accounts)[0] else noAccount)
{
}

lemma EligibleFilter(s: AccountPool, x: Selection)
  ensures eligible(s, x) == (ProofLib.Filter((a: PoolAccount) => (((a.key in x.snapshot) && inScope(a, x)) && available(a, s.now)), s.accounts))
{
}

lemma SelectionOfFilter(s: AccountPool, slot: int)
  ensures selectionOf(s, slot) == (if ((0 <= 0) && (0 < |ProofLib.Filter((x: Selection) => (x.slot == slot), s.selections)|)) then ProofLib.Filter((x: Selection) => (x.slot == slot), s.selections)[0] else Selection(0, Strategy.ByPriority, "", 0, 0, 0, [], SelectionPhase.NonePicked, noAccount, 0, false, 0))
{
}

lemma AffinityOfFilter(s: AccountPool, provider: string, session: int)
  ensures affinityOf(s, provider, session) == (if ((0 <= 0) && (0 < |ProofLib.Filter((f: Affinity) => ((f.provider == provider) && (f.session == session)), s.affinity)|)) then ProofLib.Filter((f: Affinity) => ((f.provider == provider) && (f.session == session)), s.affinity)[0] else Affinity(provider, session, 0, 0))
{
}

lemma CursorOfFilter(s: AccountPool, provider: string)
  ensures cursorOf(s, provider) == ((if ((0 <= 0) && (0 < |ProofLib.Filter((c: Cursor) => (c.provider == provider), s.cursors)|)) then ProofLib.Filter((c: Cursor) => (c.provider == provider), s.cursors)[0] else Cursor(provider, -1)).index)
{
}

