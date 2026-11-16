# Owner pairing

A connector, such as a chat platform account, proves that it belongs to the
owner by echoing a short code the host issued. The owner the code is for is
captured when it is issued and never changes. The code is consumed before
the asynchronous identity write, so a slow write cannot be raced with the
same code. An expired code and a code whose attempts ran out fail closed.

## Story: Bind a connector account to the owner

> As the owner, I pair my account on a chat platform by sending the code my
> agent shows me, and nobody who guesses or replays a code can pair theirs.

### A code is issued for one owner, and that owner never changes while the code lives

```quint
type PairingPhase = NoCode | CodePending | Writing
type Pairing = { phase: PairingPhase, owner: int, attempts: int, expired: bool, writes: int, bound: bool, boundOwner: int, writeFailed: bool }
pure val codeAttempts = 2
pure val initial: Pairing = { phase: NoCode, owner: 0, attempts: 0, expired: false, writes: 0, bound: false, boundOwner: 0, writeFailed: false }
pure val ownerValues = Set(1, 2)
pure def canIssue(p: Pairing, owner: int): bool = owner > 0 and p.phase != Writing
pure def issue(p: Pairing, owner: int): Pairing = { phase: CodePending, owner: owner, attempts: codeAttempts, expired: false, writes: 0, bound: false, boundOwner: 0, writeFailed: false }
pure def stepOwnerFixedAtIssue(before: Pairing, via: str, after: Pairing): bool =
  via != "issue" implies after.owner == before.owner
```

### A wrong code spends an attempt, and the last wrong attempt discards the code

```quint
pure def canWrongCode(p: Pairing): bool = p.phase == CodePending and not(p.expired) and p.attempts > 0
pure def wrongCode(p: Pairing): Pairing = { ...p, attempts: p.attempts - 1, phase: if (p.attempts == 1) NoCode else CodePending }
pure def alwaysAttemptsBounded(p: Pairing): bool = p.attempts >= 0 and p.attempts <= codeAttempts and (p.phase == CodePending implies p.attempts > 0)
pure def sometimesCodeExhausted(p: Pairing): bool = p.phase == NoCode and p.owner > 0 and p.attempts == 0 and not(p.bound) and not(p.expired) and not(p.writeFailed)
```

### An expired code is discarded and can no longer be consumed

```quint
pure def canAge(p: Pairing): bool = p.phase == CodePending and not(p.expired)
pure def age(p: Pairing): Pairing = { ...p, expired: true }
pure def canExpire(p: Pairing): bool = p.phase == CodePending and p.expired
pure def expire(p: Pairing): Pairing = { ...p, phase: NoCode, attempts: 0 }
pure def stepNoExpiredCodeConsumed(before: Pairing, via: str, after: Pairing): bool = via == "consume" implies not(before.expired)
```

### The code is consumed before the identity write, and the write binds the code's owner once

A failed write still consumed the code; pairing then needs a new code.

```quint
pure def canConsume(p: Pairing): bool = p.phase == CodePending and not(p.expired) and p.attempts > 0
pure def consume(p: Pairing): Pairing = { ...p, phase: Writing, attempts: 0 }
pure def canIdentityWritten(p: Pairing): bool = p.phase == Writing
pure def identityWritten(p: Pairing): Pairing = { ...p, phase: NoCode, writes: p.writes + 1, bound: true, boundOwner: p.owner }
pure def canIdentityWriteFailed(p: Pairing): bool = p.phase == Writing
pure def identityWriteFailed(p: Pairing): Pairing = { ...p, phase: NoCode, writeFailed: true }
pure def alwaysWriteFollowsConsumption(p: Pairing): bool =
  (p.phase == Writing implies p.attempts == 0 and p.owner > 0) and p.writes <= 1 and (p.bound iff p.writes == 1) and (p.bound implies p.boundOwner == p.owner)
pure def sometimesBound(p: Pairing): bool = p.bound
pure def sometimesFailedWriteConsumedCode(p: Pairing): bool = p.writeFailed and p.phase == NoCode and not(p.bound)
```
