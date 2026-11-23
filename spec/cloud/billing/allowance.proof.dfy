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

lemma lawUpgradeAddsAtMostTheDifference_ensures(previous: cloud__billing__plans_PlanKey, target: cloud__billing__plans_PlanKey, startsAt: int, endsAt: int, effectiveAt: int)
  ensures (lawUpgradeAddsAtMostTheDifference(previous, target, startsAt, endsAt, effectiveAt) == true)
{
  hide *;
  reveal lawUpgradeAddsAtMostTheDifference, upgradeAdjustment;
  reveal cloud__shared__types_millisPerMinute;
  reveal quotient_cloud__billing__allowance, JSFloorDiv, MathAbs;
  var minute := cloud__shared__types_millisPerMinute;
  var total := quotient_cloud__billing__allowance((endsAt - startsAt), minute);
  var left := quotient_cloud__billing__allowance((endsAt - effectiveAt), minute);
  if cloud__billing__plans_isUpgrade(previous, target) && total > 0 && effectiveAt >= startsAt && left >= 0 {
    reveal cloud__billing__plans_isUpgrade, cloud__billing__plans_isPlanChange, cloud__billing__plans_isPaid, cloud__billing__plans_rankOf;
    reveal cloud__billing__plans_allowanceOf, cloud__billing__plans_termsOf;
    reveal cloud__billing__plans_freePlan, cloud__billing__plans_plusPlan, cloud__billing__plans_proPlan;
    var difference := cloud__billing__plans_allowanceOf(target) - cloud__billing__plans_allowanceOf(previous);
    assert difference > 0;
    assert total == (endsAt - startsAt) / minute;
    if endsAt - effectiveAt >= 0 {
      assert left == (endsAt - effectiveAt) / minute;
      QuotientMonotone(endsAt - effectiveAt, endsAt - startsAt, minute);
    } else {
      assert left <= 0;
    }
    assert 0 <= left <= total;
    ProratedAllowanceBound(difference, left, total);
    assert difference * left >= 0;
    assert upgradeAdjustment(previous, target, startsAt, endsAt, effectiveAt) == difference * left / total;
  }
}

lemma QuotientMonotone(smaller: int, larger: int, divisor: int)
  requires 0 <= smaller <= larger && divisor > 0
  ensures smaller / divisor <= larger / divisor
{
  hide *;
  var low := smaller / divisor;
  var high := larger / divisor;
  assert smaller == low * divisor + smaller % divisor;
  assert larger == high * divisor + larger % divisor;
  assert 0 <= smaller % divisor < divisor;
  assert 0 <= larger % divisor < divisor;
  if low > high {
    var gap := low - high - 1;
    assert gap >= 0;
    assert gap * divisor >= 0;
    assert low * divisor == gap * divisor + high * divisor + divisor;
    assert false;
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
