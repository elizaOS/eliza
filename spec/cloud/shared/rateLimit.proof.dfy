// The group's retry time is at or after now and at or after every refused
// window's end, by induction over the fold.
lemma RetryAtOfAllBounds(checks: seq<Check>, now: int, t: int)
  ensures Std.Collections.Seq.FoldLeft((t: int, c: Check) => laterRetryAt(request(c.window, c.rule, now).last, t), t, checks) >= t
  ensures forall c :: c in checks && request(c.window, c.rule, now).last.Refused? ==> Std.Collections.Seq.FoldLeft((t: int, c: Check) => laterRetryAt(request(c.window, c.rule, now).last, t), t, checks) >= request(c.window, c.rule, now).last.retryAt
  decreases |checks|
{
  if |checks| > 0 {
    var t2 := laterRetryAt(request(checks[0].window, checks[0].rule, now).last, t);
    RetryAtOfAllBounds(checks[1..], now, t2);
    assert forall c :: c in checks ==> c == checks[0] || c in checks[1..];
  }
}

// A window that was countable and within its limit at now, and whose
// refusal (if any) ends by later, is admitted at later.
lemma AdmittedAtLater(c: Check, now: int, later: int)
  requires canRequest(c.window, c.rule, now)
  requires alwaysWindowsStayWithinTheirLimit(c.window)
  requires later >= now
  requires request(c.window, c.rule, now).last.Refused? ==> later >= request(c.window, c.rule, now).last.retryAt
  ensures canRequest(c.window, c.rule, later)
  ensures request(c.window, c.rule, later).last.Admitted?
{
}

lemma lawAGroupRetryAtItsTimeIsAdmitted_ensures(checks: seq<Check>, now: int)
  ensures (lawAGroupRetryAtItsTimeIsAdmitted(checks, now) == true)
{
  var later := retryAtOfAll(checks, now);
  RetryAtOfAllBounds(checks, now, now);
  if allCountable(checks, now) && !((exists c :: c in checks && !(alwaysWindowsStayWithinTheirLimit(c.window)))) {
    forall c | c in checks
      ensures canRequest(c.window, c.rule, later) && request(c.window, c.rule, later).last.Admitted?
    {
      AdmittedAtLater(c, now, later);
    }
    assert allCountable(checks, later);
    assert admitsAll(checks, later);
  }
}
