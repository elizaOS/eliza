lemma send_ensures(m: Mailer, n: int)
  ensures (inv(m) ==> canSend(m, n) ==> alwaysAtMostThree(send(m, n).state))
  ensures (inv(m) ==> canSend(m, n) ==> stepSavedBeforeSent(m, send(m, n).state, send(m, n).out))
{
  assert isSaved(Saved(n));
  assert !isSaved(Sent(n));
  var f := (seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen)));
  assert f(0, Saved(n)) == 1;
  assert f(1, Sent(n)) == 1;
  assert Std.Collections.Seq.FoldLeft(f, 0, [Saved(n), Sent(n)]) == Std.Collections.Seq.FoldLeft(f, 1, [Sent(n)]);
  assert Std.Collections.Seq.FoldLeft(f, 1, [Sent(n)]) == Std.Collections.Seq.FoldLeft(f, 1, []);
  assert Std.Collections.Seq.FoldLeft(f, 1, []) == 1;
}
