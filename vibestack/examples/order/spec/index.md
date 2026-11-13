# Order checkout

A shop takes orders. A shopper fills a draft, submits it, and pays it off in one
or more payments. Amounts are whole cents.

## Domain

### Order

An order has a **status**, the number of **units** in it, the amount **due**
and the amount **paid** so far. Each event is sent by a shopper or by shop
staff, whom the shop knows from how they signed in. Only the shopper adds,
removes and empties items, submits, pays, takes money back, cancels and
reopens; only staff hold an order and release it.

```quint
type Status = Draft | Pending | OnHold | Paid | Cancelled
type Order = { status: Status, units: int, due: int, paid: int }
type Role = Shopper | Staff
```

### Unit price and order size

Every unit costs the same, and one order holds a limited number of units. In
this example a unit costs 5 cents and an order holds at most 60 units.

```quint
pure val unitPrice = 5
pure val maxUnits = 60
```

### An order holds between no units and the most it may hold

```quint
pure def alwaysWithinOrderSize(o: Order): bool = 0 <= o.units and o.units <= maxUnits
```

## Story: Fill a draft

> As a shopper, I want to put items into a new order, so that I can buy
> several things in one go.

### A new order is an empty draft

```quint
pure val initial: Order = { status: Draft, units: 0, due: 0, paid: 0 }
```

### Items can only be added to a draft

The shopper adds a positive number of units, so long as the order then holds no
more than the most it may hold. Each unit adds the unit price to the amount due.

```quint
pure def canAddItem(o: Order, qty: int, by: Role): bool =
  by == Shopper and o.status == Draft and qty > 0 and o.units + qty <= maxUnits

pure def addItem(o: Order, qty: int, by: Role): Order =
  { ...o, units: o.units + qty, due: o.due + qty * unitPrice }
```

### The amount due is always the price of the units

```quint
pure def alwaysDueMatchesUnits(o: Order): bool =
  o.due == o.units * unitPrice
```

## Story: Check out

> As a shopper, I want to submit my order and pay it off in one or more
> payments, so that I do not need the whole amount at once.

### Only a non-empty draft can be submitted

Submitting freezes the order: it becomes pending and waits for payment.

```quint
pure def canSubmit(o: Order, by: Role): bool = by == Shopper and o.status == Draft and o.units > 0

pure def submit(o: Order, by: Role): Order = { ...o, status: Pending }
```

### A submitted order keeps its units and its amount due until it is a draft again

```quint
pure def stepSubmittedKeepsItsItems(before: Order, after: Order): bool =
  before.status != Draft implies (after.units == before.units and after.due == before.due)
```

### A payment never exceeds the balance

A payment is a positive amount toward a pending order. The payment that clears
the balance marks the order as paid.

```quint
pure def canPay(o: Order, amount: int, by: Role): bool =
  by == Shopper and o.status == Pending and amount > 0 and o.paid + amount <= o.due

pure def pay(o: Order, amount: int, by: Role): Order =
  val paid = o.paid + amount
  { ...o, paid: paid, status: if (paid == o.due) Paid else Pending }
```

### The amount paid is never negative and never more than is due

```quint
pure def alwaysPaidWithinDue(o: Order): bool = 0 <= o.paid and o.paid <= o.due
```

### A pending order still has a balance

```quint
pure def alwaysPendingHasBalance(o: Order): bool =
  o.status == Pending implies o.paid < o.due
```

### A paid order is paid in full, and something was owed on it

```quint
pure def alwaysPaidInFull(o: Order): bool =
  o.status == Paid implies (o.paid == o.due and o.due > 0)
```

### An order can be paid off

```quint
pure def sometimesPaid(o: Order): bool = o.status == Paid
```

### An order can be partly paid

```quint
pure def sometimesPartlyPaid(o: Order): bool = o.status == Pending and o.paid > 0
```

## Story: Cancel

> As a shopper, I want to cancel an order I have not finished paying for and
> get my money back.

### A pending order can be cancelled, refunding every payment

An order on hold cannot be cancelled until it is released.

```quint
pure def canCancel(o: Order, by: Role): bool = by == Shopper and o.status == Pending

pure def cancel(o: Order, by: Role): Order = { ...o, status: Cancelled, paid: 0 }
```

### Drafts and cancelled orders hold no money

Discovered by the proof: without it, submitting could not be shown to leave a
pending order with a balance.

```quint
pure def alwaysNoMoneyHeldOutsideCheckout(o: Order): bool =
  (o.status == Draft or o.status == Cancelled) implies o.paid == 0
```

### An order can be cancelled

```quint
pure def sometimesCancelled(o: Order): bool = o.status == Cancelled
```

## Story: Change my mind

> As a shopper, I want to take items back out of my order before I submit it,
> so that I only pay for what I still want.

### Items can be removed from a draft

The shopper removes a positive number of the units in the order. Each unit
removed takes the unit price off the amount due.

```quint
pure def canRemoveItem(o: Order, qty: int, by: Role): bool =
  by == Shopper and o.status == Draft and qty > 0 and holdsAtLeast(o, qty)

pure def removeItem(o: Order, qty: int, by: Role): Order =
  { ...o, units: o.units - qty, due: o.due - qty * unitPrice }
```

### No more can be removed than the order holds

Discovered by simulation: without this, removing items from an empty draft
left a negative number of units and a negative amount due.

```quint
pure def holdsAtLeast(o: Order, qty: int): bool = qty <= o.units
```

## Story: Reopen a cancelled order

> As a shopper, I want to reopen an order I cancelled, so that I can change it
> and check out again without starting over.

### A cancelled order can be reopened as a draft

Its items stay in it. Nothing is paid on it, because cancelling refunded every
payment.

```quint
pure def canReopen(o: Order, by: Role): bool = by == Shopper and o.status == Cancelled
pure def reopen(o: Order, by: Role): Order = { ...o, status: Draft }
```

## Story: Take back a payment

> As a shopper, I want to take back some of the money I have paid on an order
> that is still pending, so that I can use it elsewhere without cancelling.

### Some or all of what was paid on a pending order can be taken back

The shopper takes back a positive amount. The order stays pending.

```quint
pure def canTakeBack(o: Order, amount: int, by: Role): bool =
  by == Shopper and o.status == Pending and amount > 0 and neverMoreThanPaid(o, amount)

pure def takeBack(o: Order, amount: int, by: Role): Order = { ...o, paid: o.paid - amount }
```

### No more can be taken back than was paid

Discovered by simulation: the first version of this story let a shopper take
back more than they had paid, which left a negative amount paid.

```quint
pure def neverMoreThanPaid(o: Order, amount: int): bool = amount <= o.paid
```

## Story: Start over

> As a shopper, I want to empty my draft in one go, so that I can start again
> without removing items one at a time.

### A draft that holds items can be emptied in one go

Emptying removes every unit the order holds.

```quint
pure def canEmpty(o: Order, by: Role): bool = by == Shopper and o.status == Draft and o.units > 0
pure def empty(o: Order, by: Role): Order = removeItem(o, o.units, by)
```

## Story: Put an order on hold

> As shop staff, I want to put a pending order on hold while stock is checked
> and release it afterwards, so that no payment is taken for something we may
> not be able to send. While it is on hold, the shopper can neither pay, take
> money back nor cancel it.

### Staff can put a pending order on hold and release it again

Only staff can do either. A released order is pending, exactly as it was.

```quint
pure def canHold(o: Order, by: Role): bool = by == Staff and o.status == Pending
pure def hold(o: Order, by: Role): Order = { ...o, status: OnHold }

pure def canRelease(o: Order, by: Role): bool = by == Staff and o.status == OnHold
pure def release(o: Order, by: Role): Order = { ...o, status: Pending }
```

### An order can be put on hold

```quint
pure def sometimesOnHold(o: Order): bool = o.status == OnHold
```

### Nothing paid on an order on hold changes: no payment is taken and none is given back

```quint
pure def stepNothingIsPaidOnHold(before: Order, after: Order): bool =
  before.status == OnHold implies after.paid == before.paid
```

### An order on hold is not cancelled

```quint
pure def stepOnHoldIsNotCancelled(before: Order, after: Order): bool =
  before.status == OnHold implies after.status != Cancelled
```

### An order on hold is released

Staff do not leave an order on hold for ever: the next thing that happens to it
is its release.

```quint
pure def leadsToReleased(o: Order, later: Order): bool =
  o.status == OnHold implies later.status != OnHold

pure val fair_release = "weak"
pure val within_leadsToReleased = 1
```

### An order on hold still has a balance

Discovered by the proof: nothing said that an order on hold is unpaid, so
releasing one could not be shown to leave a pending order with a balance.

```quint
pure def alwaysOnHoldHasBalance(o: Order): bool =
  o.status == OnHold implies o.paid < o.due
```
