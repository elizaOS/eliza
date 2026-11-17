# Credential clipboard lease

When the browser hands the person a credential through the clipboard, it
takes a lease: it writes the secret with one clipboard backend and erases it
when the lease ends. A backend is the command and environment pair a host
selects, such as a different display or executable path.

## Story: A copied credential is erased by the command that wrote it

> As the person, I want a credential copied for me to disappear from the
> clipboard when its time is up, without the browser erasing something newer
> I copied or touching a clipboard it never wrote.

### A lease keeps the command it was admitted with until it is cleaned up

Admission binds the lease to the backend selected at that moment, with its
executable paths and environment. Later work may select another backend;
the lease still cleans up with the one it was bound to, and never writes any
other. Expiry, explicit or automatic, and process-exit cleanup use the same
bound command pair. Cleanup erases the clipboard only while it still holds
the leased secret: a newer copy is preserved. If the bound executable has
gone, cleanup does not fall back to another backend and the value stays.
The lease no longer holds the secret once it is finished. Only an admitted
lease can be superseded by a newer copy.

```quint
type ClipValue = ClipOther | ClipOwned | ClipNewer | ClipEmpty
type LeasePhase = LeaseNew | LeaseActive | LeaseFinished
type ClipboardLease = { phase: LeasePhase, current: int, bound: int, values: int -> ClipValue, available: Set[int], secret: bool, superseded: bool, lastCleanup: int }
pure val clipboardPorts: Set[int] = Set(0, 1)
pure val initial: ClipboardLease = { phase: LeaseNew, current: 0, bound: -1, values: Map(), available: Set(0, 1), secret: false, superseded: false, lastCleanup: -1 }
pure def valueAt(l: ClipboardLease, port: int): ClipValue = l.values.getOr(port, ClipOther)
pure def canAdmitLease(l: ClipboardLease): bool = l.phase == LeaseNew
pure def admitLease(l: ClipboardLease): ClipboardLease = { ...l, phase: LeaseActive, bound: l.current, values: l.values.put(l.current, ClipOwned), secret: true }
pure def canSwitchBackend(l: ClipboardLease, port: int): bool = l.phase != LeaseFinished and clipboardPorts.contains(port) and port != l.current
pure def switchBackend(l: ClipboardLease, port: int): ClipboardLease = { ...l, current: port }
pure def canCopyNewer(l: ClipboardLease): bool = l.phase == LeaseActive
pure def copyNewer(l: ClipboardLease): ClipboardLease = { ...l, values: l.values.put(l.bound, ClipNewer), superseded: true }
pure def canRemoveExecutable(l: ClipboardLease): bool = l.phase == LeaseActive and l.available.contains(l.bound)
pure def removeExecutable(l: ClipboardLease): ClipboardLease = { ...l, available: l.available.exclude(Set(l.bound)) }
pure def canFinishLease(l: ClipboardLease): bool = l.phase == LeaseActive
pure def finishLease(l: ClipboardLease): ClipboardLease =
  { ...l, phase: LeaseFinished, secret: false, lastCleanup: l.bound,
    values: if (l.available.contains(l.bound) and valueAt(l, l.bound) == ClipOwned) l.values.put(l.bound, ClipEmpty) else l.values }
pure val portValues = Set(0, 1)
pure def alwaysLeaseUsesBoundBackend(l: ClipboardLease): bool =
  clipboardPorts.contains(l.current) and (l.phase != LeaseNew implies clipboardPorts.contains(l.bound)) and (l.phase == LeaseFinished implies l.lastCleanup == l.bound)
pure def alwaysSecretOnlyWhileActive(l: ClipboardLease): bool = l.secret iff l.phase == LeaseActive
pure def alwaysOtherBackendsUntouched(l: ClipboardLease): bool =
  clipboardPorts.forall(port => (l.phase == LeaseNew or port != l.bound) implies valueAt(l, port) == ClipOther)
pure def alwaysNewerCopyPreserved(l: ClipboardLease): bool = l.superseded implies (l.phase != LeaseNew and valueAt(l, l.bound) == ClipNewer)
pure def sometimesErasedAfterBackendChanged(l: ClipboardLease): bool = l.phase == LeaseFinished and l.current != l.bound and valueAt(l, l.bound) == ClipEmpty
pure def sometimesNewerCopyKept(l: ClipboardLease): bool = l.phase == LeaseFinished and valueAt(l, l.bound) == ClipNewer
pure def sometimesMissingExecutableLeavesValue(l: ClipboardLease): bool = l.phase == LeaseFinished and valueAt(l, l.bound) == ClipOwned
```

### An active lease is always cleaned up

The scheduled expiry or process-exit cleanup runs, and its subprocess
operations settle, so every active lease ends.

```quint
pure val fair_finishLease = "weak"
pure def leadsToLeaseFinishes(l: ClipboardLease, later: ClipboardLease): bool = l.phase == LeaseActive implies later.phase == LeaseFinished
```
