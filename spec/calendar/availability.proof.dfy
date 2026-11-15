lemma InsertIntoSingleSlot(slot: BusySlot, present: BusySlot)
  ensures insertSlot([present], slot) == (if slotEarlier(slot, present) then [slot, present] else [present, slot])
{
  var seed := InsertCursor(false, []);
  var step := (acc: InsertCursor, row: BusySlot) => insertionStep(slot, acc, row);
  assert Std.Collections.Seq.FoldLeft(step, seed, []) == seed;
  ProofLib.FoldLeftAppend(step, seed, [], present);
  assert Std.Collections.Seq.FoldLeft(step, seed, [present]) == insertionStep(slot, seed, present);
  if slotEarlier(slot, present) {
    assert insertionStep(slot, seed, present) == InsertCursor(true, [slot, present]);
    assert insertSlot([present], slot) == [slot, present];
  } else {
    assert insertionStep(slot, seed, present) == InsertCursor(false, [present]);
    assert insertSlot([present], slot) == [present, slot];
  }
}

lemma lawLaterSlotFollows_ensures(left: BusySlot, right: BusySlot)
  ensures (lawLaterSlotFollows(left, right) == true)
{
  InsertIntoSingleSlot(left, right);
}

lemma lawEqualSlotsBothSurvive_ensures(slot: BusySlot)
  ensures (lawEqualSlotsBothSurvive(slot) == true)
{
  InsertIntoSingleSlot(slot, slot);
}
