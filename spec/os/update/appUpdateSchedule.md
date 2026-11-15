# Automatic app update schedule

While the app is in the foreground, the renderer asks the native updater
to check for and prepare an app update on a timer. One scheduler owns the
timer and at most one native call; native package admission, network
success and device acceptance are separate obligations of the
[installation journal](./install.md) and
[app update admission](./appAdmission.md). Before a new renderer mounts,
it also reads the native journal back so that it never mounts over an
activation the installer still owns.

The model's time unit is abstract: the retry base is 1 and the interval
is 4, so a failed check retries after 1, 2 and then 4 units, and the
deployed scheduler's base and interval keep the same ratio or less.

## Story: Check for app updates on a bounded schedule while the app is in the foreground

> As a device owner, I want the app to look for updates by itself while I
> use it, backing off when it is offline, without ever running two update
> calls at once or acting for a screen I already left.

### At most one update call runs, and only the foreground owner starts one

A call starts only when the scheduler is in the foreground, not disposed,
idle and due. Going to the background, coming back, or disposing retires
the running call's authority without inventing its completion. A disposed
scheduler never returns to the foreground.

```quint
type UpdateSchedule = { now: int, active: bool, disposed: bool, busy: bool, failures: int, wakeAt: int, valid: bool }
pure val initial: UpdateSchedule = { now: 0, active: false, disposed: false, busy: false, failures: 0, wakeAt: 0, valid: true }
pure def canSetForeground(s: UpdateSchedule, value: bool): bool = not(s.disposed) and s.active != value
pure def setForeground(s: UpdateSchedule, value: bool): UpdateSchedule = { ...s, active: value, valid: if (s.busy) false else s.valid }
pure def canBeginCheck(s: UpdateSchedule): bool = s.active and not(s.disposed) and not(s.busy) and s.now >= s.wakeAt
pure def beginCheck(s: UpdateSchedule): UpdateSchedule = { ...s, busy: true, valid: true }
pure def canDisposeSchedule(s: UpdateSchedule): bool = not(s.disposed)
pure def disposeSchedule(s: UpdateSchedule): UpdateSchedule = { ...s, disposed: true, active: false, valid: not(s.busy) }
pure def canAdvanceClock(s: UpdateSchedule, later: int): bool = later > s.now
pure def advanceClock(s: UpdateSchedule, later: int): UpdateSchedule = { ...s, now: later }
pure val laterValues = Set(1, 2, 3, 4, 5, 7, 9)
pure def alwaysDisposedStaysBackground(s: UpdateSchedule): bool = (s.disposed implies not(s.active)) and (s.busy or s.valid)
pure def stepOneCallAtATime(before: UpdateSchedule, via: str, after: UpdateSchedule): bool =
  via == "beginCheck" implies not(before.busy) and before.active and not(before.disposed)
pure def sometimesCheckRunning(s: UpdateSchedule): bool = s.busy and s.valid
pure def sometimesDisposedDuringCheck(s: UpdateSchedule): bool = s.disposed and s.busy
```

### A failed check retries after a doubling delay up to the interval, and a success waits the full interval

The failure count saturates at 20 and resets on success. The retry delay
starts at the base and doubles up to the interval.

```quint
pure val retryBase = 1
pure val checkInterval = 4
pure def retryDelay(failures: int): int =
  if (failures <= 1) retryBase else if (failures == 2 and 2 * retryBase < checkInterval) 2 * retryBase else checkInterval
pure def canFinishCheck(s: UpdateSchedule, failed: bool): bool = s.busy
pure def finishCheck(s: UpdateSchedule, failed: bool): UpdateSchedule = {
  val failures = if (failed) (if (s.failures < 20) s.failures + 1 else 20) else 0
  { ...s, busy: false, failures: failures, valid: true,
    wakeAt: if (not(s.valid)) s.now else s.now + (if (failed) retryDelay(failures) else checkInterval) }
}
pure def alwaysRetryIsBounded(s: UpdateSchedule): bool =
  s.failures >= 0 and s.failures <= 20 and s.wakeAt >= 0 and s.wakeAt <= s.now + checkInterval
pure def lawRetryDelayStaysWithinTheInterval(failures: int): bool =
  retryDelay(failures) >= retryBase and retryDelay(failures) <= checkInterval and retryDelay(failures + 1) >= retryDelay(failures)
pure val failuresValues = Set(0, 1, 2, 3, 19, 20)
pure val weight_beginCheck = 4
pure val weight_finishCheck = 4
pure def sometimesBackedOff(s: UpdateSchedule): bool = s.failures == 3 and s.wakeAt == s.now + checkInterval
```

### A call whose owner was retired reschedules at once when it returns

When the foreground owner changed or the scheduler was disposed while
the call ran, its completion schedules the next check for now, so a later
foreground owner is not kept waiting by a stale call's delay.

```quint
pure def stepRetiredCallReschedulesNow(before: UpdateSchedule, via: str, after: UpdateSchedule): bool =
  (via == "finishCheck" and not(before.valid)) implies after.wakeAt == before.now
pure def sometimesRetiredCallReturned(s: UpdateSchedule): bool = s.active and not(s.busy) and s.wakeAt == s.now and s.now > 0
```

### A running call settles, and a due check starts unless its owner retires

A native call is assumed to settle eventually, with success or failure;
a call that never settles may hold the scheduler, and nothing here claims
otherwise. A due timer is assumed to fire.

```quint
pure val fair_finishCheck = "weak"
pure val fair_beginCheck = "weak"
pure def leadsToCallSettled(s: UpdateSchedule, later: UpdateSchedule): bool = s.busy implies not(later.busy)
pure def leadsToDueCheckStarts(s: UpdateSchedule, later: UpdateSchedule): bool =
  canBeginCheck(s) implies (later.busy or not(later.active) or later.disposed)
```

## Story: Hold a new page while a confirmed app activation owns input

> As a device owner, I want a freshly started app page to wait while the
> installer still owns an activation, so that I never type into a page
> the installer is about to replace.

### A pending activation holds its bridge, and only a matching terminal or idle readback on that bridge releases it

The first pending readback names the bridge and activation that hold the
page; a later activation may take its place on the same bridge. Another
bridge, an unreadable readback, or a terminal readback for a different
activation never releases a held page; an idle readback on the same
bridge does. A page that holds nothing mounts on the first readable
non-pending readback. A native host that does not advertise the update
journal's state method has no journal and mounts; one that advertises it
must answer, and an unreadable answer holds the page.

```quint
type Activation = { bridge: int, activation: int }
type JournalReadback = { readable: bool, readBridge: int, pending: bool, idle: bool, readActivation: int, terminal: bool }
pure def startupReleases(held: bool, holder: Activation, r: JournalReadback): bool =
  r.readable and r.readBridge > 0 and not(r.pending) and
  (not(held) or (r.readBridge == holder.bridge and (r.idle or (r.terminal and r.readActivation == holder.activation))))
pure val holderValues = Set({ bridge: 1, activation: 1 }, { bridge: 1, activation: 2 })
pure val doneReadback: JournalReadback = { readable: true, readBridge: 1, pending: false, idle: false, readActivation: 1, terminal: true }
pure val rValues = Set(doneReadback, { ...doneReadback, readBridge: 2 }, { ...doneReadback, readActivation: 2 },
  { ...doneReadback, terminal: false, idle: true, readActivation: 0 }, { ...doneReadback, readable: false },
  { ...doneReadback, pending: true }, { ...doneReadback, readBridge: 2, pending: true }, { ...doneReadback, terminal: false })
pure def startupHolder(held: bool, holder: Activation, r: JournalReadback): Activation =
  if (r.readable and r.pending and r.readBridge > 0 and (not(held) or r.readBridge == holder.bridge))
    { bridge: r.readBridge, activation: r.readActivation }
  else holder
pure def startupMounts(advertised: bool, held: bool, holder: Activation, r: JournalReadback): bool =
  not(advertised) or startupReleases(held, holder, r)
pure def lawOtherBridgeNeverReleases(holder: Activation, r: JournalReadback): bool =
  r.readBridge != holder.bridge implies (not(startupReleases(true, holder, r)) and startupHolder(true, holder, r) == holder)
pure def lawHeldPageKeepsItsBridge(holder: Activation, r: JournalReadback): bool =
  startupHolder(true, holder, r).bridge == holder.bridge
pure def lawUnreadableReadbackNeverReleases(held: bool, holder: Activation, r: JournalReadback): bool =
  not(r.readable) implies not(startupMounts(true, held, holder, r))
pure def lawMatchingTerminalOrIdleReleases(holder: Activation, r: JournalReadback): bool =
  (r.readable and not(r.pending) and holder.bridge > 0 and r.readBridge == holder.bridge and
    (r.idle or (r.terminal and r.readActivation == holder.activation))) implies startupReleases(true, holder, r)
```
