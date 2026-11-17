# Provider account pool

A person may link several accounts of one model provider. When the agent
needs one, the pool selects an account by a strategy (lowest priority
number, least used, or round robin with session affinity) among the accounts
it captured when the call began, filtered again when the call completes.
The selected account's credential is then read from the pool's own storage
root, never from whatever directory the process happens to point at. The
[lease](./accountPoolLeases.md) of a selected account, and the usage and
health reports against it, are a machine of their own. Provider names are
placeholders (`p1`, `p2`); account 3 of `p2` shows the same visible id as
account 1 of `p1`.

Subscription sign-in to a model provider is not part of Eliza; accounts are
linked through [account storage](./accountStorage.md).

## Story: Choose a linked provider account by priority, usage and affinity

> As the agent, I want each call to use a healthy, current account of the
> right provider, spread fairly over my linked accounts and kept stable
> within one session, so that one account is not exhausted while others
> idle.

### Selection filters the captured inventory at completion time, and never picks a disabled, cooling, parked or expired account

```quint
type PoolHealth = Healthy | Cooling | UnknownCooldown | Parked
type PoolAccount = { key: int, provider: str, visibleId: int, enabled: bool, health: PoolHealth, coolUntil: int, endsAt: int, priority: int, lastUsed: int, usage: int, stamp: int }
type Strategy = ByPriority | LeastUsed | RoundRobin
type SelectionPhase = Waiting | Picked | NonePicked
type Selection = { slot: int, strategy: Strategy, provider: str, allow: int, excluded: int, session: int, snapshot: List[int], phase: SelectionPhase, picked: PoolAccount, pickedAt: int, reused: bool, credentialRoot: int }
type Affinity = { provider: str, session: int, account: int, uses: int }
type Cursor = { provider: str, index: int }
type SelectionRequest = { strategy: Strategy, provider: str, allow: int, excluded: int, session: int }
type AccountPool = { now: int, accounts: List[PoolAccount], selections: List[Selection], affinity: List[Affinity], cursors: List[Cursor], clock: int, poolRoot: int, ambientRoot: int }
pure val noAccount: PoolAccount = { key: 0, provider: "", visibleId: 0, enabled: false, health: Parked, coolUntil: 0, endsAt: 0, priority: 0, lastUsed: 0, usage: 0, stamp: 0 }
pure val initial: AccountPool = {
  now: 0,
  accounts: List(
    { key: 1, provider: "p1", visibleId: 1, enabled: true, health: Healthy, coolUntil: 0, endsAt: 3, priority: 0, lastUsed: 0, usage: 0, stamp: 0 },
    { key: 2, provider: "p1", visibleId: 2, enabled: true, health: Healthy, coolUntil: 0, endsAt: 3, priority: 1, lastUsed: 0, usage: 0, stamp: 0 },
    { key: 3, provider: "p2", visibleId: 1, enabled: true, health: Healthy, coolUntil: 0, endsAt: 3, priority: 0, lastUsed: 0, usage: 0, stamp: 0 }),
  selections: List(), affinity: List(), cursors: List(), clock: 0, poolRoot: 1, ambientRoot: 1
}
pure def accountOf(s: AccountPool, key: int): PoolAccount = s.accounts.select(a => a.key == key).nthOr(0, noAccount)
pure def available(a: PoolAccount, now: int): bool = a.enabled and a.endsAt > now and (a.health == Healthy or (a.health == Cooling and a.coolUntil < now))
pure def inScope(a: PoolAccount, x: Selection): bool = a.provider == x.provider and (x.allow == 0 or x.allow == a.visibleId) and x.excluded != a.visibleId
pure def eligible(s: AccountPool, x: Selection): List[PoolAccount] = s.accounts.select(a => x.snapshot.includes(a.key) and inScope(a, x) and available(a, s.now))
pure def selectionOf(s: AccountPool, slot: int): Selection = s.selections.select(x => x.slot == slot).nthOr(0, { slot: 0, strategy: ByPriority, provider: "", allow: 0, excluded: 0, session: 0, snapshot: List(), phase: NonePicked, picked: noAccount, pickedAt: 0, reused: false, credentialRoot: 0 })
pure def canBeginSelection(s: AccountPool, slot: int, request: SelectionRequest): bool = slot > 0 and selectionOf(s, slot).phase != Waiting
pure def beginSelection(s: AccountPool, slot: int, request: SelectionRequest): AccountPool = {
  val x = { slot: slot, strategy: request.strategy, provider: request.provider, allow: request.allow, excluded: request.excluded, session: request.session,
    snapshot: s.accounts.select(a => a.enabled and a.provider == request.provider).listMap(a => a.key), phase: Waiting, picked: noAccount, pickedAt: 0, reused: false, credentialRoot: 0 }
  { ...s, selections: s.selections.select(o => o.slot != slot).append(x) }
}
pure val slotValues = Set(1, 2)
pure val requestValues = Set(
  { strategy: ByPriority, provider: "p1", allow: 0, excluded: 0, session: 0 },
  { strategy: LeastUsed, provider: "p1", allow: 0, excluded: 0, session: 0 },
  { strategy: RoundRobin, provider: "p1", allow: 0, excluded: 0, session: 1 },
  { strategy: ByPriority, provider: "p2", allow: 1, excluded: 0, session: 0 },
  { strategy: ByPriority, provider: "p1", allow: 1, excluded: 1, session: 0 })
pure def canElapse(s: AccountPool, seconds: int): bool = seconds > 0
pure def elapse(s: AccountPool, seconds: int): AccountPool = { ...s, now: s.now + seconds }
pure val secondsValues = Set(1)
pure def canSetHealth(s: AccountPool, key: int, health: PoolHealth): bool = s.accounts.some(a => a.key == key)
pure def setHealth(s: AccountPool, key: int, health: PoolHealth): AccountPool = { ...s, accounts: s.accounts.listMap(a => if (a.key == key) { ...a, health: health, coolUntil: s.now + 1 } else a) }
pure def canSetEnabled(s: AccountPool, key: int, on: bool): bool = s.accounts.some(a => a.key == key)
pure def setEnabled(s: AccountPool, key: int, on: bool): AccountPool = { ...s, accounts: s.accounts.listMap(a => if (a.key == key) { ...a, enabled: on } else a) }
pure val keyValues = Set(1, 2, 3)
pure def alwaysPickWasEligibleAtCompletion(s: AccountPool): bool =
  s.selections.every(x => x.phase == Picked implies (x.snapshot.includes(x.picked.key) and inScope(x.picked, x) and available(x.picked, x.pickedAt)))
pure def sometimesPickedAfterCooldown(s: AccountPool): bool = s.selections.some(x => x.phase == Picked and x.picked.health == Cooling)
pure def sometimesNoneEligible(s: AccountPool): bool = s.selections.some(x => x.phase == NonePicked and x.snapshot.length() > 0)
```

### Each account has its own positive key, and each slot holds one selection

Each account has its own positive key. Each slot holds one selection, and
a selection that is still waiting has reused no affinity.

```quint
pure def alwaysAccountKeysDistinct(s: AccountPool): bool = s.accounts.every(a => a.key > 0 and s.accounts.select(b => b.key == a.key).length() == 1)
pure def alwaysOneSelectionPerSlot(s: AccountPool): bool =
  s.selections.every(x => s.selections.select(o => o.slot == x.slot).length() == 1 and (x.phase == Waiting implies not(x.reused)))
```

### Priority, then persisted last use, orders a priority selection

```quint
pure def priorityFirst(a: PoolAccount, b: PoolAccount): bool = a.priority < b.priority or (a.priority == b.priority and a.lastUsed <= b.lastUsed)
pure def byPriority(candidates: List[PoolAccount]): PoolAccount = candidates.foldl(noAccount, (best, a) => if (best.key == 0 or not(priorityFirst(best, a))) a else best)
pure def stepPriorityPickRanksFirst(before: AccountPool, via: str, after: AccountPool): bool =
  via == "finishSelection" implies after.selections.every(x => (x.phase == Picked and x.strategy == ByPriority and not(x.reused) and selectionOf(before, x.slot).phase == Waiting) implies
    eligible(before, selectionOf(before, x.slot)).every(o => priorityFirst(x.picked, o)))
pure def canRecordUse(s: AccountPool, key: int): bool = s.accounts.some(a => a.key == key)
pure def recordUse(s: AccountPool, key: int): AccountPool = { ...s, accounts: s.accounts.listMap(a => if (a.key == key) { ...a, lastUsed: s.now + 1, usage: a.usage + 1 } else a) }
pure def sometimesPriorityPick(s: AccountPool): bool = s.selections.some(x => x.phase == Picked and x.strategy == ByPriority)
```

### Least-used ranking uses live process stamps after the wait, and stamps only fresh picks

Usage counts first, then the later of the live stamp and the persisted last
use, then the key.

```quint
pure def age(a: PoolAccount): int = if (a.stamp >= a.lastUsed) a.stamp else a.lastUsed
pure def leastUsedFirst(a: PoolAccount, b: PoolAccount): bool = a.usage < b.usage or (a.usage == b.usage and (age(a) < age(b) or (age(a) == age(b) and a.key <= b.key)))
pure def byLeastUse(candidates: List[PoolAccount]): PoolAccount = candidates.foldl(noAccount, (best, a) => if (best.key == 0 or leastUsedFirst(a, best)) a else best)
pure def stepLeastUsedPickRanksFirst(before: AccountPool, via: str, after: AccountPool): bool =
  via == "finishSelection" implies after.selections.every(x => (x.phase == Picked and x.strategy == LeastUsed and not(x.reused) and selectionOf(before, x.slot).phase == Waiting) implies
    eligible(before, selectionOf(before, x.slot)).every(o => leastUsedFirst(x.picked, o)))
pure def stepStampsOnlyFreshPicks(before: AccountPool, via: str, after: AccountPool): bool =
  after.accounts.every(a => before.accounts.some(b => b.key == a.key and (b.stamp == a.stamp or via == "restart" or (via == "finishSelection" and a.stamp == after.clock and after.clock > before.clock))))
pure def canRestart(s: AccountPool): bool = not(s.selections.some(x => x.phase == Waiting))
pure def restart(s: AccountPool): AccountPool = { ...s, accounts: s.accounts.listMap(a => { ...a, stamp: 0 }), clock: 0, affinity: List(), cursors: List() }
pure def sometimesBurstSpreadsOverAccounts(s: AccountPool): bool = s.selections.some(x => x.phase == Picked and x.strategy == LeastUsed and x.picked.key == 1) and s.selections.some(x => x.phase == Picked and x.strategy == LeastUsed and x.picked.key == 2)
```

### Affinity keeps a session on its account while the account stays eligible, for at most three uses

Otherwise a round-robin cursor per provider advances over the eligible
accounts in key order, and never points before the first of them. A
provider and a session together key the affinity.

```quint
pure val maxAffinityUses = 3
pure def affinityOf(s: AccountPool, provider: str, session: int): Affinity = s.affinity.select(f => f.provider == provider and f.session == session).nthOr(0, { provider: provider, session: session, account: 0, uses: 0 })
pure def cursorOf(s: AccountPool, provider: str): int = s.cursors.select(c => c.provider == provider).nthOr(0, { provider: provider, index: -1 }).index
pure def canFinishSelection(s: AccountPool, slot: int): bool = selectionOf(s, slot).phase == Waiting
pure def finishSelection(s: AccountPool, slot: int): AccountPool = {
  val x = selectionOf(s, slot)
  val candidates = eligible(s, x)
  val cached = affinityOf(s, x.provider, x.session)
  val reuse = x.session > 0 and cached.uses > 0 and cached.uses < maxAffinityUses and candidates.some(a => a.key == cached.account)
  val index = if (candidates.length() > 0) (cursorOf(s, x.provider) + 1) % candidates.length() else 0
  val choice = if (reuse) accountOf(s, cached.account) else if (x.strategy == ByPriority) byPriority(candidates) else if (x.strategy == LeastUsed) byLeastUse(candidates) else candidates.nthOr(index, noAccount)
  val stamp = if (s.now >= s.clock + 1) s.now else s.clock + 1
  val fresh = not(reuse) and choice.key > 0
  { ...s,
    selections: s.selections.listMap(o => if (o.slot == slot) { ...o, phase: if (choice.key > 0) Picked else NonePicked, picked: choice, pickedAt: s.now, reused: reuse } else o),
    accounts: if (fresh and x.strategy == LeastUsed) s.accounts.listMap(a => if (a.key == choice.key) { ...a, stamp: stamp } else a) else s.accounts,
    clock: if (fresh and x.strategy == LeastUsed) stamp else s.clock,
    affinity: if (x.session > 0 and choice.key > 0) s.affinity.select(f => not(f.provider == x.provider and f.session == x.session)).append({ provider: x.provider, session: x.session, account: choice.key, uses: if (reuse) cached.uses + 1 else 1 }) else s.affinity,
    cursors: if (x.strategy == RoundRobin and fresh) s.cursors.select(c => c.provider != x.provider).append({ provider: x.provider, index: index }) else s.cursors }
}
pure def alwaysAffinityStaysInProvider(s: AccountPool): bool =
  s.affinity.every(f => f.uses >= 1 and f.uses <= maxAffinityUses and accountOf(s, f.account).provider == f.provider and s.affinity.select(o => o.provider == f.provider and o.session == f.session).length() == 1)
pure def stepAffinityReuseKeepsCursor(before: AccountPool, via: str, after: AccountPool): bool =
  after.selections.every(x => (x.reused and selectionOf(before, x.slot).phase == Waiting) implies after.cursors == before.cursors)
pure def alwaysCursorsNeverNegative(s: AccountPool): bool = s.cursors.every(c => c.index >= 0)
pure def sometimesRoundRobinMovesOn(s: AccountPool): bool = s.selections.some(x => x.phase == Picked and x.strategy == RoundRobin and not(x.reused)) and s.affinity.some(f => f.account == 2)
pure def sometimesAffinityReused(s: AccountPool): bool = s.selections.some(x => x.reused)
```

### A selection picks nothing only when no captured account is eligible, and then changes no affinity or cursor

```quint
pure def stepNoPickOnlyWhenNoneEligible(before: AccountPool, via: str, after: AccountPool): bool =
  via == "finishSelection" implies after.selections.every(x => (x.phase == NonePicked and selectionOf(before, x.slot).phase == Waiting) implies
    (eligible(before, selectionOf(before, x.slot)).length() == 0 and after.affinity == before.affinity and after.cursors == before.cursors))
pure def stepEligibleAccountIsPicked(before: AccountPool, via: str, after: AccountPool): bool =
  via == "finishSelection" implies after.selections.every(x => (selectionOf(before, x.slot).phase == Waiting and x.phase != Waiting and eligible(before, selectionOf(before, x.slot)).length() > 0) implies x.phase == Picked)
```

### A selected account's credential is read from the pool's storage root

```quint
pure def canResolveCredential(s: AccountPool, slot: int): bool = selectionOf(s, slot).phase == Picked and selectionOf(s, slot).credentialRoot == 0
pure def resolveCredential(s: AccountPool, slot: int): AccountPool = { ...s, selections: s.selections.listMap(o => if (o.slot == slot) { ...o, credentialRoot: s.poolRoot } else o) }
pure def changeAmbientRoot(s: AccountPool): AccountPool = { ...s, ambientRoot: 3 - s.ambientRoot }
pure def alwaysCredentialFromPoolRoot(s: AccountPool): bool = s.selections.every(x => x.credentialRoot == 0 or (x.phase == Picked and x.credentialRoot == s.poolRoot))
pure def sometimesResolvedWhileAmbientDiffers(s: AccountPool): bool = s.ambientRoot != s.poolRoot and s.selections.some(x => x.credentialRoot > 0)
```
