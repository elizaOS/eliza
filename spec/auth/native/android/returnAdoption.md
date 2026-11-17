# Android return adoption

A browser Google sign-in can return to a process that did not start it:
Android may end the host while the browser is in front. The Android sign-in
plugin then adopts the return only through the host's durable credential
generation, kept by the secure store's credential intent fence. The pending
record carries the generation recorded when its attempt reserved its
credential intent. The renderer side of a browser return is
[browser return](../browserReturn.md).

## Story: Complete a browser sign-in after Android restarted the app

> As a person signing in with Google in the browser, I want the sign-in to
> finish when I come back even if the app was restarted meanwhile, but
> never after I signed out or started something else.

### A return completes only while no credential action was reserved since its record was written

An attempt reserves its credential intent and writes a pending record
with the durable generation at that moment; a host without a durable
generation records none. Any credential action (a sign-out, another
sign-in, a provider change, a reset) reserves an intent and advances the
generation, and a sign-out or completed sign-in also removes the record.
A return in a process with no attempt of its own is adopted only while the
record exists, is unexpired, and carries the current generation. Adoption
reserves nothing. The record is consumed, then the key is saved, each
under the adopted intent: a credential action after adoption wins, and
the return finishes without saving.

```quint
type ReturnPhase = NoAttempt | AwaitingReturn | AdoptedReturn | ConsumedReturn | FinishedReturn
type ReturnAdoption = { ledger: int, hasLedger: bool, record: bool, recordGeneration: int, recordExpired: bool,
  epoch: int, processes: int, attemptActive: bool, adoptedAt: int, phase: ReturnPhase,
  actionsSinceRecord: int, completions: int, completedAfterAction: bool }
pure val initial: ReturnAdoption = { ledger: 0, hasLedger: false, record: false, recordGeneration: 0, recordExpired: false,
  epoch: 0, processes: 1, attemptActive: false, adoptedAt: -1, phase: NoAttempt,
  actionsSinceRecord: 0, completions: 0, completedAfterAction: false }
pure def canBeginAttempt(s: ReturnAdoption): bool = s.phase == NoAttempt
pure def beginAttempt(s: ReturnAdoption, withLedger: bool): ReturnAdoption =
  { ...s, hasLedger: withLedger, ledger: if (withLedger) 1 else 0, record: true, recordGeneration: if (withLedger) 1 else 0,
    epoch: 1, attemptActive: true, phase: AwaitingReturn }
pure def canProcessDeath(s: ReturnAdoption): bool = s.phase != NoAttempt
pure def processDeath(s: ReturnAdoption): ReturnAdoption =
  { ...s, processes: s.processes + 1, epoch: 0, attemptActive: false, adoptedAt: -1, phase: AwaitingReturn }
pure def canCredentialAction(s: ReturnAdoption): bool = s.phase != NoAttempt
pure def credentialAction(s: ReturnAdoption, removesRecord: bool): ReturnAdoption =
  { ...s, epoch: s.epoch + 1, ledger: if (s.hasLedger) s.ledger + 1 else s.ledger,
    actionsSinceRecord: s.actionsSinceRecord + 1, record: s.record and not(removesRecord) }
pure def canRecordExpires(s: ReturnAdoption): bool = s.record and not(s.recordExpired)
pure def recordExpires(s: ReturnAdoption): ReturnAdoption = { ...s, recordExpired: true }
pure def adoptable(s: ReturnAdoption): bool =
  s.record and s.recordGeneration != 0 and not(s.recordExpired) and s.hasLedger and s.recordGeneration == s.ledger
pure def canReturnArrives(s: ReturnAdoption): bool = s.processes > 1 and s.phase == AwaitingReturn and not(s.attemptActive)
pure def returnArrives(s: ReturnAdoption): ReturnAdoption =
  if (adoptable(s)) { ...s, adoptedAt: s.epoch, attemptActive: true, phase: AdoptedReturn }
  else { ...s, phase: FinishedReturn }
pure def canConsume(s: ReturnAdoption): bool = s.phase == AdoptedReturn
pure def consume(s: ReturnAdoption): ReturnAdoption =
  if (s.adoptedAt == s.epoch and s.record) { ...s, record: false, phase: ConsumedReturn }
  else { ...s, attemptActive: false, phase: FinishedReturn }
pure def canSave(s: ReturnAdoption): bool = s.phase == ConsumedReturn
pure def save(s: ReturnAdoption): ReturnAdoption =
  if (s.adoptedAt == s.epoch)
    { ...s, attemptActive: false, phase: FinishedReturn, completions: s.completions + 1,
      completedAfterAction: s.completedAfterAction or s.actionsSinceRecord > 0 }
  else { ...s, attemptActive: false, phase: FinishedReturn }
pure def alwaysCompletesOnlyWithoutNewerAction(s: ReturnAdoption): bool = not(s.completedAfterAction)
pure def alwaysAdoptedOwnerBound(s: ReturnAdoption): bool =
  (s.phase == AdoptedReturn or s.phase == ConsumedReturn) implies (s.adoptedAt >= 0 and s.adoptedAt <= s.epoch and s.attemptActive)
pure def sometimesReturnCompletedInNewProcess(s: ReturnAdoption): bool = s.completions == 1 and s.processes > 1
pure def sometimesNewerActionRefusedReturn(s: ReturnAdoption): bool =
  s.phase == FinishedReturn and s.completions == 0 and s.actionsSinceRecord > 0 and s.processes > 1
```

### Nothing happens before the first attempt, and the process epoch is never negative

Before the first attempt there has been no credential action and no
completion. The process epoch starts at zero and is never negative.

```quint
pure def alwaysNothingBeforeTheAttempt(s: ReturnAdoption): bool = s.phase == NoAttempt implies (s.actionsSinceRecord == 0 and s.completions == 0)
pure def alwaysEpochNeverNegative(s: ReturnAdoption): bool = s.epoch >= 0
```

### An adopted return has seen no credential action since its record

Adoption compares the record's generation with the ledger's, and every
credential action advances the ledger. So a return adopted under the
current intent has seen no credential action since its record was
written, and a record names a generation only while the host keeps a
durable ledger.

```quint
pure def alwaysAdoptionSawNoNewerAction(s: ReturnAdoption): bool =
  ((s.phase == AdoptedReturn or s.phase == ConsumedReturn) and s.adoptedAt == s.epoch) implies s.actionsSinceRecord == 0
pure def alwaysGenerationTracksActions(s: ReturnAdoption): bool =
  (s.hasLedger implies (s.recordGeneration == 1 and s.ledger == 1 + s.actionsSinceRecord)) and
    (not(s.hasLedger) implies (s.recordGeneration == 0 and s.ledger == 0)) and s.actionsSinceRecord >= 0
```

### A record completes at most once, and never without a durable generation

A consumed record is gone, so a repeated return finds nothing to adopt.
A host that recorded no durable generation never completes a return in
a new process: it cannot tell whether a credential action happened.
An adopted return therefore belongs to a host with a durable generation
and has not completed yet, and once it consumed its record the record is
gone.

```quint
pure def alwaysSingleUse(s: ReturnAdoption): bool = s.completions == 0 or s.completions == 1
pure def alwaysNoLedgerNoCompletion(s: ReturnAdoption): bool = not(s.hasLedger) implies s.completions == 0
pure def alwaysCompletionConsumedRecord(s: ReturnAdoption): bool = s.completions > 0 implies not(s.record)
pure def alwaysAdoptedReturnHoldsLedger(s: ReturnAdoption): bool =
  ((s.phase == AdoptedReturn or s.phase == ConsumedReturn) implies (s.hasLedger and s.completions == 0)) and
    (s.phase == ConsumedReturn implies not(s.record))
```
