lemma TkFold(account: os__signIn__credential_Account, init: int, xs: seq<TaskKey>)
  ensures var r := Std.Collections.Seq.FoldLeft((found: int, t: TaskKey) => (if (t.account == account) then t.key else found), init, xs);
    (r == init && forall t :: t in xs ==> t.account != account) || (exists t :: t in xs && t.account == account && t.key == r)
  decreases |xs|
{
  var f := (found: int, t: TaskKey) => (if (t.account == account) then t.key else found);
  if |xs| > 0 {
    var next := f(init, xs[0]);
    TkFold(account, next, xs[1..]);
    assert Std.Collections.Seq.FoldLeft(f, init, xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    assert forall t :: t in xs[1..] ==> t in xs;
    assert forall t :: t in xs ==> t == xs[0] || t in xs[1..];
  }
}

lemma TkAppend(account: os__signIn__credential_Account, xs: seq<TaskKey>, k: int)
  ensures Std.Collections.Seq.FoldLeft((found: int, t: TaskKey) => (if (t.account == account) then t.key else found), 0, xs + [TaskKey(account, k)]) == k
{
  var f := (found: int, t: TaskKey) => (if (t.account == account) then t.key else found);
  ProofLib.FoldLeftAppend(f, 0, xs, TaskKey(account, k));
}

lemma release_ensures(s: TaskKeyCustody, account: os__signIn__credential_Account, epoch: int, observed: os__android__secureStore_SlotRead)
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> alwaysCountersAreNatural(release(s, account, epoch, observed).state))
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> alwaysOneKeyPerAccount(release(s, account, epoch, observed).state))
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> alwaysReleaseIsTheVerifiedAccountsKey(release(s, account, epoch, observed).state))
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> stepAStoredKeyIsNeverReplaced(s, "release", release(s, account, epoch, observed).state))
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> stepARefusalChangesNoKey(s, "release", release(s, account, epoch, observed).state, release(s, account, epoch, observed).out))
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> stepAReleaseNamesANewerLaunch(s, "release", release(s, account, epoch, observed).state, release(s, account, epoch, observed).out))
  ensures (inv(s) ==> canRelease(s, account, epoch) ==> stepAnAccountChangeRetiresTheRelease(s, release(s, account, epoch, observed).state))
{
  if inv(s) && canRelease(s, account, epoch) {
    var held := keyOf(account, s);
    TkFold(account, 0, s.keys);
    var after := release(s, account, epoch, observed).state;
    var found := keyFound(held, observed);
    if found.FirstKey? {
      var k := s.lastKey + 1;
      var t := TaskKey(account, k);
      assert held == 0;
      assert forall u :: u in s.keys ==> u.account != account;
      assert after.keys == s.keys + [t];
      TkAppend(account, s.keys, k);
      assert keyOf(account, after) == k;
      assert forall u :: u in after.keys ==> u in s.keys || u == t;
      assert forall u :: u in s.keys ==> u.key <= s.lastKey;
    } else if found.KnownKey? {
      assert held >= 1;
      assert after.keys == s.keys;
      assert keyOf(account, after) == held;
    }
  }
}

lemma lawALostKnownKeyIsNeverCreatedAgain_ensures(account: os__signIn__credential_Account, epoch: int)
  ensures (lawALostKnownKeyIsNeverCreatedAgain(account, epoch) == true)
{
  var s := initial.(verified := account, keys := [TaskKey(account, 1)], lastKey := 1);
  assert [] + [TaskKey(account, 1)] == [TaskKey(account, 1)];
  TkAppend(account, [], 1);
  assert keyOf(account, s) == 1;
}
