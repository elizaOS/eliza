# Workflow request custody

AlphaPhone's `apps/app/src/runtime/workflow-intents.ts` uses the shared
`WorkflowIntentStore` from `packages/contracts/src/workflow-intents.ts`.
The alpha namespace is `alpha.workflow.pending.v1:`. The encoded key
includes origin, owner, agent, and local request key. Android uses
per-key storage. The development browser uses an owner-scoped domain
archive seeded from existing keys. Its reset and export are product
operations. [Workflow admission](./workflow.md) owns remote executions.

## Story: Preserve the owner’s pending action across transport uncertainty

### A committed revision is the only receipt that can unlock its action

The model represents one key and its owner tuple. Compare-and-edit
is atomic and operates against durable storage. A missing snapshot locks
all keys for this store. An aborted or late read may not replace the
snapshot. A storage failure invalidates the cache even if the mutation
landed. A committed write refreshes the local cache and then reports the
change to observers. If an observer throws after commit, persistence
and the cache are still updated. The shell validates the owner prefix,
archive schema, revision UUID and raw JSON. The model tracks durable
commit and receipt as separate observations.

```quint
type IntentResult = NoIntentResult | IntentConfirmed | IntentConflict | IntentUnknown | IntentOtherOwner | IntentObserverFailed
type Intents = { owner: str, stored: int, serial: int, cached: int, epoch: int, readEpoch: int, readValue: int, reading: bool, result: IntentResult }
pure val initial: Intents = { owner: "", stored: 0, serial: 0, cached: -1, epoch: 0, readEpoch: 0, readValue: 0, reading: false, result: NoIntentResult }
pure def canOpenOwner(i: Intents, by: str): bool = i.owner == "" and by != ""
pure def openOwner(i: Intents, by: str): Intents = { ...i, owner: by }
pure def canReadArchive(i: Intents, by: str): bool = i.owner != "" and i.owner == by and not(i.reading)
pure def readArchive(i: Intents, by: str): Intents = { ...i, epoch: i.epoch + 1, readEpoch: i.epoch + 1, readValue: i.stored, reading: true }
pure def canCompleteRead(i: Intents): bool = i.reading
pure def completeRead(i: Intents, valid: bool, aborted: bool): Intents = { ...i, cached: if (valid and not(aborted) and i.readEpoch == i.epoch) i.readValue else i.cached, reading: false }
pure def invalidateCache(i: Intents): Intents = { ...i, epoch: i.epoch + 1, cached: -1 }
pure def locked(i: Intents): bool = i.cached != 0
pure def editResult(i: Intents, by: str, expected: int): IntentResult =
  if (i.owner == "" or i.owner != by) IntentOtherOwner else if (i.stored != expected) IntentConflict else IntentConfirmed
pure def editArchive(i: Intents, by: str, expected: int, landed: bool, acknowledged: bool, observerReturned: bool): Intents = {
  val admission = editResult(i, by, expected)
  val freshRevision = expected == 0 and landed and admission == IntentConfirmed
  val newStored = if (not(landed) or admission != IntentConfirmed) i.stored else if (freshRevision) i.serial + 1 else 0
  if (admission == IntentOtherOwner) { ...i, result: IntentOtherOwner }
  else if (admission == IntentConflict) { ...invalidateCache(i), result: IntentConflict }
  else if (not(landed) or not(acknowledged)) { ...invalidateCache(i), stored: newStored, serial: if (freshRevision) i.serial + 1 else i.serial, result: IntentUnknown }
  else { ...i, stored: newStored, serial: if (freshRevision) i.serial + 1 else i.serial, cached: newStored, epoch: i.epoch + 1, result: if (observerReturned) IntentConfirmed else IntentObserverFailed }
}
pure val byValues = Set("prod|owner|agent-a", "prod|owner|agent-b")
pure val expectedValues = Set(0, 1, 2, 3)
pure def alwaysIntentCoordinates(i: Intents): bool = i.epoch >= 0 and i.readEpoch >= 0 and i.readEpoch <= i.epoch and i.serial >= 0 and i.stored >= 0 and i.stored <= i.serial and i.cached >= -1 and i.cached <= i.serial and i.readValue >= 0 and i.readValue <= i.serial
pure def alwaysStoredNeedsOwner(i: Intents): bool = i.stored > 0 implies i.owner != ""
pure def stepStaleReadCannotUpdateCache(before: Intents, via: str, after: Intents): bool = (via == "completeRead" and before.readEpoch != before.epoch) implies after.cached == before.cached
pure def stepForeignEditRetainsArchive(before: Intents, via: str, after: Intents): bool = (via == "editArchive" and after.result == IntentOtherOwner) implies after.stored == before.stored
pure def stepConflictPreservesCurrentIntent(before: Intents, via: str, after: Intents): bool = (via == "editArchive" and after.result == IntentConflict) implies after.stored == before.stored and locked(after)
pure def sometimesAmbiguousWriteLocks(i: Intents): bool = i.result == IntentUnknown and i.stored > 0 and locked(i)
pure def sometimesObserverFailureRetainsWrite(i: Intents): bool = i.result == IntentObserverFailed and i.stored > 0 and i.cached == i.stored
```

### Reconciliation reads the definition before the retained submission receipt

AlphaPhone's workflow adapter reads the current definition and then
queries the retained submission. A matching execution settles the
intent even if the definition has advanced. An empty receipt after an
already-observed version change proves the submitted version cannot
admit later because version identities never recur. If the version was
still current, preserve the retained request and offer an explicit
resubmission of the same identity. An unreadable or unsupported intent
stays locked until the owner clears it. An owner switch retires the
result publication while the remote execution keeps its own lifetime.

```quint
type RecoveryDecision = IgnoreRetiredRecovery | PublishExistingRun | ConfirmDidNotRun | OfferSameSubmission | PreserveUnverifiable
pure def recoveryDecision(currentOwner: bool, canReconcile: bool, receiptValid: bool, receiptRun: bool, ownVersion: int, observedBeforeReceipt: int): RecoveryDecision =
  if (not(currentOwner)) IgnoreRetiredRecovery
  else if (not(canReconcile) or not(receiptValid)) PreserveUnverifiable
  else if (receiptRun) PublishExistingRun
  else if (ownVersion != observedBeforeReceipt) ConfirmDidNotRun
  else OfferSameSubmission
pure val ownVersionValues = Set(1, 2)
pure val observedBeforeReceiptValues = Set(1, 2)
pure def lawDefiniteNonRunRequiresEarlierVersionObservation(currentOwner: bool, canReconcile: bool, receiptValid: bool, receiptRun: bool, ownVersion: int, observedBeforeReceipt: int): bool =
  recoveryDecision(currentOwner, canReconcile, receiptValid, receiptRun, ownVersion, observedBeforeReceipt) == ConfirmDidNotRun implies currentOwner and canReconcile and receiptValid and not(receiptRun) and ownVersion != observedBeforeReceipt
```
