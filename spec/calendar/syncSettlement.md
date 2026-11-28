# Calendar sync settlement

Two things decide whether a Calendar sync result may change durable
state. A provider watch channel leases one sync attempt at a time. A
superseded attempt or an attempt that returns after stop is confirmed
leaves sync progress unchanged. While the channel is stopping, only a
success under its current lease can update sync progress. On the device, a
foreground resume reads the durable sync opt-in before it owns a sync
pass: a read started before the app was stopped or hidden can never
start a pass or change the status. [Linked control](./linkedSync.md)
owns the pause, resume and dispatch decisions this settles under.

## Story: Keep the newest sync decision when an old attempt returns late

> As the owner, I want a sync attempt that was replaced or stopped to be
> unable to mark my calendar as failed, stopped or synced.

### Every attempt is in flight, recorded or ignored, and only one of them

The channel numbers its attempts from one, and every claimed attempt is
numbered below the next number it will hand out. Each claimed attempt is
exactly one of in flight, recorded (its result changed the channel) or
ignored (it was superseded when it returned).

```quint
type ChannelPhase = ChannelActive | ChannelStopping | ChannelStopped | ChannelError
type WatchChannel = { channel: ChannelPhase, lease: int, leaseExpired: bool, nextAttempt: int, claimed: Set[int],
  inFlight: Set[int], recorded: Set[int], ignored: Set[int], pending: int, last: int, failures: int, lastReturned: int }
type OptInResult = OptInEnabled | OptInDisabled | OptInFailed
type SyncStatus = SyncIdle | SyncRunning | SyncFailed | SyncSettled | SyncCancelled
type ForegroundSync = { active: bool, visible: bool, generation: int, running: int, pending: Set[int], issued: Set[int],
  admitted: Set[int], refused: Set[int], cancelled: Set[int], settled: Set[int], status: SyncStatus, lastReturned: int }
type SyncSettlement = { watch: WatchChannel, foreground: ForegroundSync }
pure val initial: SyncSettlement = {
  watch: { channel: ChannelActive, lease: 0, leaseExpired: false, nextAttempt: 1, claimed: Set(), inFlight: Set(),
    recorded: Set(), ignored: Set(), pending: 0, last: 0, failures: 0, lastReturned: 0 },
  foreground: { active: true, visible: true, generation: 1, running: 0, pending: Set(), issued: Set(), admitted: Set(),
    refused: Set(), cancelled: Set(), settled: Set(), status: SyncIdle, lastReturned: 0 }
}
pure def alwaysExactAttemptAccounting(s: SyncSettlement): bool =
  val w = s.watch
  w.claimed.forall(a => w.inFlight.contains(a) or w.recorded.contains(a) or w.ignored.contains(a)) and
  w.inFlight.subseteq(w.claimed) and w.recorded.subseteq(w.claimed) and w.ignored.subseteq(w.claimed) and
  w.inFlight.forall(a => not(w.recorded.contains(a)) and not(w.ignored.contains(a))) and
  w.recorded.forall(a => not(w.ignored.contains(a)))
pure def alwaysAttemptsNumberedBelowTheNext(s: SyncSettlement): bool =
  s.watch.nextAttempt >= 1 and s.watch.claimed.forall(a => a >= 1 and a < s.watch.nextAttempt)
```

### A new attempt is leased only on an active channel whose previous lease is gone or expired

Changes accumulate as pending work while the channel is active. An
attempt can be claimed when the channel is active and no lease is held,
or the held lease has expired. The claim leases the new attempt. A
channel can begin to stop while active; confirming the stop clears its
pending work and its lease.

```quint
pure def canQueueChange(s: SyncSettlement): bool = s.watch.channel == ChannelActive
pure def queueChange(s: SyncSettlement): SyncSettlement = { ...s, watch: { ...s.watch, pending: s.watch.pending + 1 } }
pure def canClaimAttempt(s: SyncSettlement): bool =
  s.watch.channel == ChannelActive and (s.watch.lease == 0 or s.watch.leaseExpired)
pure def claimAttempt(s: SyncSettlement): SyncSettlement =
  val w = s.watch
  { ...s, watch: { ...w, lease: w.nextAttempt, leaseExpired: false, nextAttempt: w.nextAttempt + 1,
    claimed: w.claimed.union(Set(w.nextAttempt)), inFlight: w.inFlight.union(Set(w.nextAttempt)) } }
pure def canExpireLease(s: SyncSettlement): bool = s.watch.lease > 0 and not(s.watch.leaseExpired)
pure def expireLease(s: SyncSettlement): SyncSettlement = { ...s, watch: { ...s.watch, leaseExpired: true } }
pure def canBeginStop(s: SyncSettlement): bool = s.watch.channel == ChannelActive
pure def beginStop(s: SyncSettlement): SyncSettlement = { ...s, watch: { ...s.watch, channel: ChannelStopping } }
pure def canConfirmStop(s: SyncSettlement): bool = s.watch.channel == ChannelStopping
pure def confirmStop(s: SyncSettlement): SyncSettlement =
  { ...s, watch: { ...s.watch, channel: ChannelStopped, pending: 0, lease: 0, leaseExpired: false } }
pure def alwaysStoppedClearsPending(s: SyncSettlement): bool =
  s.watch.channel == ChannelStopped implies s.watch.pending == 0 and s.watch.lease == 0
pure val fair_confirmStop = "weak"
pure def leadsToStopConfirmed(s: SyncSettlement, later: SyncSettlement): bool =
  s.watch.channel == ChannelStopping implies later.watch.channel == ChannelStopped
pure def sometimesStopped(s: SyncSettlement): bool = s.watch.channel == ChannelStopped and s.watch.ignored.size() > 0
```

### Only the leased attempt's failure marks the channel failed

A failure of the attempt that holds the lease on an active channel puts
the channel in error, releases the lease, counts the failure and is
recorded. The channel is therefore in error exactly when one leased
attempt has failed, and its failure count is never negative. A failure of any other attempt, or one returning
while the channel is stopping or stopped, is ignored: the channel,
lease, pending work, last synced point and failure count stay as they
were.

```quint
pure val attemptValues = 1.to(20)
pure def canFailAttempt(s: SyncSettlement, attempt: int): bool = s.watch.inFlight.contains(attempt)
pure def failAttempt(s: SyncSettlement, attempt: int): SyncSettlement =
  val w = s.watch
  val rest = w.inFlight.exclude(Set(attempt))
  if (w.lease == attempt and w.channel == ChannelActive)
    { ...s, watch: { ...w, channel: ChannelError, lease: 0, leaseExpired: false, failures: w.failures + 1, inFlight: rest,
      recorded: w.recorded.union(Set(attempt)), lastReturned: attempt } }
  else { ...s, watch: { ...w, inFlight: rest, ignored: w.ignored.union(Set(attempt)), lastReturned: attempt } }
pure def stepSupersededFailurePreservesChannel(before: SyncSettlement, via: str, after: SyncSettlement): bool =
  via == "failAttempt" and not(before.watch.lease == after.watch.lastReturned and before.watch.channel == ChannelActive) implies
  after.watch.channel == before.watch.channel and after.watch.lease == before.watch.lease and after.watch.pending == before.watch.pending and
  after.watch.last == before.watch.last and after.watch.failures == before.watch.failures
pure def alwaysErrorRequiresLeasedFailure(s: SyncSettlement): bool =
  (s.watch.channel == ChannelError iff s.watch.failures > 0) and s.watch.failures >= 0 and s.watch.failures <= 1 and
  (s.watch.channel == ChannelError implies s.watch.recorded.size() > 0)
pure def sometimesSupersededFailureIgnored(s: SyncSettlement): bool =
  s.watch.channel == ChannelActive and s.watch.ignored.size() > 0
pure def sometimesChannelError(s: SyncSettlement): bool = s.watch.channel == ChannelError
```

### Only the leased attempt's success records the synced point

A success of the attempt holding the lease releases the lease, moves
the pending work to the last synced point and is recorded, even while
the channel is stopping. Any other success is ignored and changes
nothing durable. Every attempt in flight returns.

```quint
pure def canSettleAttempt(s: SyncSettlement, attempt: int): bool = s.watch.inFlight.contains(attempt)
pure def settleAttempt(s: SyncSettlement, attempt: int): SyncSettlement =
  val w = s.watch
  val rest = w.inFlight.exclude(Set(attempt))
  if (w.lease == attempt)
    { ...s, watch: { ...w, lease: 0, leaseExpired: false, last: w.last + w.pending, pending: 0, inFlight: rest,
      recorded: w.recorded.union(Set(attempt)), lastReturned: attempt } }
  else { ...s, watch: { ...w, inFlight: rest, ignored: w.ignored.union(Set(attempt)), lastReturned: attempt } }
pure def stepSupersededSuccessPreservesChannel(before: SyncSettlement, via: str, after: SyncSettlement): bool =
  via == "settleAttempt" and before.watch.lease != after.watch.lastReturned implies
  after.watch.channel == before.watch.channel and after.watch.lease == before.watch.lease and
  after.watch.pending == before.watch.pending and after.watch.last == before.watch.last
pure val fair_settleAttempt = "weak"
pure def leadsToAttemptsReturn(s: SyncSettlement, later: SyncSettlement): bool =
  s.watch.inFlight.forall(attempt => not(later.watch.inFlight.contains(attempt)))
pure def sometimesSynced(s: SyncSettlement): bool = s.watch.last > 0 and s.watch.ignored.size() > 0
```

## Story: Resume sync in the foreground only from a current opt-in read

> As the owner, I want returning to the app to resume Calendar sync only
> when sync is still turned on, and never from a read that started
> before I left.

### A foreground read of the opt-in has exactly one outcome

While the app is active and visible and no pass is running, it reads
the durable opt-in once for its current generation. Each issued read is
pending, admitted or refused, and only one of them.

```quint
pure def canReadOptIn(s: SyncSettlement): bool =
  val f = s.foreground
  f.active and f.visible and f.running == 0 and not(f.issued.contains(f.generation))
pure def readOptIn(s: SyncSettlement): SyncSettlement =
  val f = s.foreground
  { ...s, foreground: { ...f, pending: f.pending.union(Set(f.generation)), issued: f.issued.union(Set(f.generation)) } }
pure def alwaysReadHasOneOutcome(s: SyncSettlement): bool =
  val f = s.foreground
  f.issued.forall(g => f.pending.contains(g) or f.admitted.contains(g) or f.refused.contains(g)) and
  f.pending.subseteq(f.issued) and f.admitted.subseteq(f.issued) and f.refused.subseteq(f.issued) and
  f.pending.forall(g => not(f.admitted.contains(g)) and not(f.refused.contains(g))) and
  f.admitted.forall(g => not(f.refused.contains(g)))
```

### Stopping or hiding retires the generation and cancels its running pass

Stopping or hiding the app starts a new generation and cancels any pass
that is running. Starting again or showing the app does not revive the
old generation. A running pass that is no longer current has been
cancelled.

```quint
pure def foregroundCurrent(f: ForegroundSync, g: int): bool = f.active and f.visible and g == f.generation
pure def retired(f: ForegroundSync): Set[int] = if (f.running == 0) f.cancelled else f.cancelled.union(Set(f.running))
pure def canStopForeground(s: SyncSettlement): bool = s.foreground.active and s.foreground.visible
pure def stopForeground(s: SyncSettlement): SyncSettlement =
  val f = s.foreground
  { ...s, foreground: { ...f, generation: f.generation + 1, active: false, cancelled: retired(f) } }
pure def canHideForeground(s: SyncSettlement): bool = s.foreground.active and s.foreground.visible
pure def hideForeground(s: SyncSettlement): SyncSettlement =
  val f = s.foreground
  { ...s, foreground: { ...f, generation: f.generation + 1, visible: false, cancelled: retired(f) } }
pure def canStartAgain(s: SyncSettlement): bool = not(s.foreground.active)
pure def startAgain(s: SyncSettlement): SyncSettlement = { ...s, foreground: { ...s.foreground, active: true } }
pure def canShowForeground(s: SyncSettlement): bool = not(s.foreground.visible)
pure def showForeground(s: SyncSettlement): SyncSettlement = { ...s, foreground: { ...s.foreground, visible: true } }
pure def alwaysRetiredRunningPassIsCancelled(s: SyncSettlement): bool =
  val f = s.foreground
  f.running > 0 and not(foregroundCurrent(f, f.running)) implies f.cancelled.contains(f.running)
```

### Only a current enabled opt-in starts a pass, and a stale read changes nothing visible

When a read returns, it starts a pass only if its generation is still
current, the opt-in is enabled and no pass is running. Otherwise it is
refused; a failed read of the current generation shows a failure, and a
read of an old generation leaves the status and the running pass as
they were. Only the pass's own settlement releases it, as cancelled if
its generation was retired.

```quint
pure val gValues = Set(1, 2, 3)
pure def canReturnOptIn(s: SyncSettlement, g: int, result: OptInResult): bool = s.foreground.pending.contains(g)
pure def returnOptIn(s: SyncSettlement, g: int, result: OptInResult): SyncSettlement =
  val f = s.foreground
  val rest = f.pending.exclude(Set(g))
  if (foregroundCurrent(f, g) and result == OptInEnabled and f.running == 0)
    { ...s, foreground: { ...f, pending: rest, running: g, admitted: f.admitted.union(Set(g)), status: SyncRunning, lastReturned: g } }
  else
    { ...s, foreground: { ...f, pending: rest, refused: f.refused.union(Set(g)), lastReturned: g,
      status: if (foregroundCurrent(f, g) and result == OptInFailed) SyncFailed else f.status } }
pure def canFinishPass(s: SyncSettlement): bool = s.foreground.running > 0
pure def finishPass(s: SyncSettlement): SyncSettlement =
  val f = s.foreground
  { ...s, foreground: { ...f, running: 0, settled: f.settled.union(Set(f.running)),
    status: if (f.cancelled.contains(f.running)) SyncCancelled else SyncSettled } }
pure def stepStaleReadChangesNothingVisible(before: SyncSettlement, via: str, after: SyncSettlement): bool =
  via == "returnOptIn" and not(foregroundCurrent(before.foreground, after.foreground.lastReturned)) implies
  after.foreground.status == before.foreground.status and after.foreground.running == before.foreground.running
pure val fair_returnOptIn = "weak"
pure val fair_finishPass = "weak"
pure def leadsToPassSettles(s: SyncSettlement, later: SyncSettlement): bool =
  s.foreground.running > 0 implies later.foreground.running == 0
pure def sometimesForegroundRunning(s: SyncSettlement): bool = s.foreground.running > 0 and s.foreground.refused.size() > 0
pure def sometimesCancelledPass(s: SyncSettlement): bool = s.foreground.status == SyncCancelled
```
