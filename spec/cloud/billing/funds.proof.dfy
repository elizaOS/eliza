lemma ReservedCoversQuote(quote: int)
  requires quote >= 0
  ensures cloud__shared__metering_reservedFor(quote) >= quote
{
  assert cloud__shared__metering_quotient_cloud__shared__metering(quote * cloud__shared__metering_holdMarginPercent, 100) >= quote by {
    assert (quote * 150) / 100 >= quote;
  }
}

lemma HoldSplitBounds(lane: cloud__shared__metering_FundingLane, quote: int, allowanceAvailable: int, creditAvailable: int)
  requires cloud__shared__metering_fundable(lane, quote, allowanceAvailable, creditAvailable)
  requires !lane.SponsoredInference?
  ensures var hold := cloud__shared__metering_holdAmount(lane, quote, allowanceAvailable, creditAvailable);
    var sp := cloud__shared__metering_splitHold(lane, hold, allowanceAvailable);
    quote <= hold && hold <= cloud__shared__metering_laneOffers(lane, allowanceAvailable, creditAvailable)
    && sp.allowancePart + sp.creditPart == hold
    && 0 <= sp.allowancePart <= allowanceAvailable
    && 0 <= sp.creditPart <= creditAvailable
{
  ReservedCoversQuote(quote);
  hide cloud__shared__metering_reservedFor, cloud__shared__metering_quotient_cloud__shared__metering, JSFloorDiv, MathAbs;
}

lemma CreditChargeBounds(fa: int, fc: int, charged: int, limit: int)
  requires 0 <= fa && 0 <= fc && 0 <= charged <= fa + limit && 0 <= limit
  ensures var al := cloud__shared__metering_minOf(charged, fa);
    0 <= charged - al <= limit
{
}

lemma lawMeteredChargeFitsTheFunds_ensures(lane: cloud__shared__metering_FundingLane, quote: int, allowanceAvailable: int, creditAvailable: int, actual: int, creditFree: int)
  ensures (lawMeteredChargeFitsTheFunds(lane, quote, allowanceAvailable, creditAvailable, actual, creditFree) == true)
{
  if cloud__shared__metering_fundable(lane, quote, allowanceAvailable, creditAvailable) && actual >= 0 && creditFree >= 0 && !lane.SponsoredInference? {
    HoldSplitBounds(lane, quote, allowanceAvailable, creditAvailable);
    hide cloud__shared__metering_reservedFor, cloud__shared__metering_quotient_cloud__shared__metering, JSFloorDiv, MathAbs;
    var reserved := cloud__shared__metering_reserve(cloud__shared__metering_initial, cloud__shared__metering_holdKeyOf(cloud__shared__metering_initial), quote, lane, allowanceAvailable, creditAvailable, 0);
    var fa := reserved.fromAllowance;
    var fc := reserved.fromCredits;
    var hold := reserved.reserved;
    assert quote <= hold && fa + fc == hold && 0 <= fa <= allowanceAvailable && 0 <= fc <= creditAvailable;
    var dispatched := cloud__shared__metering_markDispatched(reserved, 0);
    var knownHold := cloud__shared__metering_settleKnown(dispatched, actual, creditFree);
    CreditChargeBounds(fa, fc, knownHold.charged, fc + creditFree);
    var lostHold := cloud__shared__metering_settleUnknown(dispatched);
    CreditChargeBounds(fa, fc, lostHold.charged, fc);
  }
}
