# Plan allowance

The money a paid plan includes each period, spent before credits and never
carried over. One `Period` is one row: a paid renewal invoice opens one, keyed
by the invoice id, and each month of a grant opens one, keyed by the grant id
and the month number (`spec/cloud/billing/grantCodes.md`). The store key of a
renewal also holds the provider environment, a column the shell adds: one
deployment runs in one environment. Holds take their allowance part from the
period that covers the call (`spec/cloud/shared/metering.md`), in the same
transaction as the hold step. Sources are develop's
`subscription-allowance.ts`, `subscription-grants.ts` and the upgrade
allowance posting; develop's app-scoped periods, trial claims and import
entries are gone.

The shell keeps the calendar: it computes each grant month's bounds by UTC
calendar months and passes them in. An event whose guard refuses it moves
nothing.

## Story: Spend my plan's allowance before my credits, and never carry it over

> As a subscriber, I want each period's allowance spent before my credits and
> forfeited when the period ends, so that my credits pay only for what my
> plan does not.

### A period opens once, from a paid invoice with its plan's allowance or from a grant month with its share of it

A grant's last month may be partial: it gets the monthly allowance prorated
by whole minutes of the full calendar month, rounded down; a month whose share
rounds to nothing opens no period. A free plan opens nothing. A period opened
at or after its end (an invoice settled late) expires in the same
transaction, so it never shows an open balance.

```quint
import types.* from "../shared/types"
import plans.* from "./plans"
import metering as M from "../shared/metering"
type PeriodPhase = PeriodUnopened | PeriodOpen | PeriodExpired | PeriodClosed | PeriodDisputed | PeriodRefunded
type PeriodSource = NoSource | RenewalInvoice({ invoiceId: str }) | GrantMonth({ grantId: str, month: int })
type Period = { phase: PeriodPhase, source: PeriodSource, planKey: PlanKey, startsAt: Millis, endsAt: Millis, granted: Micros, adjustment: Micros, available: Micros, reserved: Micros, settled: Micros, expired: Micros, clawedBack: Micros }
pure val initial: Period = { phase: PeriodUnopened, source: NoSource, planKey: Free, startsAt: 0, endsAt: 0, granted: 0, adjustment: 0, available: 0, reserved: 0, settled: 0, expired: 0, clawedBack: 0 }
pure def isRenewal(p: Period): bool = { val src = p.source
  match src { | RenewalInvoice(x) => true | _ => false } }
pure def isGrantMonth(p: Period): bool = { val src = p.source
  match src { | GrantMonth(x) => true | _ => false } }
pure def totalGranted(p: Period): Micros = p.granted + p.adjustment
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
pure val invoiceIdValues = Set("in_1")
pure def canOpenGrantMonth(p: Period, grantId: str, month: int, planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): bool =
  p.phase == PeriodUnopened and grantId != "" and month >= 0 and isPaid(planKey) and validWindow(startsAt, endsAt) and endsAt <= fullEndsAt and grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) > 0
pure def openGrantMonth(p: Period, grantId: str, month: int, planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): Period =
  periodOf(GrantMonth({ grantId: grantId, month: month }), planKey, startsAt, endsAt, grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt))
pure val grantIdValues = Set("grant1")
pure val monthValues = Set(0, 1)
pure val startsAtValues = Set(0)
pure val endsAtValues = Set(600000, 1200000)
pure val fullEndsAtValues = Set(600000, 1200000)
pure def lawGrantMonthNeverExceedsTheMonthlyAllowance(planKey: PlanKey, startsAt: Millis, endsAt: Millis, fullEndsAt: Millis): bool =
  (validWindow(startsAt, endsAt) and endsAt <= fullEndsAt) implies (grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) >= 0 and grantMonthAllowance(planKey, startsAt, endsAt, fullEndsAt) <= allowanceOf(planKey))
pure def alwaysUnopenedPeriodIsEmpty(p: Period): bool = (p.phase == PeriodUnopened implies p == initial) and (p.phase != PeriodUnopened implies p.source != NoSource)
pure def alwaysOpenedPeriodIsPaid(p: Period): bool = p.phase != PeriodUnopened implies (isPaid(p.planKey) and p.granted >= 1 and validWindow(p.startsAt, p.endsAt))
pure def sometimesPartialGrantMonth(p: Period): bool = isGrantMonth(p) and p.granted < allowanceOf(p.planKey)
```

### A lifetime grant keeps its current month and the next two opened, and a missed month never opens

The hourly allowance sweep, beside expiry, serves each active account whose
lifetime grant has started and is not revoked, when no month of that grant
ends more than 35 days ahead. The shell counts `currentMonth`, the whole UTC
months from the grant start to now, and opens each due month that has no
period yet with `openGrantMonth`.

```quint
pure def lifetimeMonthsDue(currentMonth: int): Set[int] = Set(currentMonth).union(Set(currentMonth + 1)).union(Set(currentMonth + 2))
pure def lifetimeSweepDue(lastMonthEndsAt: Millis, now: Millis): bool = lastMonthEndsAt <= now + 35 * millisPerDay
pure val currentMonthValues = Set(0, 4)
pure def lawAMissedMonthNeverOpens(currentMonth: int, month: int): bool = month < currentMonth implies not(lifetimeMonthsDue(currentMonth).contains(month))
```

### Every micro-dollar of a period is available, held, spent, expired or clawed back, and together they are its grant plus its adjustment

```quint
pure def alwaysEveryMicroAccounted(p: Period): bool =
  p.granted >= 0 and p.adjustment >= 0 and p.available >= 0 and p.reserved >= 0 and p.settled >= 0 and p.expired >= 0 and p.clawedBack >= 0
  and p.available + p.reserved + p.settled + p.expired + p.clawedBack == totalGranted(p)
```

### Only an open period has allowance available

```quint
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

`held` is the hold's allowance part and `used` its allowance charge, both read
from the metering hold: `used` is 0 for a released hold. The rest of a hold
that finishes after the end, or after the period was retired, is forfeited;
after a clawback it is clawed back.

```quint
pure def isClawedBack(p: Period): bool = p.phase == PeriodDisputed or p.phase == PeriodRefunded
pure def heldOf(h: M::Hold): Micros = h.fromAllowance
pure def usedOf(h: M::Hold): Micros = M::allowanceCharge(h)
pure def canSettleHold(p: Period, held: Micros, used: Micros): bool = p.phase != PeriodUnopened and held >= 1 and held <= p.reserved and used >= 0 and used <= held
pure def settleHold(p: Period, held: Micros, used: Micros, now: Millis): Period = {
  val rest = held - used
  val back = p.phase == PeriodOpen and now < p.endsAt
  val clawed = isClawedBack(p)
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

### A renewal opens only after each open period of the organization that overlaps it is closed

In the same transaction, before it opens, each open grant month that overlaps
the renewal closes with `SupersededByPaid` (later grant months stay open for
after the paid plan ends), and an overlapping renewal of an ended
subscription closes with `SubscriptionEnded`. Any other overlap refuses the
renewal with `409 billing_state_conflict`. Grant months are not checked
against a paid period; the effective plan of `spec/cloud/billing/entitlements.md`
names the period that funds a call.

```quint
type OverlapStep = OpenBeside | CloseFirst({ closeReason: CloseReason }) | OverlapConflict
pure def overlaps(a: Period, b: Period): bool = a.startsAt < b.endsAt and b.startsAt < a.endsAt
pure def renewalOverlapStep(other: Period, renewal: Period, otherSubscriptionEnded: bool): OverlapStep =
  if (other.phase != PeriodOpen or not(overlaps(other, renewal))) OpenBeside
  else if (isGrantMonth(other)) CloseFirst({ closeReason: SupersededByPaid })
  else if (isRenewal(other) and otherSubscriptionEnded) CloseFirst({ closeReason: SubscriptionEnded })
  else OverlapConflict
pure val otherValues: Set[Period] = {
  val month = periodOf(GrantMonth({ grantId: "grant1", month: 0 }), PlusMonthly, 0, 600000, 25000000)
  val renewal = periodOf(RenewalInvoice({ invoiceId: "in_0" }), PlusMonthly, 0, 600000, 25000000)
  Set(month).union(Set(renewal)).union(Set({ ...renewal, phase: PeriodExpired, available: 0, expired: 25000000 })).union(Set({ ...month, startsAt: 600000, endsAt: 1200000 }))
}
pure val renewalValues: Set[Period] = Set(periodOf(RenewalInvoice({ invoiceId: "in_1" }), ProMonthly, 0, 600000, 90000000))
pure val otherSubscriptionEndedValues = Set(true, false)
pure def lawARenewalClosesOnlyWhatMayClose(other: Period, renewal: Period, otherSubscriptionEnded: bool): bool = {
  val decided = renewalOverlapStep(other, renewal, otherSubscriptionEnded)
  match decided { | CloseFirst(x) => canClose(other, x.closeReason) and overlaps(other, renewal) | _ => true }
}
```

## Story: Get more allowance when I upgrade mid-period

> As a subscriber, I want an upgrade to add the difference in allowance for
> the part of the period that is left, so that I get what I paid the
> prorated price for.

### An upgrade adds the allowance difference prorated by whole minutes left, exactly the reviewed amount

The amount is `floor((target − previous) × minutesLeft / minutesInPeriod)`
µUSD, from the proration instant of the reviewed quote
(`spec/cloud/billing/subscriptionCommands.md`); counting minutes keeps the
product under 2^53. Posted after the period ended or was retired, it expires
at once.

```quint
pure def upgradeAdjustment(previous: PlanKey, target: PlanKey, startsAt: Millis, endsAt: Millis, effectiveAt: Millis): Micros = {
  val totalMinutes = (endsAt - startsAt) / millisPerMinute
  val minutesLeft = (endsAt - effectiveAt) / millisPerMinute
  if (not(isUpgrade(previous, target)) or totalMinutes <= 0 or effectiveAt < startsAt or minutesLeft < 0) 0
  else (allowanceOf(target) - allowanceOf(previous)) * minutesLeft / totalMinutes
}
pure def canAdjustForUpgrade(p: Period, target: PlanKey, effectiveAt: Millis, reviewed: Micros): bool =
  isRenewal(p) and p.phase != PeriodUnopened and isUpgrade(p.planKey, target) and effectiveAt >= p.startsAt and effectiveAt < p.endsAt
  and reviewed >= 0 and reviewed == upgradeAdjustment(p.planKey, target, p.startsAt, p.endsAt, effectiveAt)
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
pure def sometimesUpgradedMidPeriod(p: Period): bool = p.phase == PeriodOpen and p.adjustment > 0
pure def sometimesLateUpgradeForfeited(p: Period): bool = p.phase == PeriodExpired and p.adjustment > 0 and p.expired >= p.adjustment
```

## Story: Lose the allowance of a refunded invoice, and get it back if I win the dispute

> As the operator, I want a refunded or disputed invoice to take back the
> allowance it paid for, and a won dispute to give it back, so that nobody
> spends an allowance they did not pay for.

### A refund or a dispute of the invoice claws back what is still available, and what its holds return

The invoices of a period are its renewal invoice and each upgrade invoice
applied to it, found by the subscription and the proration instant; a refund
or a dispute of either claws back the period. A grant month is never clawed
back. Charges already settled stay settled. A refund after a dispute makes
the clawback final. A period already retired takes nothing: the guard
refuses, and `spec/cloud/billing/providerEvents.md` marks the event done.

```quint
type ClawbackCause = RefundClawback | DisputeClawback
pure def canClawBack(p: Period, cause: ClawbackCause): bool =
  isRenewal(p) and (p.phase == PeriodOpen or (p.phase == PeriodDisputed and cause == RefundClawback))
pure def clawBack(p: Period, cause: ClawbackCause): Period =
  { ...p, phase: if (cause == RefundClawback) PeriodRefunded else PeriodDisputed, clawedBack: p.clawedBack + p.available, available: 0 }
pure def alwaysOnlyARenewalIsClawedBack(p: Period): bool = (isClawedBack(p) implies isRenewal(p)) and (p.clawedBack > 0 implies isClawedBack(p))
pure def sometimesClawedBack(p: Period): bool = p.phase == PeriodRefunded and p.clawedBack > 0
pure def sometimesDisputed(p: Period): bool = p.phase == PeriodDisputed and p.clawedBack > 0
```

### A refunded period stays refunded

```quint
pure def stepARefundIsFinal(before: Period, after: Period): bool = before.phase == PeriodRefunded implies after.phase == PeriodRefunded
```

### A won dispute restores everything clawed back, but only before the period ends

A dispute won after the end leaves the period disputed: it would have
expired anyway.

```quint
pure def canRestore(p: Period, now: Millis): bool = p.phase == PeriodDisputed and now < p.endsAt
pure def restore(p: Period, now: Millis): Period = { ...p, phase: PeriodOpen, available: p.available + p.clawedBack, clawedBack: 0 }
pure def stepOnlyAWonDisputeReopens(before: Period, via: str, after: Period): bool =
  (before.phase == PeriodDisputed and after.phase == PeriodOpen) implies (via == "restore" and after.available == before.available + before.clawedBack and after.clawedBack == 0)
```
