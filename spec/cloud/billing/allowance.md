# Plan allowance

The money a paid plan includes each period, spent before credits and never
carried over. One `Period` is one row: a paid renewal invoice opens one, keyed
by the environment and the invoice id, and each month of a grant opens one,
keyed by the grant id and the month number (`spec/cloud/billing/grantCodes.md`).
Holds take their allowance part from the period that covers the call
(`spec/cloud/shared/metering.md`), in the same transaction as the hold step.
Sources are develop `packages/cloud/shared/src/db/repositories/subscription-allowance.ts`
(reserve, settle, retire), `subscription-grants.ts` (`grantAllowanceSchedule`),
`organization-upgrade-allowance-posting.ts` and
`lib/services/subscription-allowance-proration.ts`, the period table of
migration `0373_subscription_authority.sql`, and the Quint model
`subscription_funding_reservations`. Downstream readers show
`allowance.amountUsd` and the remaining allowance with its reset time.

The shell keeps the calendar: it computes each grant month's bounds by UTC
calendar months and passes them in. Develop's app-scoped periods, the payment
grace for hosted compute and the `import_consumed` entry are gone: the cloud
hosts nothing.

## Story: Spend my plan's allowance before my credits, and never carry it over

> As a subscriber, I want each period's allowance spent before my credits and
> forfeited when the period ends, so that my credits pay only for what my
> plan does not.

### A period opens once, from a paid invoice with its plan's allowance or from a grant month with its share of it

A grant's last month may be partial: it gets the monthly allowance prorated
by whole minutes of the full calendar month, rounded down; a month whose share
rounds to nothing opens no period. A free plan opens nothing.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
type PeriodPhase = PeriodUnopened | PeriodOpen | PeriodExpired | PeriodClosed | PeriodClawedBack
type PeriodSource = NoSource | RenewalInvoice({ invoiceId: str }) | GrantMonth({ grantId: str, month: int })
type ClawbackCause = NoClawback | RefundClawback | DisputeClawback
type Period = { phase: PeriodPhase, source: PeriodSource, planKey: PlanKey, startsAt: Millis, endsAt: Millis, granted: Micros, adjustment: Micros, available: Micros, reserved: Micros, settled: Micros, expired: Micros, clawedBack: Micros, clawbackCause: ClawbackCause }
pure val initial: Period = { phase: PeriodUnopened, source: NoSource, planKey: Free, startsAt: 0, endsAt: 0, granted: 0, adjustment: 0, available: 0, reserved: 0, settled: 0, expired: 0, clawedBack: 0, clawbackCause: NoClawback }
pure def isRenewal(p: Period): bool = { val src = p.source
  match src { | RenewalInvoice(x) => true | _ => false } }
pure def isGrantMonth(p: Period): bool = { val src = p.source
  match src { | GrantMonth(x) => true | _ => false } }
pure def validWindow(startsAt: Millis, endsAt: Millis): bool = startsAt >= 0 and endsAt - startsAt >= millisPerMinute
pure def periodOf(source: PeriodSource, planKey: PlanKey, startsAt: Millis, endsAt: Millis, granted: Micros): Period =
  { ...initial, phase: PeriodOpen, source: source, planKey: planKey, startsAt: startsAt, endsAt: endsAt, granted: granted, available: granted }
pure def grantMonthAllowance(planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): Micros = {
  val fullMinutes = (fullEndsAt - startsAt) / millisPerMinute
  val coveredMinutes = (endsAt - startsAt) / millisPerMinute
  if (fullMinutes <= 0 or coveredMinutes <= 0) 0
  else if (endsAt >= fullEndsAt) allowanceOf(planKey)
  else allowanceOf(planKey) * coveredMinutes / fullMinutes
}
pure def canOpenRenewal(p: Period, invoiceId: str, planKey: PlanKey, startsAt: Millis, endsAt: Millis): bool =
  p.phase == PeriodUnopened and invoiceId != "" and isPaid(planKey) and validWindow(startsAt, endsAt)
pure def openRenewal(p: Period, invoiceId: str, planKey: PlanKey, startsAt: Millis, endsAt: Millis): Period =
  periodOf(RenewalInvoice({ invoiceId: invoiceId }), planKey, startsAt, endsAt, allowanceOf(planKey))
pure def canOpenGrantMonth(p: Period, grantId: str, month: int, planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): bool =
  p.phase == PeriodUnopened and grantId != "" and month >= 0 and isPaid(planKey) and validWindow(startsAt, endsAt) and endsAt <= fullEndsAt and grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) > 0
pure def openGrantMonth(p: Period, grantId: str, month: int, planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): Period =
  periodOf(GrantMonth({ grantId: grantId, month: month }), planKey, startsAt, endsAt, grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt))
pure val invoiceIdValues = Set("in_1")
pure val grantIdValues = Set("grant1")
pure val monthValues = Set(0, 1)
pure val startsAtValues = Set(0)
pure val endsAtValues = Set(600000, 1200000)
pure val fullEndsAtValues = Set(600000, 1200000)
pure def lawGrantMonthNeverExceedsTheMonthlyAllowance(planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): bool =
  (validWindow(startsAt, endsAt) and endsAt <= fullEndsAt) implies (grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) >= 0 and grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) <= allowanceOf(planKey))
pure def alwaysUnopenedPeriodIsEmpty(p: Period): bool = (p.phase == PeriodUnopened implies p == initial) and (p.phase != PeriodUnopened implies p.source != NoSource)
pure def alwaysOpenedPeriodIsPaid(p: Period): bool = p.phase != PeriodUnopened implies (isPaid(p.planKey) and p.granted >= 1 and validWindow(p.startsAt, p.endsAt))
pure def stepIdentityFixedOnceOpened(before: Period, after: Period): bool =
  before.phase != PeriodUnopened implies (after.source == before.source and after.startsAt == before.startsAt and after.endsAt == before.endsAt and after.granted == before.granted)
pure def sometimesPartialGrantMonth(p: Period): bool = isGrantMonth(p) and p.granted < allowanceOf(p.planKey)
```

### Every micro-dollar of a period is available, held, spent, expired or clawed back, and together they are its grant plus its adjustment

Only an open period has anything available.

```quint
pure def alwaysEveryMicroAccounted(p: Period): bool =
  p.granted >= 0 and p.adjustment >= 0 and p.available >= 0 and p.reserved >= 0 and p.settled >= 0 and p.expired >= 0 and p.clawedBack >= 0
  and p.available + p.reserved + p.settled + p.expired + p.clawedBack == p.granted + p.adjustment
pure def alwaysOnlyAnOpenPeriodHasAvailable(p: Period): bool = p.phase != PeriodOpen implies p.available == 0
```

### A hold takes allowance only from an open period whose window holds the call, and never more than is available

The shell offers a hold `spendableAt` as metering's `allowanceAvailable` when
the lane is `AllowanceThenCredits`, and reserves the hold's allowance part
here.

```quint
pure def spendableAt(p: Period, now: Millis): Micros = if (p.phase == PeriodOpen and now >= p.startsAt and now < p.endsAt) p.available else 0
pure def canReserveHold(p: Period, amount: Micros, now: Millis): bool = amount >= 1 and amount <= spendableAt(p, now)
pure def reserveHold(p: Period, amount: Micros, now: Millis): Period = { ...p, available: p.available - amount, reserved: p.reserved + amount }
pure val nowValues = Set(0, 300000, 600000, 1200000)
pure val amountValues = Set(1, 3)
```

### A finished hold spends what it used and returns the rest to the period only while it is open and has not ended

`held` is the hold's allowance part and `used` its allowance charge
(`allowanceCharge` of metering): 0 for a released hold. The rest of a hold
that finishes after the end, or after the period was retired, is forfeited;
after a clawback it is clawed back.

```quint
pure def canSettleHold(p: Period, held: Micros, used: Micros): bool = p.phase != PeriodUnopened and held >= 1 and held <= p.reserved and used >= 0 and used <= held
pure def settleHold(p: Period, held: Micros, used: Micros, now: Millis): Period = {
  val rest = held - used
  val back = p.phase == PeriodOpen and now < p.endsAt
  val clawed = p.phase == PeriodClawedBack
  { ...p, reserved: p.reserved - held, settled: p.settled + used,
    available: if (back) p.available + rest else p.available,
    clawedBack: if (clawed) p.clawedBack + rest else p.clawedBack,
    expired: if (not(back) and not(clawed)) p.expired + rest else p.expired }
}
pure val heldValues = Set(1, 2, 3)
pure val usedValues = Set(0, 1, 2)
pure def stepSpentAndForfeitedNeverReturn(before: Period, after: Period): bool = after.settled >= before.settled and after.expired >= before.expired
pure def sometimesAllowanceHeldAndSpent(p: Period): bool = p.phase == PeriodOpen and p.reserved > 0 and p.settled > 0
```

### At its end a period expires and its unused allowance is forfeited for good

```quint
pure def canExpire(p: Period, now: Millis): bool = p.phase == PeriodOpen and now >= p.endsAt
pure def expire(p: Period, now: Millis): Period = { ...p, phase: PeriodExpired, expired: p.expired + p.available, available: 0 }
pure def stepRetiredStaysRetired(before: Period, after: Period): bool = (before.phase == PeriodExpired or before.phase == PeriodClosed) implies after.phase == before.phase
pure def sometimesUnusedAllowanceForfeited(p: Period): bool = p.phase == PeriodExpired and p.settled > 0 and p.expired > 0
```

### A period closes early when its subscription ends, or when a paid plan supersedes or support revokes its grant

Closing forfeits what is available as expiry does; holds still finish.

```quint
type CloseReason = SubscriptionEnded | SupersededByPaid | GrantRevoked
pure def canClose(p: Period, closeReason: CloseReason): bool = p.phase == PeriodOpen and (if (closeReason == SubscriptionEnded) isRenewal(p) else isGrantMonth(p))
pure def close(p: Period, closeReason: CloseReason): Period = { ...p, phase: PeriodClosed, expired: p.expired + p.available, available: 0 }
pure def sometimesGrantMonthSuperseded(p: Period): bool = p.phase == PeriodClosed and isGrantMonth(p)
```

## Story: Get more allowance when I upgrade mid-period

> As a subscriber, I want an upgrade to add the difference in allowance for
> the part of the period that is left, so that I get what I paid the
> prorated price for.

### An upgrade adds the allowance difference prorated by whole minutes left, exactly the reviewed amount

The amount is `floor((target − previous) × minutesLeft / minutesInPeriod)`
µUSD, from the proration instant of the reviewed quote
(`spec/cloud/billing/subscriptionCommands.md`); counting minutes keeps the
product under 2^53. Posted after the period ended, it expires at once.

```quint
pure def upgradeAdjustment(previous: PlanKey, target: PlanKey, startsAt: Millis, endsAt: Millis, effectiveAt: Millis): Micros = {
  val totalMinutes = (endsAt - startsAt) / millisPerMinute
  val minutesLeft = (endsAt - effectiveAt) / millisPerMinute
  if (not(isUpgrade(previous, target)) or totalMinutes <= 0 or effectiveAt < startsAt or minutesLeft < 0) 0
  else (allowanceOf(target) - allowanceOf(previous)) * minutesLeft / totalMinutes
}
pure def canAdjustForUpgrade(p: Period, target: PlanKey, effectiveAt: Millis, reviewed: Micros): bool =
  isRenewal(p) and (p.phase == PeriodOpen or p.phase == PeriodExpired) and isUpgrade(p.planKey, target) and effectiveAt >= p.startsAt and effectiveAt < p.endsAt
  and reviewed == upgradeAdjustment(p.planKey, target, p.startsAt, p.endsAt, effectiveAt)
pure def adjustForUpgrade(p: Period, target: PlanKey, effectiveAt: Millis, reviewed: Micros, now: Millis): Period = {
  val spendable = p.phase == PeriodOpen and now < p.endsAt
  { ...p, planKey: target, adjustment: p.adjustment + reviewed,
    available: if (spendable) p.available + reviewed else p.available,
    expired: if (spendable) p.expired else p.expired + reviewed }
}
pure val effectiveAtValues = Set(0, 300000, 599999)
pure val reviewedValues = Set(0, 32500000, 65000000)
pure def lawUpgradeAddsAtMostTheDifference(previous: PlanKey, target: PlanKey, startsAt: Millis, endsAt: Millis, effectiveAt: Millis): bool =
  upgradeAdjustment(previous, target, startsAt, endsAt, effectiveAt) >= 0 and (isUpgrade(previous, target) implies upgradeAdjustment(previous, target, startsAt, endsAt, effectiveAt) <= allowanceOf(target) - allowanceOf(previous))
pure def lawUpgradeAtTheStartAddsTheWholeDifference(previous: PlanKey, target: PlanKey, startsAt: Millis, endsAt: Millis): bool =
  (isUpgrade(previous, target) and validWindow(startsAt, endsAt)) implies upgradeAdjustment(previous, target, startsAt, endsAt, startsAt) == allowanceOf(target) - allowanceOf(previous)
pure def alwaysAdjustedOnlyByARenewal(p: Period): bool = p.adjustment > 0 implies isRenewal(p)
pure def stepPlanNeverMovesDownMidPeriod(before: Period, after: Period): bool = rankOf(after.planKey) >= rankOf(before.planKey)
pure def sometimesUpgradedMidPeriod(p: Period): bool = p.phase == PeriodOpen and p.adjustment > 0 and p.planKey == ProMonthly
```

## Story: Lose the allowance of a refunded invoice, and get it back if I win the dispute

> As the operator, I want a refunded or disputed invoice to take back the
> allowance it paid for, and a won dispute to give it back, so that nobody
> spends an allowance they did not pay for.

### A refund or a dispute of the invoice claws back what is still available, and what its holds return

Only a renewal period is paid by an invoice; a grant month is never clawed
back. Charges already settled stay settled.

```quint
pure def canClawBack(p: Period, cause: ClawbackCause): bool = p.phase == PeriodOpen and isRenewal(p) and cause != NoClawback
pure def clawBack(p: Period, cause: ClawbackCause): Period = { ...p, phase: PeriodClawedBack, clawbackCause: cause, clawedBack: p.clawedBack + p.available, available: 0 }
pure def alwaysClawbackHasACause(p: Period): bool =
  ((p.phase == PeriodClawedBack) iff (p.clawbackCause != NoClawback)) and (p.phase == PeriodClawedBack implies isRenewal(p)) and (p.clawedBack > 0 implies p.phase == PeriodClawedBack)
pure def sometimesClawedBack(p: Period): bool = p.phase == PeriodClawedBack and p.clawedBack > 0
```

### A won dispute restores everything clawed back, but only before the period ends

A refund is never restored. A dispute won after the end leaves the period
clawed back: it would have expired anyway.

```quint
pure def canRestore(p: Period, now: Millis): bool = p.phase == PeriodClawedBack and p.clawbackCause == DisputeClawback and now < p.endsAt
pure def restore(p: Period, now: Millis): Period = { ...p, phase: PeriodOpen, clawbackCause: NoClawback, available: p.available + p.clawedBack, clawedBack: 0 }
```
