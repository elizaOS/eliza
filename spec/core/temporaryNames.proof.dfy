lemma allocate_ensures(s: TemporaryNames, target: string, pid: int, clock: int)
  ensures (inv(s) ==> alwaysEveryAllocationCounted(allocate(s, target, pid, clock)))
  ensures (inv(s) ==> alwaysOrdinalUnique(allocate(s, target, pid, clock)))
  ensures (inv(s) ==> stepCounterAdvancesExactlyOnce(s, allocate(s, target, pid, clock)))
{
  if inv(s) {
    var added := TemporaryName(target, pid, clock, s.sequence + 1);
    var after := allocate(s, target, pid, clock);
    forall name | name in after.allocated_ ensures name.ordinal > 0 && name.ordinal <= after.sequence && |ProofLib.Filter((other: TemporaryName) => other.ordinal == name.ordinal, after.allocated_)| == 1 {
      var p := (other: TemporaryName) => other.ordinal == name.ordinal;
      ProofLib.FilterAppend(p, s.allocated_, added);
      if name == added {
        assert forall i :: 0 <= i < |s.allocated_| ==> s.allocated_[i].ordinal != name.ordinal;
        ProofLib.FilterNone(p, s.allocated_);
      } else {
        assert name in s.allocated_;
      }
    }
  }
}
