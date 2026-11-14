# Bank

Two accounts and transfers between them. The rules here span both accounts,
which neither account could state alone.

## Story: Move money between accounts

### The bank holds a current and a savings account

```quint
import account.* from "./account"

type Bank = { current: Account, savings: Account }

pure val initial: Bank =
  { current: { owner: "ann", balance: 6 }, savings: { owner: "ann", balance: 0 } }
```

### Money moves from one account to the other, never out of thin air

```quint
pure def total(b: Bank): int = b.current.balance + b.savings.balance

pure def canSave(b: Bank, amount: int): bool = canWithdraw(b.current, amount) and canDeposit(b.savings, amount)
pure def save(b: Bank, amount: int): Bank =
  { current: withdraw(b.current, amount), savings: deposit(b.savings, amount) }

pure def canSpend(b: Bank, amount: int): bool = canWithdraw(b.savings, amount) and canDeposit(b.current, amount)
pure def spend(b: Bank, amount: int): Bank =
  { current: deposit(b.current, amount), savings: withdraw(b.savings, amount) }

pure def stepATransferKeepsTheTotal(before: Bank, after: Bank): bool = total(after) == total(before)
pure def alwaysNoAccountIsOverdrawn(b: Bank): bool = b.current.balance >= 0 and b.savings.balance >= 0
pure def sometimesEverythingIsSaved(b: Bank): bool = b.current.balance == 0 and b.savings.balance == 6
```
