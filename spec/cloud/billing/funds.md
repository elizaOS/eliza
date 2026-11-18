# Funds

An organization's credit balance and the part of it that live holds keep
back: one `Funds` row per organization, keyed by the organization id. Each
hold or settle step runs in the same transaction as the
[metering](../shared/metering.md) `Hold` step it mirrors. The derived column
`organizations.credit_balance` and the snapshot's `balance.usdMicros` are
`availableCredits`. Source: develop
`packages/cloud/shared/src/lib/services/credits.ts`.

Credits are never sold in the app: the operator adds them and a plan
allowance (`billing/allowance`) pays first. There is no purchase, refund or
clawback, so only a settled call lowers the balance.

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

### A fresh request id adds credits, a replay with the same amount answers the first entry, and any other replay is refused

`prior` is the ledger entry already written under the request id, if any.
An amount below 1 µUSD is `InvalidRequest`; a known id with another amount is
`IdempotencyConflict`. Only `ApplyAdd` steps `addCredits`; the shell writes the
ledger entry under the request id in the same transaction.

```quint
type PriorEntry = NoEntry | EntryOf({ amount: Micros })
type AddDecision = ApplyAdd | AnswerFirstEntry | RefuseAdd({ code: RefusalCode })
pure def addDecision(prior: PriorEntry, amount: Micros): AddDecision =
  if (amount < 1) RefuseAdd({ code: InvalidRequest })
  else match prior { | NoEntry => ApplyAdd | EntryOf(e) => if (e.amount == amount) AnswerFirstEntry else RefuseAdd({ code: IdempotencyConflict }) }
pure val priorValues = Set(NoEntry, EntryOf({ amount: 1 }), EntryOf({ amount: 2 }))
pure val amountValues = Set(0, 1, 2, 5)
pure def lawAddRefusalsAreWellFormed(prior: PriorEntry, amount: Micros): bool = {
  val decision = addDecision(prior, amount)
  match decision { | RefuseAdd(r) => wellFormed(refuse(r.code)) | _ => true }
}
pure def canAddCredits(f: Funds, amount: Micros): bool = amount >= 1
pure def addCredits(f: Funds, amount: Micros): Funds = { ...f, creditBalance: f.creditBalance + amount }
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
release). The shell passes this row's `availableCredits` as metering's
`creditFree`, so the charge fits and is never clipped here. A hold with no
credit part steps this only when it has a credit charge.

```quint
pure val chargedValues = Set(0, 1, 2, 4)
pure def canSettleCredits(f: Funds, fromCredits: Micros, charged: Micros): bool =
  fromCredits >= 0 and fromCredits <= f.creditHeld and charged >= 0 and charged <= availableCredits(f) + fromCredits and fromCredits + charged >= 1
pure def settleCredits(f: Funds, fromCredits: Micros, charged: Micros): Funds =
  { ...f, creditHeld: f.creditHeld - fromCredits, creditBalance: f.creditBalance - charged, collected: f.collected + charged }
pure def sometimesSpentDown(f: Funds): bool = f.collected > 0 and f.creditBalance == 0
pure def sometimesSettledWhileAnotherHolds(f: Funds): bool = f.collected > 0 and f.creditHeld > 0
```

### Funds accept every hold and every settle that metering derives from them

At reserve the row's free credits are metering's `creditAvailable`; at
settlement they are its `creditFree`, with the hold's credit part still held.

```quint
pure def lawMeteredChargeFitsTheFunds(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, actual: Micros, creditFree: Micros): bool = {
  val reserved = M::reserve(M::initial, M::initial.key, quote, lane, allowanceAvailable, creditAvailable, 0)
  val fc = reserved.fromCredits
  val dispatched = M::markDispatched(reserved, 0)
  val known = M::creditCharge(M::settleKnown(dispatched, actual, creditFree))
  val lost = M::creditCharge(M::settleUnknown(dispatched))
  val atReserve = { creditBalance: creditAvailable, creditHeld: 0, collected: 0 }
  val atSettle = { creditBalance: creditFree + fc, creditHeld: fc, collected: 0 }
  (M::fundable(lane, quote, allowanceAvailable, creditAvailable) and actual >= 0 and creditFree >= 0) implies
    ((fc == 0 or canHoldCredits(atReserve, fc)) and (fc == 0 or canSettleCredits(atSettle, fc, 0))
      and (fc + known == 0 or canSettleCredits(atSettle, fc, known)) and (fc + lost == 0 or canSettleCredits(atSettle, fc, lost)))
}
```

### The balance never goes below what is held, and nothing held or collected is negative

```quint
pure def alwaysNeverOverdrawn(f: Funds): bool = f.creditHeld >= 0 and f.creditHeld <= f.creditBalance and f.collected >= 0
```

### Only an operator add raises the balance, and every drop in it is collected

`collected` is the total debited.

```quint
pure def stepBalanceMovesOnlyByAddOrSettle(before: Funds, via: str, after: Funds): bool =
  (after.creditBalance > before.creditBalance implies via == "addCredits")
    and (via == "addCredits" implies after.collected == before.collected)
    and (via != "addCredits" implies before.creditBalance - after.creditBalance == after.collected - before.collected)
```
