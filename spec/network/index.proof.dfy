// spec/network/index.md, "A stated weekday or day of the month is read on the member's own calendar"
lemma NetworkRemNonNeg(a: int)
  requires a >= 0
  ensures remainder_network(a, 7) == a % 7
  ensures 0 <= remainder_network(a, 7) < 7
{
  assert quotient_network(a, 7) == a / 7;
}

lemma lawABareWeekdayComesWithinAWeek_ensures(today: int, weekday: int)
  ensures (lawABareWeekdayComesWithinAWeek(today, weekday) == true)
{
  if today >= 0 && 0 <= weekday <= 6 {
    NetworkRemNonNeg(today + 4);
    var w := networkWeekday(today);
    var q := (today + 4) / 7;
    assert today + 4 == 7 * q + w;
    var diff := (weekday - w) + 7;
    NetworkRemNonNeg(diff);
    var d := remainder_network(diff, 7);
    if d == 0 {
      assert w == weekday;
      NetworkRemNonNeg(today + 7 + 4);
      assert today + 7 + 4 == 7 * (q + 1) + weekday;
    } else if weekday > w {
      assert d == weekday - w;
      NetworkRemNonNeg(today + d + 4);
      assert today + d + 4 == 7 * q + weekday;
    } else {
      assert d == weekday - w + 7;
      NetworkRemNonNeg(today + d + 4);
      assert today + d + 4 == 7 * (q + 1) + weekday;
    }
  }
}
