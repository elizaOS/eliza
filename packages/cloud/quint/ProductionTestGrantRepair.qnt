// One existing test code. Repair never mints, redeems or changes its term.
module ProductionTestGrantRepair {
  var days: int
  var used: bool
  var admissible: bool
  var repaired: bool
  var originalDays: int
  var minted: int

  action init = {
    nondet term = Set(0, 1, 7, 31, 32).oneOf()
    all {
    days' = term,
    originalDays' = term,
    used' = false,
    admissible' = true,
    repaired' = false,
    minted' = 0,
    }
  }
  action repair = all {
    not(used), admissible, days >= 1, days <= 31,
    repaired' = true,
    days' = days, originalDays' = originalDays,
    used' = used, admissible' = admissible, minted' = minted,
  }
  action invalidate = all {
    admissible' = false, repaired' = repaired,
    days' = days, originalDays' = originalDays, used' = used, minted' = minted,
  }
  action redeem = all {
    repaired, not(used), admissible,
    used' = true, repaired' = repaired,
    days' = days, originalDays' = originalDays, admissible' = admissible, minted' = minted,
  }
  action step = any { repair, invalidate, redeem }
  val safety = minted == 0 and days == originalDays and
    (repaired implies (days >= 1 and days <= 31))
}
