lemma lawGrantMonthNeverExceedsTheMonthlyAllowance_ensures(planKey: cloud__billing__plans_PlanKey, startsAt: int, endsAt: int, fullEndsAt: int)
  ensures (lawGrantMonthNeverExceedsTheMonthlyAllowance(planKey, startsAt, endsAt, fullEndsAt) == true)
{
  hide *;
  reveal lawGrantMonthNeverExceedsTheMonthlyAllowance, validWindow;
  reveal cloud__shared__types_millisPerMinute;
  if validWindow(startsAt, endsAt) && endsAt <= fullEndsAt {
    reveal grantMonthAllowance, cloud__billing__plans_allowanceOf, cloud__billing__plans_termsOf;
    reveal cloud__billing__plans_freePlan, cloud__billing__plans_plusPlan, cloud__billing__plans_proPlan;
    reveal quotient_cloud__billing__allowance, JSFloorDiv, MathAbs;
    var minute := cloud__shared__types_millisPerMinute;
    var monthly := cloud__billing__plans_allowanceOf(planKey);
    assert monthly >= 0;
    var covered := (endsAt - startsAt) / minute;
    var full := (fullEndsAt - startsAt) / minute;
    assert 0 < covered <= full;
    if endsAt < fullEndsAt {
      ProratedAllowanceBound(monthly, covered, full);
      assert grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) == monthly * covered / full;
    }
  }
}

lemma ProratedAllowanceBound(monthly: int, covered: int, full: int)
  requires monthly >= 0 && 0 <= covered <= full && full > 0
  ensures 0 <= monthly * covered / full <= monthly
{
  hide *;
  var numerator := monthly * covered;
  assert 0 <= numerator <= monthly * full by {
    assert monthly * (full - covered) >= 0;
    assert monthly * (full - covered) == monthly * full - numerator;
  }
  var quotient := numerator / full;
  var remainder := numerator % full;
  assert numerator == quotient * full + remainder;
  assert 0 <= remainder < full;
  if quotient < 0 {
    assert (quotient + 1) * full <= 0;
    assert numerator < (quotient + 1) * full;
  }
  if quotient > monthly {
    assert (quotient - monthly) * full > 0;
    assert quotient * full > monthly * full;
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  hide *;
  reveal initial;
  reveal initialHolds, inv, alwaysOpenedPeriodIsPaid, alwaysUnopenedPeriodIsEmpty;
  reveal alwaysEveryMicroAccounted, alwaysOnlyAnOpenPeriodHasAvailable;
  reveal alwaysAdjustedOnlyByARenewal, alwaysOnlyARenewalIsClawedBack, isClawedBack;
}
