lemma SpeechAddOne(xs: seq<int>, v: int)
  ensures forall x :: x in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [v]) <==> x in xs || x == v
  ensures v !in xs ==> |xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [v])| == |xs| + 1
{
  forall x
    ensures x in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [v]) <==> x in xs || x == v
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in xs)), [v], x);
  }
  ProofLib.FilterCons((set_x: int) => !((set_x in xs)), [v]);
  ProofLib.FilterNil((set_x: int) => !((set_x in xs)), [v][1..]);
}

lemma SpeechFilters(s: SpeechSession, billingWindow: int)
  ensures reserveWindow(s).recorded == s.recorded + ProofLib.Filter((set_x: int) => !((set_x in s.recorded)), [|s.recorded|])
  ensures fundWindow(s).funded == s.funded + ProofLib.Filter((set_x: int) => !((set_x in s.funded)), [s.pendingWindow])
  ensures extendWindow(s).granted == s.granted + ProofLib.Filter((set_x: int) => !((set_x in s.granted)), [s.pendingWindow])
  ensures refuseWindow(s).settled == s.settled + ProofLib.Filter((set_x: int) => !((set_x in s.settled)), [s.pendingWindow])
  ensures settleWindow(s, billingWindow).settled == s.settled + ProofLib.Filter((set_x: int) => !((set_x in s.settled)), [billingWindow])
{
}

lemma reserveWindow_ensures(s: SpeechSession)
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysConsentMintedAtMostOnce(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysPreparedOnlyUnderAllowedCredential(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysLiveConsentIsArmed(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysAdmissionCameFromAConsent(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysUnmintedConsentHasNoAdmission(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysGrantedWindowsWereFunded(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysPendingWindowIsRecorded(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysRefusedWindowIsNeverGranted(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysNothingBillsBeforeTheTransport(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysRecordedWindowsHaveNoGaps(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysSettledWindowsWereRecorded(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysStopRequestsProviderClose(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> alwaysConfirmedOnlyWithEveryReceipt(reserveWindow(s)))
  ensures (inv(s) ==> canReserveWindow(s) ==> stepNoAdmissionAfterStop(s, reserveWindow(s)))
{
  if inv(s) && canReserveWindow(s) {
    SpeechFilters(s, 0);
    SpeechAddOne(s.recorded, |s.recorded|);
  }
}

lemma fundWindow_ensures(s: SpeechSession)
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysConsentMintedAtMostOnce(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysPreparedOnlyUnderAllowedCredential(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysLiveConsentIsArmed(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysAdmissionCameFromAConsent(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysUnmintedConsentHasNoAdmission(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysGrantedWindowsWereFunded(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysPendingWindowIsRecorded(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysRefusedWindowIsNeverGranted(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysNothingBillsBeforeTheTransport(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysRecordedWindowsHaveNoGaps(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysSettledWindowsWereRecorded(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysStopRequestsProviderClose(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> alwaysConfirmedOnlyWithEveryReceipt(fundWindow(s)))
  ensures (inv(s) ==> canFundWindow(s) ==> stepNoAdmissionAfterStop(s, fundWindow(s)))
{
  if inv(s) && canFundWindow(s) {
    SpeechFilters(s, 0);
    SpeechAddOne(s.funded, s.pendingWindow);
  }
}

lemma extendWindow_ensures(s: SpeechSession)
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysConsentMintedAtMostOnce(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysPreparedOnlyUnderAllowedCredential(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysLiveConsentIsArmed(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysAdmissionCameFromAConsent(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysUnmintedConsentHasNoAdmission(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysGrantedWindowsWereFunded(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysPendingWindowIsRecorded(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysRefusedWindowIsNeverGranted(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysNothingBillsBeforeTheTransport(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysRecordedWindowsHaveNoGaps(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysSettledWindowsWereRecorded(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysStopRequestsProviderClose(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> alwaysConfirmedOnlyWithEveryReceipt(extendWindow(s)))
  ensures (inv(s) ==> canExtendWindow(s) ==> stepNoAdmissionAfterStop(s, extendWindow(s)))
{
  if inv(s) && canExtendWindow(s) {
    SpeechFilters(s, 0);
    SpeechAddOne(s.granted, s.pendingWindow);
  }
}

lemma refuseWindow_ensures(s: SpeechSession)
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysConsentMintedAtMostOnce(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysPreparedOnlyUnderAllowedCredential(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysLiveConsentIsArmed(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysAdmissionCameFromAConsent(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysUnmintedConsentHasNoAdmission(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysGrantedWindowsWereFunded(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysPendingWindowIsRecorded(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysRefusedWindowIsNeverGranted(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysNothingBillsBeforeTheTransport(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysRecordedWindowsHaveNoGaps(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysSettledWindowsWereRecorded(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysStopRequestsProviderClose(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> alwaysConfirmedOnlyWithEveryReceipt(refuseWindow(s)))
  ensures (inv(s) ==> canRefuseWindow(s) ==> stepNoAdmissionAfterStop(s, refuseWindow(s)))
{
  if inv(s) && canRefuseWindow(s) {
    SpeechFilters(s, 0);
    SpeechAddOne(s.settled, s.pendingWindow);
  }
}

lemma settleWindow_ensures(s: SpeechSession, billingWindow: int)
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysConsentMintedAtMostOnce(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysPreparedOnlyUnderAllowedCredential(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysLiveConsentIsArmed(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysAdmissionCameFromAConsent(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysUnmintedConsentHasNoAdmission(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysGrantedWindowsWereFunded(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysPendingWindowIsRecorded(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysRefusedWindowIsNeverGranted(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysNothingBillsBeforeTheTransport(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysRecordedWindowsHaveNoGaps(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysSettledWindowsWereRecorded(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysStopRequestsProviderClose(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> alwaysConfirmedOnlyWithEveryReceipt(settleWindow(s, billingWindow)))
  ensures (inv(s) ==> canSettleWindow(s, billingWindow) ==> stepNoAdmissionAfterStop(s, settleWindow(s, billingWindow)))
{
  if inv(s) && canSettleWindow(s, billingWindow) {
    SpeechFilters(s, billingWindow);
    SpeechAddOne(s.settled, billingWindow);
  }
}
