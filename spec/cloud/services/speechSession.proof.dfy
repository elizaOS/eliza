lemma recordReceipt_ensures(s: Session, window: int, direction: cloud__shared__types_SpeechDirection, evidence: cloud__services__speechRelay_SettlementEvidence)
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> alwaysASessionComesFromItsConsent(recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> alwaysWindowsFollowThePhase(recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> alwaysReceiptsComeOnlyFromFinishedWindows(recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> stepTheConsentIsSpentOnlyByMinting(s, "recordReceipt", recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> stepOnlyOneSocketIsAccepted(s, "recordReceipt", recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> stepIdentityNeverChanges(s, recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> stepWindowsAreAdmittedOneAtATime(s, "recordReceipt", recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> stepRetirementIsFinal(s, recordReceipt(s, window, direction, evidence)))
  ensures (inv(s) ==> canRecordReceipt(s, window, direction, evidence) ==> stepReceiptsAndCauseNeverChange(s, recordReceipt(s, window, direction, evidence)))
{
  if inv(s) && canRecordReceipt(s, window, direction, evidence) {
    var after := recordReceipt(s, window, direction, evidence);
    assert after.phase == s.phase && after.windows == s.windows;
    assert s.phase.Active? || isRetiring(s.phase);
    if s.phase.Active? {
      assert cloud__services__speechRelay_rolloverReady(window, s.windows, evidence);
      assert window < s.windows;
    }
    if direction.Transcribe? {
      assert after.sttSettled == s.sttSettled + ProofLib.Filter((set_x: int) => !((set_x in s.sttSettled)), [window]);
      AddedReceiptKeepsWindowRange(s.sttSettled, after.sttSettled, window, s.windows, s.phase.Active?);
    } else {
      assert after.ttsSettled == s.ttsSettled + ProofLib.Filter((set_x: int) => !((set_x in s.ttsSettled)), [window]);
      AddedReceiptKeepsWindowRange(s.ttsSettled, after.ttsSettled, window, s.windows, s.phase.Active?);
    }
  }
}

lemma AddedReceiptKeepsWindowRange(before: seq<int>, after: seq<int>, window: int, latest: int, active: bool)
  requires after == before + ProofLib.Filter((set_x: int) => !((set_x in before)), [window])
  requires 1 <= window <= latest
  requires forall w :: w in before ==> 1 <= w <= latest
  requires active ==> latest !in before && window < latest
  ensures forall w :: w in after ==> 1 <= w <= latest
  ensures active ==> latest !in after
{
  var added := ProofLib.Filter((set_x: int) => !((set_x in before)), [window]);
  forall w | w in after
    ensures 1 <= w <= latest && (active ==> w != latest)
  {
    if w !in before {
      assert w in added;
      ProofLib.FilterMember((set_x: int) => !((set_x in before)), [window], w);
      assert w == window;
    }
  }
}
