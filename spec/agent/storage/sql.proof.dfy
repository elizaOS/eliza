lemma DeleteRowFilters(c: CarveOut, row: string)
  ensures deleteRow(c, row).target == ProofLib.Filter((set_x: string) => !((set_x in [row])), c.target)
  ensures deleteRow(c, row).tombstones == c.tombstones + ProofLib.Filter((set_x: string) => !((set_x in c.tombstones)), [row])
  ensures alwaysDeletedRowsStayDeleted(c) == (|ProofLib.Filter((set_x: string) => (set_x in c.target), c.tombstones)| == 0)
  ensures alwaysDeletedRowsStayDeleted(deleteRow(c, row)) == (|ProofLib.Filter((set_x: string) => (set_x in deleteRow(c, row).target), deleteRow(c, row).tombstones)| == 0)
{
}

lemma deleteRow_ensures(c: CarveOut, row: string)
  ensures (inv(c) ==> canDeleteRow(c, row) ==> alwaysNoUncommittedCopy(deleteRow(c, row)))
  ensures (inv(c) ==> canDeleteRow(c, row) ==> alwaysPriorReceiptIsRespected(deleteRow(c, row)))
  ensures (inv(c) ==> canDeleteRow(c, row) ==> alwaysCompletedReceiptWasVerified(deleteRow(c, row)))
  ensures (inv(c) ==> canDeleteRow(c, row) ==> alwaysNoCopyBeforeAnAttempt(deleteRow(c, row)))
  ensures (inv(c) ==> canDeleteRow(c, row) ==> alwaysAHeldCarveOutIsAFreshAttempt(deleteRow(c, row)))
  ensures (inv(c) ==> canDeleteRow(c, row) ==> alwaysDeletedRowsStayDeleted(deleteRow(c, row)))
{
  if inv(c) && canDeleteRow(c, row) {
    var after := deleteRow(c, row);
    DeleteRowFilters(c, row);
    ProofLib.FilterNone((set_x: string) => (set_x in c.target), c.tombstones);
    ProofLib.FilterMember((set_x: string) => !((set_x in c.tombstones)), [row], row);
    forall x | x in after.target
      ensures x in c.target && x != row
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in [row])), c.target, x);
    }
    forall x | x in after.tombstones
      ensures x in c.tombstones || x == row
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in c.tombstones)), [row], x);
    }
    ProofLib.FilterNone((set_x: string) => (set_x in after.target), after.tombstones);
    assert after.tombstones == c.tombstones + ProofLib.Filter((set_x: string) => !((set_x in c.tombstones)), [row]);
    assert |after.tombstones| >= |c.tombstones|;
  }
}
