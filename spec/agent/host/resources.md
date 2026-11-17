# Resources released once

The agent process and each of its listeners hold resources: the store, the
runtime, the loaded plugins, the socket and the loopback HTTP listener. This
spec is the one discipline for giving them back. Resources are acquired in
order while open; closing fixes the release order, newest first, before any
release starts; each acquisition is released once; a failed release is
recorded and the rest still run. The process and the transport each hold one
`Resources` and drive it with `acquire`, `close` and `releaseNext`. The shell
awaits each release, collects the errors it threw into one aggregate error,
and throws when something is acquired after close. Sources:
`packages/agent/src/runtime/process-lifecycle.ts` (`dispose`) and
`packages/agent/src/api/server-resources.ts`.

## Story: Release everything I acquired, once

> As the agent process, I want everything I acquired released once, newest
> first, even when one release fails, so that stopping leaves nothing open and
> tells the truth about whether it was clean.

### A resource is acquired only while open

A resource is named, such as `store` or `socket`. Acquiring after close began
is refused.

```quint
type ReleasePhase = Open | Closing | Closed
type Resources = { phase: ReleasePhase, held: List[str], pending: List[str], released: List[str], failed: List[str] }
pure val initial: Resources = { phase: Open, held: List(), pending: List(), released: List(), failed: List() }
pure val resourceValues = Set("store", "runtime", "socket")
pure def canAcquire(s: Resources): bool = s.phase == Open
pure def acquire(s: Resources, resource: str): Resources = { ...s, held: s.held.append(resource) }
pure def stepNothingAcquiredAfterClose(before: Resources, after: Resources): bool = before.phase != Open implies after.held == before.held
pure def sometimesSeveralHeld(s: Resources): bool = s.phase == Open and s.held.length() >= 2
```

### Closing fixes the release order, newest first, before any release runs

Closing with nothing held is closed at once. A second close joins the one
already under way: it changes nothing and starts no second release.

```quint
pure def newestFirst(xs: List[str]): List[str] = xs.foldl(List(), (acc, x) => List(x).concat(acc))
pure def close(s: Resources): Resources = {
  val order = newestFirst(s.held)
  if (s.phase != Open) s
  else { ...s, phase: if (order.length() == 0) Closed else Closing, pending: order }
}
pure def stepCloseAgainChangesNothing(before: Resources, via: str, after: Resources): bool = (via == "close" and before.phase != Open) implies after == before
pure def sometimesClosedEmpty(s: Resources): bool = s.phase == Closed and s.held.length() == 0
```

### Each acquisition is released exactly once, in reverse order of acquisition

A release happens only while closing and takes the next pending resource.
What was released, followed by what is pending, is always exactly the
acquisitions newest first, so nothing is released twice or skipped. The last
release ends the close.

```quint
pure def canReleaseNext(s: Resources): bool = s.phase == Closing and s.pending.length() > 0
pure def releaseNext(s: Resources, ok: bool): Resources = {
  val resource = s.pending.nthOr(0, "")
  val rest = s.pending.removeAt(0)
  { ...s, phase: if (rest.length() == 0) Closed else Closing, pending: rest, released: s.released.append(resource), failed: if (ok) s.failed else s.failed.append(resource) }
}
pure def alwaysReleasedNewestFirst(s: Resources): bool =
  if (s.phase == Open) s.pending.length() == 0 and s.released.length() == 0
  else s.released.concat(s.pending) == newestFirst(s.held)
pure def alwaysClosingHasPending(s: Resources): bool = (s.phase == Closing) == (s.pending.length() > 0)
pure def sometimesClosedClean(s: Resources): bool = s.phase == Closed and s.released.length() >= 2 and s.failed.length() == 0
```

### A failed release is recorded and the remaining releases still run

The close ends clean only when no release failed; the process exits 1
otherwise.

```quint
pure def closedCleanly(s: Resources): bool = s.phase == Closed and s.failed.length() == 0
pure def alwaysFailuresWereReleased(s: Resources): bool = s.failed.every(f => s.released.includes(f))
pure def sometimesFailureThenMoreReleased(s: Resources): bool = s.phase == Closed and s.released.length() >= 2 and s.failed.includes(s.released.nthOr(0, ""))
```

### A close that has begun ends with every resource released

```quint
pure val fair_releaseNext = "weak"
pure def leadsToClosed(s: Resources, later: Resources): bool = s.phase == Closing implies (later.phase == Closed and later.released.length() == later.held.length())
```
