lemma RetryFoldCoversRefusedWindow(checks: seq<Check>, now: int, current: int, index: int)
  requires 0 <= index < |checks|
  requires request(checks[index].window, checks[index].rule, now).last.Refused?
  ensures Std.Collections.Seq.FoldLeft((t: int, c: Check) => laterRetryAt(request(c.window, c.rule, now).last, t), current, checks) >=
    request(checks[index].window, checks[index].rule, now).last.retryAt
  decreases |checks|
{
  var advance := (t: int, c: Check) => laterRetryAt(request(c.window, c.rule, now).last, t);
  var next := advance(current, checks[0]);
  if index == 0 {
    assert next >= request(checks[0].window, checks[0].rule, now).last.retryAt;
    ProofLib.FoldLeftInflationary(advance, next, checks[1..]);
  } else {
    assert checks[1..][index - 1] == checks[index];
    RetryFoldCoversRefusedWindow(checks[1..], now, next, index - 1);
  }
}

lemma lawAGroupRetryAtItsTimeIsAdmitted_ensures(checks: seq<Check>, now: int)
  ensures (lawAGroupRetryAtItsTimeIsAdmitted(checks, now) == true)
{
  if allCountable(checks, now) &&
    (forall c :: c in checks ==> alwaysWindowsStayWithinTheirLimit(c.window)) &&
    !admitsAll(checks, now)
  {
    var retry := retryAtOfAll(checks, now);
    ProofLib.FoldLeftInflationary((t: int, c: Check) => laterRetryAt(request(c.window, c.rule, now).last, t), now, checks);
    assert retry >= now;
    forall c | c in checks
      ensures canRequest(c.window, c.rule, retry)
      ensures request(c.window, c.rule, retry).last.Admitted?
    {
      assert canRequest(c.window, c.rule, now);
      assert c.window.start <= c.window.clock <= now <= retry;
      var first := request(c.window, c.rule, now).last;
      if first.Refused? {
        var index :| 0 <= index < |checks| && checks[index] == c;
        RetryFoldCoversRefusedWindow(checks, now, now, index);
        assert first.retryAt == c.window.end;
        assert retry >= c.window.end;
      } else if retry < c.window.end {
        assert now < c.window.end;
        assert admits(c.window.count, c.rule);
      }
    }
    assert admitsAll(checks, retry);
  }
}
