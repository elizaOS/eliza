# Funds

An organization's credit balance and the part of it that live holds keep
back. One `Funds` row per organization, keyed by the organization id. Sources
are develop `packages/cloud/shared/src/lib/services/credits.ts` (the balance,
the reservation deducted at reserve, the settle that never goes below zero)
and the balance part of the old `spec/cloud/credits.md`.

Credits are never sold in the app: the operator adds them
(`elizaos-cloud credits add`), and a plan allowance, owned by
`spec/cloud/billing/allowance.md`, pays first. There is no credit purchase,
refund or dispute clawback, so nothing but a settled call lowers the balance.
Each step here is applied in the same transaction as the
[metering](../shared/metering.md) `Hold` step it mirrors: `holdCredits` with
`reserve`, `settleCredits` with `settleKnown`, `settleUnknown`, `release` and the
sweep (a release settles a charge of 0). The derived column
`organizations.credit_balance` and the snapshot's `balance.usdMicros` are
`availableCredits`, as develop showed a balance with its reservations already
taken out.

## Story: Spend only money the account has

> As an account owner, I want every call to spend only credits my account
> has and no other call holds, and my balance to change only when the
> operator funds it or a call is settled, so that I can trust the balance I
> see.

### A new organization starts with no credits and nothing held

All amounts are µUSD. `availableCredits` is what a new hold may take and
what metering reads as `creditAvailable` at reserve and `creditFree` at
settlement.

```quint
import types.* from "../shared/types"
import metering as M from "../shared/metering"
type Funds = { creditBalance: Micros, creditHeld: Micros, collected: Micros }
pure val initial: Funds = { creditBalance: 0, creditHeld: 0, collected: 0 }
pure def availableCredits(f: Funds): Micros = f.creditBalance - f.creditHeld
```

### The operator adds credits once per request

Each `credits add` carries a non-empty request id and at least 1 µUSD;
anything else is refused with `InvalidRequest` before the ledger is read.
The `credit_entries` ledger owns the id through a unique request key, and the
shell looks it up in the same transaction and steps `addCredits` only on
`ApplyAdd`: a fresh id adds and writes one entry, a known id with the same
amount answers the first entry and steps nothing, and a known id with
another amount is refused with `IdempotencyConflict`. The guard refuses a
known id, so a retried command never funds an account twice.

```quint
type AddDecision = ApplyAdd | AnswerFirstEntry | RefuseMismatchedReplay
pure def addDecision(known: bool, firstAmount: Micros, amount: Micros): AddDecision =
  if (not(known)) ApplyAdd else if (firstAmount == amount) AnswerFirstEntry else RefuseMismatchedReplay
pure val amountValues = Set(0, 1, 2, 5)
pure val knownValues = Set(false, true)
pure def canAddCredits(f: Funds, known: bool, amount: Micros): bool = amount >= 1 and addDecision(known, amount, amount) == ApplyAdd
pure def addCredits(f: Funds, known: bool, amount: Micros): Funds = { ...f, creditBalance: f.creditBalance + amount }
pure def sometimesFunded(f: Funds): bool = f.creditBalance > 0 and f.creditHeld == 0
```

### A hold takes only credits that no other hold keeps back

The credit part of a hold (`fromCredits` of metering's `Hold`) is kept back
until its call settles. A hold with no credit part steps nothing here.

```quint
pure val fromCreditsValues = Set(0, 1, 2, 3)
pure def canHoldCredits(f: Funds, fromCredits: Micros): bool = fromCredits >= 1 and fromCredits <= availableCredits(f)
pure def holdCredits(f: Funds, fromCredits: Micros): Funds = { ...f, creditHeld: f.creditHeld + fromCredits }
pure def sometimesAllCreditsHeld(f: Funds): bool = f.creditBalance > 0 and f.creditHeld == f.creditBalance
```

### A settle frees its held part and debits a charge that fits the freed part and the free credits

`charged` is metering's `creditCharge` of the settled hold (0 for a
release). The shell passes metering the `availableCredits` of this row as
`creditFree`, so the charge always fits; a charge that does not is a defect
and rolls the transaction back, it is never clipped here. The clip is
metering's `settleKnown` through `creditFree`; clipping to `creditBalance`
instead would spend credits that other holds keep back (changed from the
plan's `min(charged, creditBalance)`). Every settle with a `creditCharge`
above 0 steps `settleCredits`, also for a hold with no credit part
(`fromCredits` 0, overage of an allowance-paid hold); only such a hold that
settles with no credit charge steps nothing. `collected`, the total debited,
witnesses spending for the goals below.

```quint
pure val chargedValues = Set(0, 1, 2, 4)
pure def canSettleCredits(f: Funds, fromCredits: Micros, charged: Micros): bool =
  fromCredits >= 0 and fromCredits <= f.creditHeld and charged >= 0 and charged <= availableCredits(f) + fromCredits
pure def settleCredits(f: Funds, fromCredits: Micros, charged: Micros): Funds =
  { ...f, creditHeld: f.creditHeld - fromCredits, creditBalance: f.creditBalance - charged, collected: f.collected + charged }
pure def sometimesSpentDown(f: Funds): bool = f.collected > 0 and f.creditBalance == 0
pure def sometimesSettledWhileAnotherHolds(f: Funds): bool = f.collected > 0 and f.creditHeld > 0
```

### Metering never charges credits beyond the freed hold and the available credits

This is why `canSettleCredits` never refuses a settle the
shell derived from metering. A known outcome charges the allowance part
first and credits beyond the hold only from `creditFree`; a lost reply
charges its quote, which the hold covers.

```quint
pure val quoteValues = Set(0, 1, 3)
pure val allowanceAvailableValues = Set(0, 2)
pure val creditAvailableValues = Set(0, 1, 3)
pure val actualValues = Set(0, 1, 9)
pure val creditFreeValues = Set(0, 2)
pure def lawMeteredChargeFitsTheFunds(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, actual: Micros, creditFree: Micros): bool = {
  val reserved = M::reserve(M::initial, M::initial.key, quote, lane, allowanceAvailable, creditAvailable, 0)
  val dispatched = M::markDispatched(reserved, 0)
  val known = M::creditCharge(M::settleKnown(dispatched, actual, creditFree))
  val lost = M::creditCharge(M::settleUnknown(dispatched))
  (M::fundable(lane, quote, allowanceAvailable, creditAvailable) and actual >= 0 and creditFree >= 0) implies
    (known >= 0 and known <= reserved.fromCredits + creditFree and lost >= 0 and lost <= reserved.fromCredits)
}
```

### The balance never goes below what is held, and nothing held or collected is negative

```quint
pure def alwaysNeverOverdrawn(f: Funds): bool = f.creditHeld >= 0 and f.creditHeld <= f.creditBalance and f.collected >= 0
```

### Only an operator add raises the balance and only a settle lowers it

A hold keeps money back without moving it.

```quint
pure def stepBalanceMovesOnlyByAddOrSettle(before: Funds, via: str, after: Funds): bool =
  (after.creditBalance > before.creditBalance implies via == "addCredits") and (after.creditBalance < before.creditBalance implies via == "settleCredits")
```
