# Android test device and isolated user custody

Grace release tooling leases one selected device through
`packages/app/scripts/lib/device-lease.ts` at `7743504b`. Alpha's
`scripts/native-test-fixture.ts` uses that lease and
`isolated-android-user.mjs` at `c518127a`. The pins are listed in the
[downstream index](./index.md). These contracts govern test fixtures and
their device effects. [Build custody](./mobileBuild.md) owns APK production.
[Fixture evidence](./mobileFixtureEvidence.md) checks the runner's results.

## Story: Run a native fixture without taking another runner's device

### Lease contention and release protect the exact observed file

A lease record is written and synced to a private temporary file. Creating
a hard link claims the canonical device path exclusively. The producer
then removes the temporary pathname.
A parsed holder is active through its exact TTL boundary when its
timestamp and positive TTL decode and the process is alive. Permission
refusal from the liveness probe still means alive. Invalid or expired
parsed records can be reclaimed. An unreadable in-progress record gets
a grace period and becomes reclaimable only strictly after it. A
contender may time out without modifying the lease.

A release matches the captured process, session and acquisition time.
Reclaim and release compare the complete observed file identity and bytes
again under the per-device mutation lock. A replacement file remains
untouched. The lock holder verifies that its own lock identity is still
current when releasing. A competing process never removes the mutation
lock, including a dead owner or an old unparsable record. Those cases
require explicit recovery. File identity, process liveness, and the
monotonic sequencing of a filesystem operation are Effect-port evidence.

```quint
type LeaseStatus = LeaseMissing | LeaseInvalid | LeaseExpired | LeaseOwnerDead | LeaseHeld
type MutationResult = MutationRefused | MutationLostSnapshot | MutationRemoved
pure def leaseStatus(present: bool, validTime: bool, age: int, ttl: int, ownerLive: bool): LeaseStatus =
  if (not(present)) LeaseMissing
  else if (not(validTime) or ttl <= 0) LeaseInvalid
  else if (age > ttl) LeaseExpired
  else if (not(ownerLive)) LeaseOwnerDead else LeaseHeld
pure def mayReclaimUnparsable(age: int, grace: int): bool = age > grace
pure def leaseMutation(lockOwned: bool, admittedReason: bool, snapshotExact: bool): MutationResult =
  if (not(lockOwned and admittedReason)) MutationRefused else if (not(snapshotExact)) MutationLostSnapshot else MutationRemoved
pure def lawLeaseLivesAtInclusiveEnd(ttl: int): bool = ttl > 0 implies leaseStatus(true, true, ttl, ttl, true) == LeaseHeld
pure def lawFreshPartialLeaseUnchanged(grace: int): bool = not(mayReclaimUnparsable(grace, grace))
pure def lawReclaimRequiresExactSnapshot(lockOwned: bool, admittedReason: bool, snapshotExact: bool): bool =
  leaseMutation(lockOwned, admittedReason, snapshotExact) == MutationRemoved implies lockOwned and admittedReason and snapshotExact
```

### Cleanup restores user zero before it can remove the owned secondary user

Alpha's secondary-user fixture requires its own live long-lived lease,
a matching emulator serial and AVD, and foreground user zero at entry.
It durably records the new positive user ID before launching the fixture
and verifies the stock HOME component is resumed under that ID.
Cancellation can stop forward progress. Cleanup ignores forward
cancellation, switches to user zero and observes a resumed owner
activity. If the fixture was entered, its callback must return
`cleaned: true` with no cleanup deferral before removal. If it never
entered, a known created user can be removed after restoring the owner.
An unknown or failed cleanup retains the user for explicit recovery.
Removal requires the same user to stop and an inventory proving user
zero exists and that exact secondary ID is gone. The return or failure
record includes ownership and cleanup evidence. The model starts before
lease verification and user allocation. Android command
decoding and reporting are outside this model.

```quint
type FixturePhase = FixtureLeaseReady | FixtureUserCreated | FixtureRunning | FixtureRestoring | FixtureMayRemove | FixtureDeferred | FixtureRemoved
type FixtureUser = { phase: FixturePhase, user: int, leaseAdmitted: bool, entered: bool, cleaned: bool, ownerRestored: bool }
pure val initial: FixtureUser = { phase: FixtureLeaseReady, user: 0, leaseAdmitted: false, entered: false, cleaned: false, ownerRestored: false }
pure def canCreateFixtureUser(f: FixtureUser, leaseExact: bool, avdExact: bool, ownerZero: bool, createdId: int): bool =
  f.phase == FixtureLeaseReady and leaseExact and avdExact and ownerZero and createdId > 0
pure def createFixtureUser(f: FixtureUser, leaseExact: bool, avdExact: bool, ownerZero: bool, createdId: int): FixtureUser =
  { ...f, phase: FixtureUserCreated, user: createdId, leaseAdmitted: true }
pure def canEnterFixture(f: FixtureUser, currentUser: int, stockHomeResumed: bool): bool =
  f.phase == FixtureUserCreated and currentUser == f.user and stockHomeResumed
pure def enterFixture(f: FixtureUser, currentUser: int, stockHomeResumed: bool): FixtureUser =
  { ...f, phase: FixtureRunning, entered: true }
pure def canEndFixture(f: FixtureUser): bool = f.phase == FixtureUserCreated or f.phase == FixtureRunning
pure def endFixture(f: FixtureUser, cleaned: bool, wantsDeferral: bool): FixtureUser =
  { ...f, phase: FixtureRestoring, cleaned: not(f.entered) or (cleaned and not(wantsDeferral)) }
pure def canObserveOwner(f: FixtureUser): bool = f.phase == FixtureRestoring
pure def observeOwner(f: FixtureUser, userZero: bool, activityResumed: bool): FixtureUser =
  { ...f, ownerRestored: userZero and activityResumed,
    phase: if (userZero and activityResumed and f.cleaned) FixtureMayRemove else FixtureDeferred }
pure def canRemoveFixture(f: FixtureUser): bool = f.phase == FixtureMayRemove
pure def removeFixture(f: FixtureUser, stoppedId: int, zeroInInventory: bool, userGone: bool): FixtureUser =
  { ...f, phase: if (stoppedId == f.user and zeroInInventory and userGone) FixtureRemoved else FixtureDeferred }
pure def alwaysFixtureOwnsSecondaryUser(f: FixtureUser): bool = (f.phase != FixtureLeaseReady) == f.leaseAdmitted and f.leaseAdmitted == (f.user > 0)
pure def alwaysRemovalNeedsPriorCleanup(f: FixtureUser): bool =
  (f.phase == FixtureMayRemove or f.phase == FixtureRemoved) implies f.cleaned and f.ownerRestored
pure def stepRemovalFollowsOwnedFixture(before: FixtureUser, via: str, after: FixtureUser): bool =
  (after.phase == FixtureRemoved and before.phase != FixtureRemoved) implies via == "removeFixture" and before.user > 0 and after.user == before.user
pure def sometimesFixtureRemoved(f: FixtureUser): bool = f.phase == FixtureRemoved
pure def sometimesOwnerRestoredButUserRetained(f: FixtureUser): bool = f.phase == FixtureDeferred and f.ownerRestored and not(f.cleaned)
pure val currentUserValues = Set(0, 1, 2, 3)
pure val stoppedIdValues = currentUserValues
```
