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

### Funds hold a balance, the part of it held for live calls, and the totals added and collected

All amounts are µUSD. `availableCredits` is what a new hold may take and
what metering reads as `creditAvailable` at reserve and `creditFree` at
settlement.

```quint
import types.* from "../shared/types"
import metering as M from "../shared/metering"
type Funds = { creditBalance: Micros, creditHeld: Micros, added: Micros, collected: Micros, requests: Set[str] }
pure val initial: Funds = { creditBalance: 0, creditHeld: 0, added: 0, collected: 0, requests: Set() }
pure def availableCredits(f: Funds): Micros = f.creditBalance - f.creditHeld
```

### The operator adds credits once per request

Each `credits add` carries a request id stored with the row. Repeating a
request already applied changes nothing, so a retried command never funds an
account twice; the shell answers it with the entry it wrote the first time.

```quint
pure val amountValues = Set(1, 2, 5)
pure val requestValues = Set("op1", "op2")
pure def canAddCredits(f: Funds, request: str, amount: Micros): bool = request != "" and amount >= 1
pure def addCredits(f: Funds, request: str, amount: Micros): Funds =
  if (f.requests.contains(request)) f
  else { ...f, creditBalance: f.creditBalance + amount, added: f.added + amount, requests: f.requests.union(Set(request)) }
pure def lawARepeatedRequestAddsNothing(request: str, amount: Micros): bool = {
  val once = addCredits(initial, request, amount)
  canAddCredits(initial, request, amount) implies (addCredits(once, request, amount).creditBalance == once.creditBalance and once.creditBalance == amount)
}
pure def sometimesFunded(f: Funds): bool = f.creditBalance > 0 and f.creditHeld == 0
```

### A hold takes only credits that no other hold keeps back

The credit part of a hold (`fromCredits` of metering's `Hold`) is kept back
until its call settles. A hold with no credit part needs no step here.

```quint
pure val fromCreditsValues = Set(0, 1, 2, 3)
pure def canHoldCredits(f: Funds, fromCredits: Micros): bool = fromCredits >= 1 and fromCredits <= availableCredits(f)
pure def holdCredits(f: Funds, fromCredits: Micros): Funds = { ...f, creditHeld: f.creditHeld + fromCredits }
pure def sometimesAllCreditsHeld(f: Funds): bool = f.creditBalance > 0 and f.creditHeld == f.creditBalance
```

### A settle frees the held part and debits the credit charge, which never exceeds the freed part and the available credits

`charged` is metering's `creditCharge` of the settled hold (0 for a
release). The shell passes metering the `availableCredits` of this row as
`creditFree`, so the charge always fits; a charge that does not is a defect
and rolls the transaction back, it is never clipped.

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
pure def lawMeteredChargeFitsTheFunds(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, actual: Micros, creditFree: Micros): bool = {
  val reserved = M::reserve(M::initial, M::initial.key, quote, lane, allowanceAvailable, creditAvailable, 0)
  val dispatched = M::markDispatched(reserved, 0)
  val known = M::creditCharge(M::settleKnown(dispatched, actual, creditFree))
  val lost = M::creditCharge(M::settleUnknown(dispatched))
  (M::fundable(lane, quote, allowanceAvailable, creditAvailable) and actual >= 0 and creditFree >= 0) implies
    (known >= 0 and known <= reserved.fromCredits + creditFree and lost >= 0 and lost <= reserved.fromCredits)
}
```

### The balance never goes below zero and never below what is held

```quint
pure def alwaysNeverOverdrawn(f: Funds): bool = f.creditHeld >= 0 and f.creditHeld <= f.creditBalance
```

### The balance is always what the operator added less what calls collected

```quint
pure def alwaysBalanceIsAddedLessCollected(f: Funds): bool = f.collected >= 0 and f.creditBalance == f.added - f.collected
```

### Only an operator add raises the balance and only a settle lowers it

A hold keeps money back without moving it.

```quint
pure def stepBalanceMovesOnlyByAddOrSettle(before: Funds, via: str, after: Funds): bool =
  (after.creditBalance > before.creditBalance implies via == "addCredits") and (after.creditBalance < before.creditBalance implies via == "settleCredits")
```
