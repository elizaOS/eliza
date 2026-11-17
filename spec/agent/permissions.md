# Device permission state

The agent keeps the device's permission state, such as microphone, camera or
notifications, in its permissions registry, probing the platform's
permission APIs through the native bridge. A native probe
cannot be aborted, so this spec owns how probes of one permission are
serialized, how shutdown fences their late results, and how a state that could
not be saved is kept until it is. Each permission has its own registry entry;
the model follows one.

## Story: Show my device's real permission state, even across a failed save or a shutdown

> As a user, when I check a permission twice the later answer is the one kept.
> A probe that returns after the agent stopped changes nothing, and a result
> that could not be saved is kept and saved again before shutdown finishes.

### Probes of one permission run one at a time, and a queued check runs after the current one

A check starts a native probe only when none is running for that permission;
a check arriving meanwhile is queued, at most one. When the probe answers, its
status becomes the current state, marked unsaved, and a queued check starts
next. A failed probe leaves the state as it was.

```quint
type PermissionStatus = PermissionUnknown | Granted | Denied
type PermissionEntry = { status: PermissionStatus, durable: PermissionStatus, dirty: bool, checking: bool, queued: bool, stopped: bool, returned: bool, revision: int, stopRevision: int, persistFailed: bool, settingsOpen: bool, lateDiscarded: bool }
pure val initial: PermissionEntry = { status: PermissionUnknown, durable: PermissionUnknown, dirty: false, checking: false, queued: false, stopped: false, returned: false, revision: 0, stopRevision: 0, persistFailed: false, settingsOpen: false, lateDiscarded: false }
pure def canCheck(e: PermissionEntry): bool = not(e.stopped) and not(e.checking)
pure def check(e: PermissionEntry): PermissionEntry = { ...e, checking: true }
pure def canQueueCheck(e: PermissionEntry): bool = not(e.stopped) and e.checking and not(e.queued)
pure def queueCheck(e: PermissionEntry): PermissionEntry = { ...e, queued: true }
pure def canObserveProbe(e: PermissionEntry, observed: PermissionStatus): bool = e.checking and not(e.stopped) and observed != PermissionUnknown
pure def observeProbe(e: PermissionEntry, observed: PermissionStatus): PermissionEntry =
  { ...e, checking: e.queued, queued: false, status: observed, dirty: true, revision: e.revision + 1 }
pure def canFailProbe(e: PermissionEntry): bool = e.checking
pure def failProbe(e: PermissionEntry): PermissionEntry = { ...e, checking: e.queued and not(e.stopped), queued: false }
pure def alwaysQueuedCheckWaitsForARunningProbe(e: PermissionEntry): bool = e.queued implies e.checking
pure def sometimesSecondCheckWins(e: PermissionEntry): bool = e.durable == Granted and e.revision >= 2
```

### Stopping fences every later probe result

Stopping records the revision at that moment and drops a queued check. A probe
still running after the stop settles without changing the state, and no new
check or settings screen starts.

```quint
pure def canStop(e: PermissionEntry): bool = not(e.stopped)
pure def stop(e: PermissionEntry): PermissionEntry = { ...e, stopped: true, stopRevision: e.revision, queued: false }
pure def canSettleStoppedProbe(e: PermissionEntry): bool = e.stopped and e.checking
pure def settleStoppedProbe(e: PermissionEntry): PermissionEntry = { ...e, checking: false, queued: false, lateDiscarded: true }
pure def canOpenSettings(e: PermissionEntry): bool = not(e.stopped) and not(e.settingsOpen)
pure def openSettings(e: PermissionEntry): PermissionEntry = { ...e, settingsOpen: true }
pure def canCloseSettings(e: PermissionEntry): bool = e.settingsOpen
pure def closeSettings(e: PermissionEntry): PermissionEntry = { ...e, settingsOpen: false }
pure def alwaysStoppedRegistryTakesNoNewResult(e: PermissionEntry): bool = e.stopped implies e.revision == e.stopRevision
pure def sometimesLateProbeDiscarded(e: PermissionEntry): bool = e.returned and e.lateDiscarded and e.status == PermissionUnknown and e.revision == 0
```

### Unsaved state is kept after a failed save and saved before shutdown returns

A flush writes the current state; a failed flush keeps it marked unsaved.
Shutdown returns only after the registry stopped, and only when no probe is
running or queued, no settings screen is open and nothing is unsaved.

```quint
pure def canFlush(e: PermissionEntry): bool = e.dirty
pure def flush(e: PermissionEntry): PermissionEntry = { ...e, durable: e.status, dirty: false, persistFailed: false }
pure def canFailFlush(e: PermissionEntry): bool = e.dirty
pure def failFlush(e: PermissionEntry): PermissionEntry = { ...e, persistFailed: true }
pure def canDrain(e: PermissionEntry): bool = e.stopped and not(e.checking) and not(e.queued) and not(e.dirty) and not(e.settingsOpen) and not(e.returned)
pure def drain(e: PermissionEntry): PermissionEntry = { ...e, returned: true }
pure def alwaysSavedStateMatchesCurrent(e: PermissionEntry): bool = not(e.dirty) implies e.durable == e.status
pure def alwaysReturnedRegistryIsDrained(e: PermissionEntry): bool = e.returned implies not(e.checking or e.dirty or e.queued or e.settingsOpen)
pure def alwaysReturnedRegistryHasStopped(e: PermissionEntry): bool = e.returned implies e.stopped
pure def sometimesFailedSaveRetainedThenSaved(e: PermissionEntry): bool = e.returned and e.durable == Denied
pure def sometimesUnsavedAfterFailure(e: PermissionEntry): bool = e.dirty and e.persistFailed
```
