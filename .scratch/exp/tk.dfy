// A key stored last for an account is the one the fold finds for it.
lemma TkAppend(account: os__signIn__credential_Account, xs: seq<TaskKey>, k: int)
  ensures Std.Collections.Seq.FoldLeft((found: int, t: TaskKey) => (if (t.account == account) then t.key else found), 0, xs + [TaskKey(account, k)]) == k
{
  var f := (found: int, t: TaskKey) => (if (t.account == account) then t.key else found);
  ProofLib.FoldLeftAppend(f, 0, xs, TaskKey(account, k));
  assert f(Std.Collections.Seq.FoldLeft(f, 0, xs), TaskKey(account, k)) == k;
}
