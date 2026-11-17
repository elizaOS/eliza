lemma reserveWindow_ensures(l: CloudLease)
  ensures (inv(l) ==> canReserveWindow(l) ==> alwaysConsentResetBounded(reserveWindow(l)))
  ensures (inv(l) ==> canReserveWindow(l) ==> alwaysWindowAuthority(reserveWindow(l)))
  ensures (inv(l) ==> canReserveWindow(l) ==> alwaysNoUnfundedWindow(reserveWindow(l)))
  ensures (inv(l) ==> canReserveWindow(l) ==> alwaysNoForeignCapture(reserveWindow(l)))
  ensures (inv(l) ==> canReserveWindow(l) ==> alwaysRetiredAfterSettlement(reserveWindow(l)))
  ensures (inv(l) ==> canReserveWindow(l) ==> stepNoLateConsent(l, "reserveWindow", reserveWindow(l)))
{
  if inv(l) && canReserveWindow(l) {
    var p := (set_x: int) => !((set_x in l.allocated_));
    assert (l.paid + 1) !in l.allocated_;
    ProofLib.FilterCons(p, [(l.paid + 1)]);
    ProofLib.FilterNil(p, [(l.paid + 1)][1..]);
  }
}
