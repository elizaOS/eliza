# Metering

Every paid call (chat inference, batch and realtime speech, maps) runs over
one hold: the cloud reserves money before the call, marks it dispatched before
the provider is called, and settles it once. This spec owns the `Hold` machine
and the one lost-reply and replay policy; the services keep only validation,
quote, actual cost and admission order. `billing/funds` and `billing/allowance`
apply each hold step to the credit balance and the allowance period in the
same transaction. Sources are develop `packages/cloud/shared/src/lib/services/credits.ts`
(`reserve`, `reconcile`, `COST_BUFFER`) and the Quint models
`billing_reservations`, `billing_sweep` and `subscription_funding_reservations`.

One hold is one row keyed by its `HoldKey`. The shell loads the row, steps it
with the generated adapter and writes it back by compare-and-set; the 5 minute
sweep claims stale rows with `SKIP LOCKED`.

## Story: Never overdraw an account

> As an account owner, I want every paid call to hold money I have before it
> runs, my plan's allowance first, so that no call spends money I do not have.

### A hold reserves half again the quote, capped at what the funding lane offers

The quote is the service's estimate in µUSD. The hold is 150 % of it, at
least 1 µUSD, but never more than the lane offers, so a call the account can
pay at its quote still runs. A paid plan with an allowance funds through
`AllowanceThenCredits`; any other readable plan through `CreditsOnly`; an
unreadable plan is `Refused`.

```quint
import types.* from "./types"
type FundingLane = AllowanceThenCredits | CreditsOnly | Refused
type HoldPhase = Unfunded | Reserved | Dispatched | Settled | Released
type ChargeBasis = NotCharged | Measured | Quoted
type Hold = { phase: HoldPhase, key: HoldKey, quote: Micros, reserved: Micros, fromAllowance: Micros, fromCredits: Micros, charged: Micros, uncollected: Micros, basis: ChargeBasis, since: Millis }
type HoldSplit = { allowancePart: Micros, creditPart: Micros }
pure val holdMarginPercent: int = 150
pure def minOf(a: int, b: int): int = if (a < b) a else b
pure def maxOf(a: int, b: int): int = if (a > b) a else b
pure def reservedFor(quote: Micros): Micros = maxOf(quote * holdMarginPercent / 100, 1)
pure def laneOffers(lane: FundingLane, allowanceAvailable: Micros, creditAvailable: Micros): Micros =
  if (lane == AllowanceThenCredits) allowanceAvailable + creditAvailable
  else if (lane == CreditsOnly) creditAvailable
  else 0
pure def fundable(lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): bool =
  lane != Refused and quote >= 1 and allowanceAvailable >= 0 and creditAvailable >= 0 and laneOffers(lane, allowanceAvailable, creditAvailable) >= quote
pure def holdAmount(lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): Micros =
  minOf(reservedFor(quote), laneOffers(lane, allowanceAvailable, creditAvailable))
pure def lawHoldCoversQuoteWithinOffer(lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): bool =
  fundable(lane, quote, allowanceAvailable, creditAvailable) implies (holdAmount(lane, quote, allowanceAvailable, creditAvailable) >= quote and holdAmount(lane, quote, allowanceAvailable, creditAvailable) <= laneOffers(lane, allowanceAvailable, creditAvailable))
pure val quoteValues = Set(1, 2, 3, 4)
pure val allowanceAvailableValues = Set(0, 2, 5)
pure val creditAvailableValues = Set(0, 1, 3, 6)
```

### The allowance pays first, credits pay the rest, and neither part exceeds what it offers

`CreditsOnly` never touches the allowance. Settlement charges the allowance
part first as well (`allowanceCharge`), and only credits pay beyond the hold.

```quint
pure def splitHold(lane: FundingLane, reserved: Micros, allowanceAvailable: Micros): HoldSplit =
  if (lane == AllowanceThenCredits) { allowancePart: minOf(allowanceAvailable, reserved), creditPart: reserved - minOf(allowanceAvailable, reserved) }
  else { allowancePart: 0, creditPart: reserved }
pure def lawSplitStaysWithinEachSource(lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): bool = {
  val reserved = holdAmount(lane, quote, allowanceAvailable, creditAvailable)
  val parts = splitHold(lane, reserved, allowanceAvailable)
  fundable(lane, quote, allowanceAvailable, creditAvailable) implies (parts.allowancePart + parts.creditPart == reserved and parts.allowancePart >= 0 and parts.allowancePart <= allowanceAvailable and parts.creditPart >= 0 and parts.creditPart <= creditAvailable)
}
pure def lawCreditsOnlyAfterTheAllowance(quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): bool = {
  val parts = splitHold(AllowanceThenCredits, holdAmount(AllowanceThenCredits, quote, allowanceAvailable, creditAvailable), allowanceAvailable)
  (fundable(AllowanceThenCredits, quote, allowanceAvailable, creditAvailable) and parts.creditPart > 0) implies parts.allowancePart == allowanceAvailable
}
pure def allowanceCharge(h: Hold): Micros = minOf(h.charged, h.fromAllowance)
pure def creditCharge(h: Hold): Micros = h.charged - allowanceCharge(h)
```

### A fresh key is admitted exactly when its hold can be reserved, and a known key answers its existing hold

This is the one replay policy. The shell looks the key up in the same
transaction: a known key answers the existing hold unchanged, whatever its
funding now. An unfunded fresh key is refused `402 insufficient_credits`; an
unreadable plan `503 service_unavailable`. No row is written for a refusal.

```quint
type Admission = AdmitHold | ReplayHold | RefuseUnreadable | RefuseShort
pure def admission(known: bool, lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): Admission =
  if (known) ReplayHold
  else if (lane == Refused) RefuseUnreadable
  else if (fundable(lane, quote, allowanceAvailable, creditAvailable)) AdmitHold
  else RefuseShort
pure def refusalOf(a: Admission): Refusal = if (a == RefuseUnreadable) refuse(ServiceUnavailable) else refuse(InsufficientCredits)
pure val initial: Hold = { phase: Unfunded, key: { service: MeteredInference, requestId: "", part: Whole }, quote: 0, reserved: 0, fromAllowance: 0, fromCredits: 0, charged: 0, uncollected: 0, basis: NotCharged, since: 0 }
pure def canReserve(h: Hold, quote: Micros, lane: FundingLane, allowanceAvailable: Micros, creditAvailable: Micros, now: Millis): bool =
  h.phase == Unfunded and now >= 0 and fundable(lane, quote, allowanceAvailable, creditAvailable)
pure def reserve(h: Hold, key: HoldKey, quote: Micros, lane: FundingLane, allowanceAvailable: Micros, creditAvailable: Micros, now: Millis): Hold = {
  val reserved = holdAmount(lane, quote, allowanceAvailable, creditAvailable)
  val parts = splitHold(lane, reserved, allowanceAvailable)
  { ...h, phase: Reserved, key: key, quote: quote, reserved: reserved, fromAllowance: parts.allowancePart, fromCredits: parts.creditPart, since: now }
}
pure def lawAdmittedExactlyWhenReservable(lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): bool =
  (admission(false, lane, quote, allowanceAvailable, creditAvailable) == AdmitHold) iff canReserve(initial, quote, lane, allowanceAvailable, creditAvailable, 0)
pure def lawEveryAdmissionRefusalIsWellFormed(lane: FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros): bool = {
  val a = admission(false, lane, quote, allowanceAvailable, creditAvailable)
  a != AdmitHold implies (wellFormed(refusalOf(a)) and (statusOf(refusalOf(a).code) == 402 or a == RefuseUnreadable))
}
pure val keyValues = Set({ service: MeteredInference, requestId: "r1", part: Whole }, { service: MeteredSpeech, requestId: "s1", part: Window({ direction: Stt, window: 1 }) })
pure val nowValues = Set(0, 900000, 8100000)
```

### A reserved hold is split exactly into its allowance and credit parts and covers its quote

```quint
pure def alwaysUnfundedHoldsNothing(h: Hold): bool =
  h.phase == Unfunded implies (h.quote == 0 and h.reserved == 0 and h.fromAllowance == 0 and h.fromCredits == 0 and h.since == 0)
pure def alwaysHoldSplitsExactly(h: Hold): bool =
  h.phase != Unfunded implies (h.quote >= 1 and h.reserved >= h.quote and h.fromAllowance >= 0 and h.fromCredits >= 0 and h.fromAllowance + h.fromCredits == h.reserved and h.since >= 0)
pure def stepTermsFixedOnceReserved(before: Hold, after: Hold): bool =
  before.phase != Unfunded implies (after.key == before.key and after.quote == before.quote and after.reserved == before.reserved and after.fromAllowance == before.fromAllowance and after.fromCredits == before.fromCredits)
pure def sometimesAllowanceAndCreditsShareAHold(h: Hold): bool = h.fromAllowance > 0 and h.fromCredits > 0
```

## Story: Settle every call once

> As an account owner, I want every paid call charged once, for what it cost
> when that is known and for its quote when the reply was lost, so that I
> never pay twice and never pay for a call that never reached a provider.

### A call reaches its provider only after its hold is durably marked dispatched

The shell commits `markDispatched` before the first provider byte; a crash
before that commit leaves a hold that was never dispatched.

```quint
pure def canMarkDispatched(h: Hold, now: Millis): bool = h.phase == Reserved and now >= h.since
pure def markDispatched(h: Hold, now: Millis): Hold = { ...h, phase: Dispatched, since: now }
pure def mayCallProvider(h: Hold): bool = h.phase == Dispatched
pure def sometimesDispatched(h: Hold): bool = h.phase == Dispatched
```

### A known outcome charges the actual cost, beyond the hold only from free credits, and leaves the rest uncollected

`creditFree` is the credit balance not held by any hold at settlement. A
provider refusal with no output is a known outcome of 0.

```quint
pure def canSettleKnown(h: Hold, actual: Micros, creditFree: Micros): bool = h.phase == Dispatched and actual >= 0 and creditFree >= 0
pure def settleKnown(h: Hold, actual: Micros, creditFree: Micros): Hold = {
  val charged = minOf(actual, h.reserved + creditFree)
  { ...h, phase: Settled, basis: Measured, charged: charged, uncollected: actual - charged }
}
pure val actualValues = Set(0, 1, 3, 9)
pure val creditFreeValues = Set(0, 2)
pure def alwaysUncollectedOnlyBeyondTheHold(h: Hold): bool = h.uncollected > 0 implies (h.basis == Measured and h.charged >= h.reserved)
pure def sometimesRefundedPart(h: Hold): bool = h.basis == Measured and h.charged > 0 and h.charged < h.reserved
pure def sometimesOverageCollected(h: Hold): bool = h.basis == Measured and h.charged > h.reserved and h.uncollected == 0
pure def sometimesOverageUncollected(h: Hold): bool = h.uncollected > 0
```

### A dispatched call whose outcome is unknown is charged its quote, and one never dispatched is charged nothing

`settleUnknown` is the lost-reply policy (timeout, network failure, client
gone after dispatch without a reported usage); `release` ends a hold that
never reached a provider (validation failure, client gone before dispatch).

```quint
pure def canSettleUnknown(h: Hold): bool = h.phase == Dispatched
pure def settleUnknown(h: Hold): Hold = { ...h, phase: Settled, basis: Quoted, charged: h.quote, uncollected: 0 }
pure def canRelease(h: Hold): bool = h.phase == Reserved
pure def release(h: Hold): Hold = { ...h, phase: Released }
pure def alwaysChargeMatchesPhase(h: Hold): bool =
  h.charged >= 0 and h.uncollected >= 0 and (h.phase == Settled iff h.basis != NotCharged) and (h.phase != Settled implies (h.charged == 0 and h.uncollected == 0)) and (h.basis == Quoted implies (h.charged == h.quote and h.uncollected == 0))
pure def stepChargedOnlyAfterDispatch(before: Hold, after: Hold): bool = (after.phase == Settled and before.phase != Settled) implies before.phase == Dispatched
pure def sometimesLostReplyChargedItsQuote(h: Hold): bool = h.basis == Quoted
pure def sometimesReleasedUncharged(h: Hold): bool = h.phase == Released
```

### A settled or released hold never changes again

A second writer (the request and the sweep race) finds the hold terminal
and moves no money.

```quint
pure def stepTerminalIsFinal(before: Hold, after: Hold): bool = (before.phase == Settled or before.phase == Released) implies after == before
```

### The sweep releases a hold reserved 15 minutes ago and charges the quote of one dispatched 2 hours ago

```quint
type SweepAction = SweepNothing | SweepRelease | SweepSettleUnknown
pure val reservedTimeout: Millis = 15 * millisPerMinute
pure val dispatchedTimeout: Millis = 2 * millisPerHour
pure def sweepActionFor(h: Hold, now: Millis): SweepAction =
  if (h.phase == Reserved and now - h.since >= reservedTimeout) SweepRelease
  else if (h.phase == Dispatched and now - h.since >= dispatchedTimeout) SweepSettleUnknown
  else SweepNothing
pure def canSweep(h: Hold, now: Millis): bool = sweepActionFor(h, now) != SweepNothing
pure def sweep(h: Hold, now: Millis): Hold = if (sweepActionFor(h, now) == SweepRelease) release(h) else settleUnknown(h)
```
