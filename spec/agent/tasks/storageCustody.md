# Encrypted task storage custody

A consumer keeps an account's task data in one encrypted database on the
device, with its own derived database and file keys and a separate
authenticated purpose for task evidence and the outcome journal. This spec
owns who may open that database, how a writer is fenced, what an operation
may report, and how sealed evidence is reopened. Key creation and deletion
belong to the consumer's account custody, and moving old data to
[storage migration](./storageMigration.md).

## Story: Refuse task storage when encrypted custody cannot be verified

> As a user, my task data is stored only when the encrypted driver, private
> path, key and owner are all verified; otherwise storage is refused.

### Storage opens only with the current private lock, a 32-byte key and a verified owner, and the fetched key is always wiped

Opening needs a canonical private path, an exclusive lock on the current
named lock file and a verified owner; only then is the key requested, and a
contender fails without requesting one. The key must be exactly 32 bytes,
the owner is checked again after it is fetched, and the accepted encrypted
driver must open the exact path under that lease, which moves into the
connection once. Whatever happens, a fetched key is wiped.

```quint
type WriterPhase = WriterFree | WriterLease | WriterKeyPending | WriterConnected
type TaskStore = { ownerEpoch: int, handleEpoch: int, inode: int, lastLease: int, liveLease: int, phase: WriterPhase, keyWiped: bool }
type LockEvidence = { canonicalPrivatePath: bool, ownerBeforeLease: bool, exclusiveLock: bool, namedEntryMatches: bool }
type KeyEvidence = { keyReturned: bool, exactly32Bytes: bool, ownerAfterKey: bool, acceptedDriver: bool, exactLeasePath: bool, nativeOpened: bool }
pure val initial: TaskStore = { ownerEpoch: 1, handleEpoch: 0, inode: 1, lastLease: 0, liveLease: 0, phase: WriterFree, keyWiped: false }
pure def permitsLock(lockFacts: LockEvidence): bool =
  lockFacts.canonicalPrivatePath and lockFacts.ownerBeforeLease and lockFacts.exclusiveLock and lockFacts.namedEntryMatches
pure def permitsLeaseTransfer(keyFacts: KeyEvidence): bool =
  keyFacts.keyReturned and keyFacts.exactly32Bytes and keyFacts.ownerAfterKey and keyFacts.acceptedDriver and
    keyFacts.exactLeasePath and keyFacts.nativeOpened
pure def isCurrentLease(s: TaskStore, leaseId: int, lockInode: int): bool =
  leaseId > 0 and leaseId == s.liveLease and lockInode == s.inode
pure def canLockWriter(s: TaskStore, lockFacts: LockEvidence): bool = s.phase == WriterFree and permitsLock(lockFacts)
pure def lockWriter(s: TaskStore, lockFacts: LockEvidence): TaskStore =
  { ...s, lastLease: s.lastLease + 1, liveLease: s.lastLease + 1, phase: WriterLease, keyWiped: false }
pure def canStartKeyFetch(s: TaskStore, leaseId: int, lockInode: int, ownerBeforeKey: bool): bool =
  s.phase == WriterLease and isCurrentLease(s, leaseId, lockInode) and ownerBeforeKey
pure def startKeyFetch(s: TaskStore, leaseId: int, lockInode: int, ownerBeforeKey: bool): TaskStore = { ...s, phase: WriterKeyPending }
pure def canAbortBeforeKey(s: TaskStore, leaseId: int, lockInode: int): bool = s.phase == WriterLease and isCurrentLease(s, leaseId, lockInode)
pure def abortBeforeKey(s: TaskStore, leaseId: int, lockInode: int): TaskStore = { ...s, phase: WriterFree, liveLease: 0 }
pure def canFinishOpen(s: TaskStore, leaseId: int, lockInode: int): bool =
  s.phase == WriterKeyPending and isCurrentLease(s, leaseId, lockInode)
pure def finishOpen(s: TaskStore, leaseId: int, lockInode: int, keyFacts: KeyEvidence): TaskStore =
  if (permitsLeaseTransfer(keyFacts)) { ...s, phase: WriterConnected, handleEpoch: s.ownerEpoch, keyWiped: true }
  else { ...s, phase: WriterFree, liveLease: 0, keyWiped: keyFacts.keyReturned }
pure val privateLock: LockEvidence = { canonicalPrivatePath: true, ownerBeforeLease: true, exclusiveLock: true, namedEntryMatches: true }
pure val lockFactsValues = Set(privateLock, { ...privateLock, canonicalPrivatePath: false }, { ...privateLock, ownerBeforeLease: false },
  { ...privateLock, exclusiveLock: false }, { ...privateLock, namedEntryMatches: false })
pure val admittedKey: KeyEvidence = { keyReturned: true, exactly32Bytes: true, ownerAfterKey: true, acceptedDriver: true, exactLeasePath: true, nativeOpened: true }
pure val keyFactsValues = Set(admittedKey, { ...admittedKey, keyReturned: false }, { ...admittedKey, exactly32Bytes: false },
  { ...admittedKey, ownerAfterKey: false }, { ...admittedKey, acceptedDriver: false })
pure val leaseIdValues = Set(0, 1, 2, 3)
pure val lockInodeValues = Set(0, 1, 2, 3)
pure val weight_lockWriter = 8
pure val weight_startKeyFetch = 8
pure val weight_finishOpen = 10
pure def lawNoKeyWithoutExclusiveCurrentLock(lockFacts: LockEvidence): bool =
  not(lockFacts.exclusiveLock and lockFacts.namedEntryMatches) implies not(permitsLock(lockFacts))
pure def alwaysLeaseCoordinates(s: TaskStore): bool =
  s.inode > 0 and s.lastLease >= 0 and s.liveLease >= 0 and s.handleEpoch >= 0 and s.handleEpoch <= s.ownerEpoch and
  (s.phase == WriterFree implies s.liveLease == 0) and
  (s.phase != WriterFree implies s.liveLease == s.lastLease and s.liveLease > 0)
pure def alwaysConnectedKeyHasBeenWiped(s: TaskStore): bool = s.phase == WriterConnected implies s.keyWiped
pure def lawFetchedKeyIsWiped(store: TaskStore, leaseId: int, lockInode: int, keyFacts: KeyEvidence): bool =
  keyFacts.keyReturned implies finishOpen(store, leaseId, lockInode, keyFacts).keyWiped
pure def sometimesOpenedAndWiped(s: TaskStore): bool = s.phase == WriterConnected and s.keyWiped
pure def sometimesFailedOpenWipesKey(s: TaskStore): bool = s.phase == WriterFree and s.lastLease > 0 and s.keyWiped
```

## Story: Let the process that writes the encrypted database hold its lease

> As a user, only the one process that holds the writer lease can open my
> encrypted task database, and a retired writer can no longer write.

### Replacing the named lock fences the old writer

Closing the connection frees its lease and keeps the lock file, so the next
writer can take it; the writer's death frees it too, and a release or death
of an older lease never touches a newer writer. Replacing the named lock
entry gives it a new identity: the old descriptor may still hold the old
one, but no operation runs through it, and a new writer can take the new
entry. While a writer holds the lease, no contender can.

```quint
type NamedLeaseEvidence = { descriptorLive: bool, validNamedFile: bool, leaseInode: int, descriptorInode: int, namedInode: int }
pure def descriptorStillCurrent(namedLease: NamedLeaseEvidence): bool =
  namedLease.descriptorLive and namedLease.validNamedFile and
  namedLease.namedInode == namedLease.leaseInode and namedLease.descriptorInode == namedLease.namedInode
pure def lawReplacedEntryIsNotCurrent(namedLease: NamedLeaseEvidence): bool =
  namedLease.namedInode != namedLease.leaseInode implies not(descriptorStillCurrent(namedLease))
pure val exactLockIdentity: NamedLeaseEvidence = { descriptorLive: true, validNamedFile: true, leaseInode: 1, descriptorInode: 1, namedInode: 1 }
pure val namedLeaseValues = Set(exactLockIdentity, { ...exactLockIdentity, namedInode: 2 }, { ...exactLockIdentity, descriptorInode: 2 },
  { ...exactLockIdentity, descriptorLive: false }, { ...exactLockIdentity, validNamedFile: false })
pure def canCloseWriter(s: TaskStore, leaseId: int, lockInode: int): bool =
  s.phase == WriterConnected and isCurrentLease(s, leaseId, lockInode)
pure def closeWriter(s: TaskStore, leaseId: int, lockInode: int): TaskStore = { ...s, phase: WriterFree, liveLease: 0 }
pure def releaseOnDeath(leaseId: int, lockInode: int, store: TaskStore): TaskStore =
  if (isCurrentLease(store, leaseId, lockInode)) { ...store, phase: WriterFree, liveLease: 0 } else store
pure def canObserveWriterDeath(s: TaskStore, leaseId: int, lockInode: int): bool = s.phase != WriterFree
pure def observeWriterDeath(s: TaskStore, leaseId: int, lockInode: int): TaskStore = releaseOnDeath(leaseId, lockInode, s)
pure def replaceNamedLock(s: TaskStore): TaskStore = { ...s, inode: s.inode + 1, phase: WriterFree, liveLease: 0, keyWiped: false }
pure val storeValues = Set(initial, { ...initial, phase: WriterKeyPending, lastLease: 1, liveLease: 1 },
  { ...initial, phase: WriterConnected, handleEpoch: 1, lastLease: 2, liveLease: 2, keyWiped: true })
pure def lawOldDeathDoesNotReleaseNewWriter(store: TaskStore, leaseId: int, lockInode: int): bool =
  not(isCurrentLease(store, leaseId, lockInode)) implies releaseOnDeath(leaseId, lockInode, store) == store
pure def lawContenderCannotTakeHeldWriter(store: TaskStore, lockFacts: LockEvidence): bool =
  store.phase != WriterFree implies not(canLockWriter(store, lockFacts))
pure def stepWriterIdentitiesNeverRegress(before: TaskStore, after: TaskStore): bool =
  after.inode >= before.inode and after.lastLease >= before.lastLease and after.ownerEpoch >= before.ownerEpoch
pure def sometimesReplacementCanOpen(s: TaskStore): bool = s.phase == WriterConnected and s.inode > 1
```

## Story: Return an encrypted operation's receipt only while ownership still permits it

> As a user, an operation on my encrypted task data reports its result only
> while its owner still holds it, and a refusal after a write never claims
> the write did not happen.

### An operation returns a result only while ownership holds before and after it

Each statement runs only on the current writer's connection, opened in the
current owner epoch, with the owner confirmed before it runs; losing account
custody starts a new epoch, so no earlier connection or prepared statement
answers again. The result is returned only if the owner is confirmed again
afterwards. A refusal after a write-capable statement ran says nothing about
what was committed: its outcome is unknown, it is never retried, and only a
separately authorized read can establish it. Encryption is verified only on
this store's own connection and path.

```quint
type OperationEvidence = { ownerBefore: bool, canWrite: bool, nativeSucceeded: bool, ownerAfter: bool }
type OperationReceipt = RefusedBeforeSql | Returned | WriteOutcomeUnknown | ReadRefused
pure def permitsOperation(store: TaskStore, leaseId: int, lockInode: int, queryEpoch: int): bool =
  store.phase == WriterConnected and isCurrentLease(store, leaseId, lockInode) and
    store.handleEpoch == store.ownerEpoch and queryEpoch == store.ownerEpoch
pure def operationReceipt(admitted: bool, operation: OperationEvidence): OperationReceipt =
  if (not(admitted and operation.ownerBefore)) RefusedBeforeSql
  else if (operation.nativeSucceeded and operation.ownerAfter) Returned
  else if (operation.canWrite) WriteOutcomeUnknown
  else ReadRefused
pure def verifiesBoundConnection(exactProviderConnection: bool, exactDatabasePath: bool, operation: OperationEvidence, nativeTrue: bool): bool =
  exactProviderConnection and exactDatabasePath and operationReceipt(true, operation) == Returned and nativeTrue
pure def loseCustody(s: TaskStore): TaskStore = { ...s, ownerEpoch: s.ownerEpoch + 1 }
pure val knownOperation: OperationEvidence = { ownerBefore: true, canWrite: true, nativeSucceeded: true, ownerAfter: true }
pure val operationValues = Set(knownOperation, { ...knownOperation, ownerAfter: false }, { ...knownOperation, ownerBefore: false },
  { ...knownOperation, nativeSucceeded: false }, { ...knownOperation, canWrite: false, ownerAfter: false })
pure val queryEpochValues = Set(0, 1, 2)
pure def lawLostOwnerCannotReturnResult(admitted: bool, operation: OperationEvidence): bool =
  not(operation.ownerBefore and operation.ownerAfter) implies operationReceipt(admitted, operation) != Returned
pure def lawPostWriteRefusalKeepsOutcomeUnknown(operation: OperationEvidence): bool =
  (operation.ownerBefore and operation.canWrite and not(operation.ownerAfter)) implies operationReceipt(true, operation) == WriteOutcomeUnknown
pure def lawVerificationRequiresOwnConnection(exactProviderConnection: bool, exactDatabasePath: bool, operation: OperationEvidence, nativeTrue: bool): bool =
  not(exactProviderConnection and exactDatabasePath) implies not(verifiesBoundConnection(exactProviderConnection, exactDatabasePath, operation, nativeTrue))
pure def lawEarlierEpochRejectsOperation(store: TaskStore, leaseId: int, lockInode: int, queryEpoch: int): bool =
  queryEpoch != store.ownerEpoch implies not(permitsOperation(store, leaseId, lockInode, queryEpoch))
pure def lawReplacedLockRejectsOperation(store: TaskStore, leaseId: int, lockInode: int, queryEpoch: int): bool =
  lockInode != store.inode implies not(permitsOperation(store, leaseId, lockInode, queryEpoch))
pure def sometimesRetiredConnectionRefused(s: TaskStore): bool = s.phase == WriterConnected and s.handleEpoch < s.ownerEpoch
```

### Open normalizes an owner refusal, and a live operation passes on a thrown owner-check value

The owner check is a callback the consumer supplies. Opening checks the
owner before acquiring the lease, before requesting the key, after the key
returns and after the native open; a return other than undefined, or a
throw, at any of these checks fails the open with
`TASK_STORAGE_UNAVAILABLE` once cleanup completes. After the open,
preparing, executing and verifying on a live connection pass on the exact
value the callback threw, whether the check runs before or after the native
call, and a return other than undefined gives `TASK_STORAGE_UNAVAILABLE`
at either point. A closed connection or a wrong connection binding fails
before the callback is consulted, and the open validates the path shape
before its first owner check. Closing runs whatever the callback says. A
native cleanup call that itself fails remains a native error.

```quint
type OwnerCheckBoundary = OpeningConnection | UsingConnection
type OwnerCheckObservation = CallbackAllowed | CallbackReturnedValue | CallbackThrew
type OwnerGuardResult = OwnerCheckPassed | StorageUnavailable | PropagateCallbackValue
type OwnerGuardDecision = { checkedOwner: bool, outcome: OwnerGuardResult }
pure def ownerGuardResult(guardBoundary: OwnerCheckBoundary, boundaryAdmitted: bool, guardObservation: OwnerCheckObservation): OwnerGuardDecision =
  if (not(boundaryAdmitted)) { checkedOwner: false, outcome: StorageUnavailable }
  else { checkedOwner: true, outcome:
    if (guardObservation == CallbackAllowed) OwnerCheckPassed
    else if (guardBoundary == UsingConnection and guardObservation == CallbackThrew) PropagateCallbackValue
    else StorageUnavailable }
pure def lawThrownOwnerErrorSurvivesOperationSentinel(boundaryAdmitted: bool): bool =
  boundaryAdmitted implies ownerGuardResult(UsingConnection, boundaryAdmitted, CallbackThrew).outcome == PropagateCallbackValue
pure def lawOpenNormalizesOwnerRefusal(guardObservation: OwnerCheckObservation): bool =
  guardObservation != CallbackAllowed implies ownerGuardResult(OpeningConnection, true, guardObservation).outcome == StorageUnavailable
pure def lawIneligibleBoundaryRefusesBeforeOwnerCallback(guardBoundary: OwnerCheckBoundary, guardObservation: OwnerCheckObservation): bool = {
  val decision = ownerGuardResult(guardBoundary, false, guardObservation)
  not(decision.checkedOwner) and decision.outcome == StorageUnavailable
}
```

## Story: Reopen sealed evidence without exposing it across stores

> As a user, sealed task evidence opens only under its own account key,
> namespace and purpose, never in another store.

### A sealed payload is restricted to its account key, namespace and purpose

Database and file keys are derived separately. A sealed file carries an
authenticated namespace and purpose with a fresh nonce and tag, and opens
only when it verifies under the current owner's account key, namespace and
purpose; a failed verification is an explicit storage error.

```quint
type StoragePurpose = OutcomeJournal | TaskEvidence | WebsiteEvidence
type SealedHeader = { keyId: str, namespace: str, purpose: StoragePurpose, authenticated: bool }
pure def permitsOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose, ownerCurrent: bool): bool =
  ownerCurrent and header.authenticated and header.keyId == keyId and
  header.namespace == namespace and header.purpose == purpose
pure def lawAnotherPurposeCannotOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose): bool =
  header.purpose != purpose implies not(permitsOpen(header, keyId, namespace, purpose, true))
pure def lawUnverifiedCiphertextCannotOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose): bool =
  not(header.authenticated) implies not(permitsOpen(header, keyId, namespace, purpose, true))
pure def lawForeignAccountKeyCannotOpen(header: SealedHeader, keyId: str, namespace: str, purpose: StoragePurpose): bool =
  header.keyId != keyId implies not(permitsOpen(header, keyId, namespace, purpose, true))
pure val headerValues = Set(
  { keyId: "slotA", namespace: "consumerA", purpose: OutcomeJournal, authenticated: true },
  { keyId: "slotA", namespace: "consumerA", purpose: TaskEvidence, authenticated: true },
  { keyId: "slotA", namespace: "consumerA", purpose: TaskEvidence, authenticated: false })
pure val keyIdValues = Set("slotA", "slotB")
pure val namespaceValues = Set("consumerA", "consumerB")
```
