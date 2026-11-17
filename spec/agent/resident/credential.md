# Resident credential

A consumer's local agent plugin replaces the on-device resident's
credentials while holding its lifecycle lock for the exact owner and stop
generation. It uses the resident service's shutdown lease and the secure
store's credential intent fence and slot mutation, which keep intent
checks, retirement, commit and exact readback in one path. This spec
models the shared shutdown lease for changed credential slots. Credential
plaintext and provider secrets stay in the native vault.

## Story: Replace a credential only after the exact resident owner stopped

> As a device owner changing a provider credential, I want the on-device
> agent stopped before the change and kept stopped until the change is
> known to be saved.

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

### A replacement that names the stored value commits without stopping the resident

A mutation first compares its value with the slot under the credential
lock. An unchanged value commits at once and reserves no stop lease; a
changed value retires the resident first and goes through the lease above.
A mutation whose reservation is no longer the latest finishes as stale
and touches neither the slot nor the lease.

```quint
type MutationPlan = CommitUnchanged | StopFirst | StaleMutation
pure def mutationPlan(latestIntent: int, intent: int, storedValue: int, nextValue: int): MutationPlan =
  if (intent != latestIntent) StaleMutation
  else if (storedValue == nextValue) CommitUnchanged
  else StopFirst
pure def lawOnlyAChangedValueStopsTheResident(latestIntent: int, intent: int, storedValue: int, nextValue: int): bool =
  (mutationPlan(latestIntent, intent, storedValue, nextValue) == StopFirst) iff (intent == latestIntent and storedValue != nextValue)
pure def lawStaleMutationNeverCommits(latestIntent: int, intent: int, storedValue: int, nextValue: int): bool =
  intent != latestIntent implies mutationPlan(latestIntent, intent, storedValue, nextValue) == StaleMutation
```

## Story: Keep my own provider keys for this session only

> As a device owner who brings my own provider keys, I add, change, remove
> and choose them on my phone; they live only in memory for my current
> session, the agent receives them only when I chose my own provider, and a
> change made from a stale screen is refused instead of overwriting mine.

The resident host keeps one key session for its trusted local owner. It
holds a text key and a voice key, the chosen route (the owner's cloud
account or the owner's own keys) and a revision that names the session's
current state. It touches no network, file or environment, and its keys
are never written anywhere.

### Every change names the current revision, and a stale or closed session refuses it unchanged

Editing a key, choosing the route and removing a key each name the revision
the caller last saw. A different revision, or a closed session, refuses the
change as a provider change and leaves the session as it was; an applied
change issues a new revision. An edit names at least one key and leaves the
key it does not name as it was.

```quint
type KeyRoute = CloudAccountRoute | OwnKeysRoute
type KeySession = { route: KeyRoute, revision: int, textKey: bool, voiceKey: bool, closed: bool }
type KeyChange = EditKeys({ text: bool, voice: bool }) | ChooseRoute({ route: KeyRoute }) | RemoveTextKey | RemoveVoiceKey
type KeyReply = KeysChanged | ProviderChanged | ChangeInvalid
type KeyResult = { session: KeySession, reply: KeyReply }
pure def changeKeys(k: KeySession, expected: int, change: KeyChange): KeyResult =
  if (k.closed or expected != k.revision) { session: k, reply: ProviderChanged }
  else match change {
    | EditKeys(e) => if (not(e.text) and not(e.voice)) { session: k, reply: ChangeInvalid }
        else { session: { ...k, textKey: k.textKey or e.text, voiceKey: k.voiceKey or e.voice, revision: k.revision + 1 }, reply: KeysChanged }
    | ChooseRoute(c) => if (c.route == OwnKeysRoute and not(k.textKey)) { session: k, reply: ChangeInvalid }
        else { session: { ...k, route: c.route, revision: k.revision + 1 }, reply: KeysChanged }
    | RemoveTextKey => { session: { ...k, textKey: false, revision: k.revision + 1 }, reply: KeysChanged }
    | RemoveVoiceKey => { session: { ...k, voiceKey: false, revision: k.revision + 1 }, reply: KeysChanged }
  }
pure val freshSession: KeySession = { route: CloudAccountRoute, revision: 0, textKey: false, voiceKey: false, closed: false }
pure val kValues = Set(freshSession, { ...freshSession, textKey: true, revision: 1 }, { ...freshSession, route: OwnKeysRoute, textKey: true, voiceKey: true, revision: 2 }, { ...freshSession, closed: true, revision: 3 })
pure val expectedValues = Set(0, 1, 2, 3)
pure val changeValues = Set(EditKeys({ text: true, voice: false }), EditKeys({ text: false, voice: false }), ChooseRoute({ route: OwnKeysRoute }), ChooseRoute({ route: CloudAccountRoute }), RemoveTextKey, RemoveVoiceKey)
pure def lawStaleOrClosedChangeLeavesTheSession(k: KeySession, expected: int, change: KeyChange): bool =
  (k.closed or expected != k.revision) implies changeKeys(k, expected, change) == { session: k, reply: ProviderChanged }
pure def lawAppliedChangeIssuesANewRevision(k: KeySession, expected: int, change: KeyChange): bool =
  changeKeys(k, expected, change).reply == KeysChanged implies changeKeys(k, expected, change).session.revision > k.revision
pure def lawRefusedChangeChangesNothing(k: KeySession, expected: int, change: KeyChange): bool =
  changeKeys(k, expected, change).reply != KeysChanged implies changeKeys(k, expected, change).session == k
```

### The owner's own keys are chosen only with a text key, and the agent receives keys only on that route

Choosing the owner's own keys needs a saved text key. A launch receives the
saved keys only while the owner's own keys are the chosen route; on the
cloud account route it receives none. The session's status reports the
route, the revision and whether each key is saved, never a key.

```quint
type LaunchKeys = { given: bool, text: bool, voice: bool }
pure def launchKeys(k: KeySession): LaunchKeys =
  if (not(k.closed) and k.route == OwnKeysRoute) { given: true, text: k.textKey, voice: k.voiceKey } else { given: false, text: false, voice: false }
pure def lawOwnKeysNeedATextKey(k: KeySession, expected: int): bool =
  changeKeys(k, expected, ChooseRoute({ route: OwnKeysRoute })).reply == KeysChanged implies k.textKey
pure def lawCloudRouteLaunchesWithNoKeys(k: KeySession): bool =
  k.route == CloudAccountRoute implies not(launchKeys(k).given or launchKeys(k).text or launchKeys(k).voice)
```

### Closing the session forgets every key and refuses every later change

```quint
pure def closeKeys(k: KeySession): KeySession = { ...k, textKey: false, voiceKey: false, closed: true, revision: k.revision + 1 }
pure def lawClosedSessionHoldsNoKeys(k: KeySession, expected: int, change: KeyChange): bool = {
  val closedSession = closeKeys(k)
  not(closedSession.textKey) and not(closedSession.voiceKey) and not(launchKeys(closedSession).given) and
    changeKeys(closedSession, expected, change).reply == ProviderChanged
}
```

### A saved key is shown back only for the current revision, and an owner change invalidates every revision a screen holds

The owner may read back a saved key by naming the current revision; a stale
revision, a closed session or a key that is not saved shows nothing. When
the owner changes, the host invalidates the session's revision, so every
change prepared on an earlier screen is refused.

```quint
type KeyName = TextKeyName | VoiceKeyName
pure def revealAllowed(k: KeySession, expected: int, which: KeyName): bool =
  not(k.closed) and expected == k.revision and (if (which == TextKeyName) k.textKey else k.voiceKey)
pure def invalidateKeys(k: KeySession): KeySession = if (k.closed) k else { ...k, revision: k.revision + 1 }
pure def lawRevealNeedsTheCurrentRevisionAndASavedKey(k: KeySession, expected: int, which: KeyName): bool =
  revealAllowed(k, expected, which) implies
    (not(k.closed) and expected == k.revision and (which == TextKeyName implies k.textKey) and (which == VoiceKeyName implies k.voiceKey))
pure def lawInvalidationRefusesEveryEarlierRevision(k: KeySession, change: KeyChange): bool =
  not(k.closed) implies changeKeys(invalidateKeys(k), k.revision, change) == { session: invalidateKeys(k), reply: ProviderChanged }
```
