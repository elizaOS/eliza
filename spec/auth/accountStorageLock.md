# Account storage lock

Every [account storage](./accountStorage.md) call runs under one lock
directory. A process creates the lock under the ordinary name, publishes its
token, checks the ordinary name again, and only then enters. A lock whose
owner is dead is moved aside to quarantine before it is removed; an atomic
rename may move a live successor's lock instead of the dead one it looked
at, and that moved live owner stays authoritative until it releases, so
nobody else enters meanwhile. A process attempts once; a failed admission
retires its attempt.

A token names its owner process (`token - 1`); the lock left by process 0,
which is dead, is there from the start.

## Story: Serialize account storage across processes on one machine

> As the agent's processes on one machine, we want at most one of us to
> change account storage at a time, even when one of us crashed holding the
> lock and two of us try to clean it up at once.

### At most one process is inside, and it owns a published lock and is alive

```quint
type LockerPc = Fresh | Observed | Publishing | Ready | Checked | Inside | Closing | ReleaseRename | ReleaseCheck | Finished | Dead
type Locker = { process: int, pc: LockerPc, token: int, ordinaryRelease: bool, staged: int }
type StorageLock = { current: int, quarantined: Set[int], exists: Set[int], published: Set[int], alive: Set[int], critical: Set[int], lockers: List[Locker] }
pure val initial: StorageLock = {
  current: 1, quarantined: Set(), exists: Set(1), published: Set(1), alive: Set(1, 2), critical: Set(),
  lockers: List({ process: 1, pc: Fresh, token: 0, ordinaryRelease: false, staged: 0 }, { process: 2, pc: Fresh, token: 0, ordinaryRelease: false, staged: 0 })
}
pure val noLocker: Locker = { process: 0, pc: Dead, token: 0, ordinaryRelease: false, staged: 0 }
pure def lockerOf(s: StorageLock, p: int): Locker = s.lockers.select(l => l.process == p).nthOr(0, noLocker)
pure def withLocker(p: int, change: Locker, s: StorageLock): List[Locker] = s.lockers.listMap(l => if (l.process == p) change else l)
pure def livePublished(s: StorageLock, token: int): bool = token > 0 and s.published.contains(token) and s.alive.contains(token - 1)
pure def alwaysMutualExclusion(s: StorageLock): bool = s.critical.size() <= 1
pure def alwaysActiveOwnership(s: StorageLock): bool =
  s.critical.forall(p => lockerOf(s, p).pc == Inside and lockerOf(s, p).token == p + 1 and s.exists.contains(p + 1) and s.published.contains(p + 1) and s.alive.contains(p))
pure def sometimesInsideAfterStaleCleanup(s: StorageLock): bool = s.critical.size() == 1 and not(s.exists.contains(1))
pure val pValues = Set(1, 2)
```

### A dead owner's lock is moved to quarantine, never deleted in place

```quint
pure def canObserveDead(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Fresh and s.current != 0 and not(livePublished(s, s.current))
pure def observeDead(s: StorageLock, p: int): StorageLock = { ...s, lockers: withLocker(p, { ...lockerOf(s, p), pc: Observed }, s) }
pure def canQuarantineObserved(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Observed
pure def quarantineObserved(s: StorageLock, p: int): StorageLock =
  { ...s, current: 0, quarantined: if (s.current != 0) s.quarantined.union(Set(s.current)) else s.quarantined, lockers: withLocker(p, { ...lockerOf(s, p), pc: Fresh }, s) }
pure def canCleanQuarantine(s: StorageLock, token: int): bool = s.quarantined.contains(token) and not(livePublished(s, token))
pure def cleanQuarantine(s: StorageLock, token: int): StorageLock =
  { ...s, quarantined: s.quarantined.exclude(Set(token)), exists: s.exists.exclude(Set(token)), published: s.published.exclude(Set(token)) }
pure val tokenValues = Set(1, 2, 3)
pure def alwaysLiveQuarantineProtected(s: StorageLock): bool = s.critical.forall(p => s.current == p + 1 or s.quarantined.contains(p + 1))
pure def sometimesLiveOwnerQuarantined(s: StorageLock): bool = s.critical.exists(p => s.quarantined.contains(p + 1))
```

### A process enters only when its own lock still holds the ordinary name and no live lock sits in quarantine

Every process id is positive. From creating its lock until it finishes or
dies, a process holds the token
that names it; from publishing it until it leaves, its lock exists and is
published; and while an admitted process's lock still holds the ordinary
name, nobody is inside.

```quint
pure def canCreate(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Fresh and s.current == 0 and lockerOf(s, p).token == 0
pure def create(s: StorageLock, p: int): StorageLock =
  { ...s, current: p + 1, exists: s.exists.union(Set(p + 1)), lockers: withLocker(p, { ...lockerOf(s, p), token: p + 1, pc: Publishing }, s) }
pure def canPublish(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Publishing
pure def publish(s: StorageLock, p: int): StorageLock = {
  val l = lockerOf(s, p)
  if (s.exists.contains(l.token)) { ...s, published: s.published.union(Set(l.token)), lockers: withLocker(p, { ...l, pc: Ready }, s) }
  else { ...s, lockers: withLocker(p, { ...l, pc: Closing }, s) }
}
pure def canPublicationFails(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Publishing
pure def publicationFails(s: StorageLock, p: int): StorageLock = { ...s, lockers: withLocker(p, { ...lockerOf(s, p), pc: Closing }, s) }
pure def canInspectAdmission(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Ready
pure def inspectAdmission(s: StorageLock, p: int): StorageLock = {
  val l = lockerOf(s, p)
  val admitted = s.current == l.token and not(s.quarantined.exists(t => livePublished(s, t)))
  { ...s, lockers: withLocker(p, { ...l, pc: if (admitted) Checked else Closing }, s) }
}
pure def canEnter(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Checked
pure def enter(s: StorageLock, p: int): StorageLock = {
  val l = lockerOf(s, p)
  if (s.current == l.token) { ...s, critical: s.critical.union(Set(p)), lockers: withLocker(p, { ...l, pc: Inside }, s) } else { ...s, lockers: withLocker(p, { ...l, pc: Closing }, s) }
}
pure def canLeave(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Inside
pure def leave(s: StorageLock, p: int): StorageLock = { ...s, critical: s.critical.exclude(Set(p)), lockers: withLocker(p, { ...lockerOf(s, p), pc: Closing }, s) }
pure def alwaysLockersAreWellFormed(s: StorageLock): bool =
  s.lockers.every(l => (l.token == 0 or l.token == l.process + 1) and ((l.pc == Inside) iff s.critical.contains(l.process)) and (l.pc == Dead iff not(s.alive.contains(l.process))))
pure def alwaysAdmissionHoldsItsOwnLock(s: StorageLock): bool =
  s.lockers.every(l => l.process > 0
    and ((l.pc != Fresh and l.pc != Observed and l.pc != Finished and l.pc != Dead) implies l.token == l.process + 1)
    and ((l.pc == Ready or l.pc == Checked or l.pc == Inside) implies (s.exists.contains(l.token) and s.published.contains(l.token)))
    and ((l.pc == Checked and s.current == l.token) implies s.critical.size() == 0))
pure def sometimesStaleObserverRetired(s: StorageLock): bool = s.lockers.some(l => l.pc == Finished and l.token > 0) and s.critical.size() == 1
```

### A process releases only its own lock, wherever it was moved

```quint
pure def canFindRelease(s: StorageLock, p: int): bool = lockerOf(s, p).pc == Closing
pure def findRelease(s: StorageLock, p: int): StorageLock = {
  val l = lockerOf(s, p)
  val found = l.token > 0 and (s.current == l.token or s.quarantined.contains(l.token))
  { ...s, lockers: withLocker(p, { ...l, ordinaryRelease: s.current == l.token, pc: if (found) ReleaseRename else Finished }, s) }
}
pure def canStageRelease(s: StorageLock, p: int): bool = lockerOf(s, p).pc == ReleaseRename
pure def stageRelease(s: StorageLock, p: int): StorageLock = {
  val l = lockerOf(s, p)
  val taken = if (l.ordinaryRelease) s.current else l.token
  { ...s, current: if (l.ordinaryRelease) 0 else s.current, quarantined: if (taken != 0) s.quarantined.union(Set(taken)) else s.quarantined,
    lockers: withLocker(p, { ...l, staged: taken, pc: ReleaseCheck }, s) }
}
pure def canFinishRelease(s: StorageLock, p: int): bool = lockerOf(s, p).pc == ReleaseCheck
pure def finishRelease(s: StorageLock, p: int): StorageLock = {
  val l = lockerOf(s, p)
  if (l.staged == l.token) { ...s, quarantined: s.quarantined.exclude(Set(l.token)), exists: s.exists.exclude(Set(l.token)), published: s.published.exclude(Set(l.token)), lockers: withLocker(p, { ...l, pc: Finished }, s) }
  else { ...s, lockers: withLocker(p, { ...l, pc: Closing }, s) }
}
pure def canCrash(s: StorageLock, p: int): bool = s.alive.contains(p)
pure def crash(s: StorageLock, p: int): StorageLock = { ...s, alive: s.alive.exclude(Set(p)), critical: s.critical.exclude(Set(p)), lockers: withLocker(p, { ...lockerOf(s, p), pc: Dead }, s) }
pure def stepReleaseRemovesOnlyOwnToken(before: StorageLock, via: str, after: StorageLock): bool =
  via == "finishRelease" implies before.exists.forall(t => after.exists.contains(t) or before.lockers.some(l => l.token == t and l.pc == ReleaseCheck and l.staged == t))
pure def sometimesBothFinished(s: StorageLock): bool = s.lockers.every(l => l.pc == Finished) and s.exists.size() == 0
pure def sometimesCrashedInside(s: StorageLock): bool = s.lockers.some(l => l.pc == Dead and s.exists.contains(l.process + 1))
```

### Every attempt that does not crash finishes

```quint
pure val fair_observeDead = "weak"
pure val fair_quarantineObserved = "weak"
pure val fair_create = "weak"
pure val fair_publish = "weak"
pure val fair_inspectAdmission = "weak"
pure val fair_enter = "weak"
pure val fair_leave = "weak"
pure val fair_findRelease = "weak"
pure val fair_stageRelease = "weak"
pure val fair_finishRelease = "weak"
pure val fair_cleanQuarantine = "weak"
pure def leadsToAttemptsFinish(s: StorageLock, later: StorageLock): bool = later.lockers.every(l => l.pc == Finished or l.pc == Dead)
```
