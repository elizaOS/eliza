lemma lawRepeatDaysAreDistinctWeekdays_ensures(day: int)
  ensures (lawRepeatDaysAreDistinctWeekdays(day) == true)
{
  assert [day] == [] + [day];
  ProofLib.FoldLeftAppend(scanDay, DayScan(0, true), [], day);
  assert [day, day] == [day] + [day];
  ProofLib.FoldLeftAppend(scanDay, DayScan(0, true), [day], day);
}
