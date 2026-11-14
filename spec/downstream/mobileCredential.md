# Resident credential stop and commit leases

Alpha's `AlphaLocalAgentPlugin.mutateCredentials` holds the product
lifecycle lock for the exact owner and stop generation. It consumes
`ElizaAgentService` and its upstream `CredentialShutdownLease.java`.
The pinned `packages/app/quint/ResidentCredentialMutation.qnt`
includes stale mutation, timeout, and uncertain write cases.
This specification models the shared shutdown lease for changed
credential slots. The no-change path does not need a stop lease.
Credential plaintext and provider secrets remain within the native
vault Effect port.

## Story: Replace a credential only after the exact resident owner stopped

### A confirmation is tied to its lease and does not release an uncertain write

A new mutation reserves a distinct lease. A stop observation must name
that lease and verify owner process absence. A confirmation says it
is now possible to attempt the write; launches remain fenced until
the exact mutation verifies the committed value. A pre-commit timeout
abandons the lease and requires a later confirmed stop to release it.
Once the write is attempted, any failure retains the lease. Stale
receipts cannot mutate the currently reserved lease. The application
asserts mutation intent and original slot value under the same lock
as commit and exact readback.

```quint
type LeasePhase = IdleLease | PendingLease | AbandonedLease | UncertainLease | ConfirmedRelease
type WriteResult = AcceptedWrite | UncertainWrite
type ShutdownLease = { serial: int, phase: LeasePhase, acknowledged: bool, confirmedWrites: int }
pure val initial: ShutdownLease = { serial: 0, phase: IdleLease, acknowledged: false, confirmedWrites: 0 }
pure def pendingLease(l: ShutdownLease): bool =
  l.phase == PendingLease or l.phase == AbandonedLease or l.phase == UncertainLease
pure def reserveLease(l: ShutdownLease): ShutdownLease =
  { ...l, serial: l.serial + 1, phase: PendingLease, acknowledged: false }
pure def canObserveStop(l: ShutdownLease, requestId: int): bool =
  pendingLease(l) and requestId == l.serial
pure def observeStop(l: ShutdownLease, requestId: int, stopped: bool): ShutdownLease =
  { ...l, phase: if (stopped and l.phase == AbandonedLease) ConfirmedRelease else l.phase, acknowledged: stopped }
pure def canAbandonLease(l: ShutdownLease, requestId: int): bool =
  l.phase == PendingLease and l.serial == requestId
pure def abandonLease(l: ShutdownLease, requestId: int): ShutdownLease =
  { ...l, phase: if (l.acknowledged) ConfirmedRelease else AbandonedLease }
pure def canCommitCredential(l: ShutdownLease, requestId: int, ownsMutation: bool, exactAbsence: bool, priorSlotMatches: bool): bool =
  l.phase == PendingLease and l.serial == requestId and l.acknowledged and ownsMutation and exactAbsence and priorSlotMatches
pure def commitCredential(l: ShutdownLease, requestId: int, ownsMutation: bool, exactAbsence: bool, priorSlotMatches: bool, result: WriteResult): ShutdownLease =
  if (result == AcceptedWrite) { ...l, phase: ConfirmedRelease, confirmedWrites: l.confirmedWrites + 1 }
  else { ...l, phase: UncertainLease }
pure def canBeginLaunch(l: ShutdownLease): bool = not(pendingLease(l))
pure def beginLaunch(l: ShutdownLease): ShutdownLease =
  { ...l, serial: l.serial + 1, phase: IdleLease, acknowledged: false }
pure val requestIdValues = Set(1, 2, 3)
pure def alwaysReleaseHasExactConfirmation(l: ShutdownLease): bool =
  l.phase == ConfirmedRelease implies l.acknowledged
pure def alwaysLeaseCountersValid(l: ShutdownLease): bool =
  l.serial >= 0 and l.confirmedWrites >= 0 and l.confirmedWrites <= l.serial and (pendingLease(l) implies l.serial > 0)
pure def stepOnlyCommitWrites(before: ShutdownLease, via: str, after: ShutdownLease): bool =
  after.confirmedWrites > before.confirmedWrites implies via == "commitCredential" and before.acknowledged
pure def stepUncertainRetainsFence(before: ShutdownLease, via: str, after: ShutdownLease): bool =
  before.phase == UncertainLease and via != "reserveLease" implies after.phase == UncertainLease
pure def sometimesUncertainWriteRetainsFence(l: ShutdownLease): bool = l.phase == UncertainLease
pure def sometimesExactWriteReleases(l: ShutdownLease): bool = l.phase == ConfirmedRelease and l.confirmedWrites > 0
pure def sometimesAbandonedLeaseWaits(l: ShutdownLease): bool = l.phase == AbandonedLease
```

### A pending reservation accounts for its next possible write

Discovered by the proof: a fabricated pending lease could assign
its serial entirely to earlier confirmed writes. Every reservation
opens a new serial before its possible write. Entries awaiting or
retaining the result therefore have at least one serial beyond the
confirmed write count.

```quint
pure def alwaysPendingSerialIsFresh(l: ShutdownLease): bool =
  pendingLease(l) implies l.confirmedWrites < l.serial
```
