lemma FilterSingletonTrue(p: int -> bool, w: int)
  requires p(w)
  ensures ProofLib.Filter(p, [w]) == [w]
{
  ProofLib.FilterCons(p, [w]);
  assert [w][0] == w && [w][1..] == [];
  ProofLib.FilterNil(p, []);
}

lemma recordReceipt_ensures(s: Session, window: int, direction: cloud__shared__types_SpeechDirection)
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> alwaysASessionComesFromItsConsent(recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> alwaysWindowsFollowThePhase(recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> alwaysReceiptsComeOnlyFromEndedWindows(recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> stepTheConsentIsSpentOnlyByMinting(s, "recordReceipt", recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> stepOnlyOneSocketIsAccepted(s, "recordReceipt", recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> stepIdentityNeverChanges(s, recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> stepWindowsAreAdmittedOneAtATime(s, "recordReceipt", recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> stepRetirementIsFinal(s, recordReceipt(s, window, direction)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction) ==> stepReceiptsAndCauseNeverChange(s, recordReceipt(s, window, direction)))
{
  if inv(s) && canRecordReceipt(s, window, direction) {
    if direction.Transcribe? {
      FilterSingletonTrue((set_x: int) => !((set_x in s.sttSettled)), window);
    } else {
      FilterSingletonTrue((set_x: int) => !((set_x in s.ttsSettled)), window);
    }
  }
}
