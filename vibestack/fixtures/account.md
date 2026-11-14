# Account

A component: the rules of one account, with no state of its own. A spec that
has accounts imports this and decides how many there are.

## Story: Keep money in an account

### An account holds a balance that is never negative

```quint
type Account = { owner: str, balance: int }

pure def canWithdraw(a: Account, amount: int): bool = amount > 0 and amount <= a.balance
pure def withdraw(a: Account, amount: int): Account = { ...a, balance: a.balance - amount }
pure def canDeposit(a: Account, amount: int): bool = amount > 0
pure def deposit(a: Account, amount: int): Account = { ...a, balance: a.balance + amount }

pure def lawAWithdrawalNeverOverdraws(owner: str, balance: int, amount: int): bool =
  (balance >= 0 and canWithdraw({ owner: owner, balance: balance }, amount))
    implies withdraw({ owner: owner, balance: balance }, amount).balance >= 0
```
