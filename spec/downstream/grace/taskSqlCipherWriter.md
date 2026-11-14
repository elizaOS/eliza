# Grace task SQLCipher writer lease

The installed Grace task gateway at `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` imports the SQLCipher task provider from Eliza `7743504b7c936a764b3938a44cad918808b621df`. This contract refines the writer lease and operation receipt within task storage custody. Grace's account-slot key derivation, file sealing, and migration have their own contracts. This model observes one exact database path, its current named lock inode, and opaque leases and database handles. Native filesystem checks, SQLite execution, and cryptography come from their respective boundaries.

## Story: Let the process that writes the encrypted database hold its lease

### Only the current private lock permits key resolution

The provider's `open({path})` requires an absolute canonical path and a private database parent before acquiring the native lease. The first synchronous `checkOwner` must return undefined. A thrown or other returned value fails admission. The provider normalizes failures caught during open to TASK_STORAGE_UNAVAILABLE. The native lease opens `<database>.writer.lock` read/write with create, close-on-exec and no-follow flags. It checks a single-link regular file owned by the effective user at mode 0600, gets an exclusive nonblocking flock, and checks the named entry still matches the admitted device and inode of the descriptor. Only after acquisition and another successful owner check does the provider call `resolveKey({path})`. A contending opener fails without requesting a key or creating a database. File validation and the kernel's acquisition are inputs to this predicate, with the single current inode modeled below.

Grace `apps/app/host/task-storage-native.ts:14,88–107`. Eliza `packages/host/native-host/task-sqlcipher.mjs:121–153,164–199` and `task-sqlcipher/writer-lease.h:18–61`.

```quint
type LockEvidence = { canonicalPrivateParent: bool, ownerBeforeLease: bool, descriptorOpened: bool, regularSingleLink: bool, effectiveUid: bool, ownerOnlyMode: bool, nonblockingLockAcquired: bool, namedEntryMatches: bool }
pure def permitsLock(lockFacts: LockEvidence): bool =
  lockFacts.canonicalPrivateParent and lockFacts.ownerBeforeLease and lockFacts.descriptorOpened and lockFacts.regularSingleLink and
  lockFacts.effectiveUid and lockFacts.ownerOnlyMode and lockFacts.nonblockingLockAcquired and lockFacts.namedEntryMatches
pure def permitsKeyRequest(lockFacts: LockEvidence, ownerBeforeKey: bool): bool =
  permitsLock(lockFacts) and ownerBeforeKey
pure def lawNoKeyWithoutExclusiveCurrentLock(lockFacts: LockEvidence, ownerBeforeKey: bool): bool =
  not(lockFacts.nonblockingLockAcquired and lockFacts.namedEntryMatches) implies not(permitsKeyRequest(lockFacts, ownerBeforeKey))
pure val privateLock: LockEvidence = { canonicalPrivateParent: true, ownerBeforeLease: true, descriptorOpened: true, regularSingleLink: true, effectiveUid: true, ownerOnlyMode: true, nonblockingLockAcquired: true, namedEntryMatches: true }
pure val lockFactsValues = Set(privateLock, { ...privateLock, canonicalPrivateParent: false }, { ...privateLock, ownerBeforeLease: false }, { ...privateLock, descriptorOpened: false }, { ...privateLock, regularSingleLink: false }, { ...privateLock, effectiveUid: false }, { ...privateLock, ownerOnlyMode: false }, { ...privateLock, nonblockingLockAcquired: false }, { ...privateLock, namedEntryMatches: false })
```

### Admission transfers the exact path lease once and wipes the fetched key

A key return is checked against the owner again. Only a 32-byte Uint8Array can be used. The caller is responsible for returning a fresh disposable array. The existing database must be a process-owned single-link regular file with mode 0600, or the adapter creates it exclusively at mode 0600. The native handle checks that its tagged lease is still current and carries the exact path. It rejects an invalid key or a path with a question mark. At SQLite open it moves the native lease out of the tagged object into the connection. The same lease object cannot open a second connection. Its subsequent release call is harmless because that object owns no lease. The driver disposes of the connection and lease if SQLCipher admission fails after transfer. If the final synchronous owner check throws after a native handle is returned, the provider closes that handle. The provider wipes any returned Uint8Array in its finally block, including when its length was wrong or the owner check failed. If key resolution has not settled, cleanup is not yet complete and the writer exclusion is still held. The model records one current opening or connection and the key-wipe receipt. A captured lease that no longer matches the named inode cannot open a connection. Its own admission still has to wipe any fetched byte array. That cleanup does not report a result for the current writer. The model does not store keys.

Eliza `task-sqlcipher.mjs:132–160,182–209` and `task-sqlcipher/driver.c:72–135,185–270`.

```quint
type KeyEvidence = { byteArrayReturned: bool, exactly32Bytes: bool, ownerAfterKey: bool, privateDatabase: bool, exactLeasePath: bool, nativePathAllowed: bool }
pure def permitsLeaseTransfer(keyFacts: KeyEvidence): bool =
  keyFacts.byteArrayReturned and keyFacts.exactly32Bytes and keyFacts.ownerAfterKey and keyFacts.privateDatabase and keyFacts.exactLeasePath and keyFacts.nativePathAllowed
pure def wipeFetchedKey(keyFacts: KeyEvidence): bool = keyFacts.byteArrayReturned
pure def lawRejectedByteArrayStillGetsWiped(keyFacts: KeyEvidence): bool =
  keyFacts.byteArrayReturned and not(permitsLeaseTransfer(keyFacts)) implies wipeFetchedKey(keyFacts)
pure val admittedKey: KeyEvidence = { byteArrayReturned: true, exactly32Bytes: true, ownerAfterKey: true, privateDatabase: true, exactLeasePath: true, nativePathAllowed: true }
pure val keyFactsValues = Set(admittedKey, { ...admittedKey, byteArrayReturned: false }, { ...admittedKey, exactly32Bytes: false }, { ...admittedKey, ownerAfterKey: false }, { ...admittedKey, privateDatabase: false }, { ...admittedKey, exactLeasePath: false }, { ...admittedKey, nativePathAllowed: false })
type Writer = { inode: int, lastLease: int, liveLease: int, phase: str, keyWiped: bool }
pure val initial: Writer = { inode: 1, lastLease: 0, liveLease: 0, phase: "free", keyWiped: false }
pure def isCurrentLease(writer: Writer, leaseId: int, lockInode: int): bool =
  leaseId > 0 and leaseId == writer.liveLease and lockInode == writer.inode
pure def canLockWriter(writer: Writer, lockFacts: LockEvidence): bool = writer.phase == "free" and permitsLock(lockFacts)
pure def lockWriter(writer: Writer, lockFacts: LockEvidence): Writer =
  { ...writer, lastLease: writer.lastLease + 1, liveLease: writer.lastLease + 1, phase: "lease", keyWiped: false }
pure def canStartKeyFetch(writer: Writer, leaseId: int, lockInode: int, ownerBeforeKey: bool): bool =
  writer.phase == "lease" and isCurrentLease(writer, leaseId, lockInode) and ownerBeforeKey
pure def startKeyFetch(writer: Writer, leaseId: int, lockInode: int, ownerBeforeKey: bool): Writer = { ...writer, phase: "key-pending" }
pure def canFinishOpen(writer: Writer, leaseId: int, lockInode: int): bool =
  writer.phase == "key-pending" and isCurrentLease(writer, leaseId, lockInode)
pure def finishOpen(writer: Writer, leaseId: int, lockInode: int, keyFacts: KeyEvidence, nativeOpened: bool, ownerAfterOpen: bool): Writer =
  if (permitsLeaseTransfer(keyFacts) and nativeOpened and ownerAfterOpen)
    { ...writer, phase: "connection", keyWiped: true }
  else { ...writer, phase: "free", liveLease: 0, keyWiped: wipeFetchedKey(keyFacts) }
pure def canAbortBeforeKey(writer: Writer, leaseId: int, lockInode: int): bool = writer.phase == "lease" and isCurrentLease(writer, leaseId, lockInode)
pure def abortBeforeKey(writer: Writer, leaseId: int, lockInode: int): Writer =
  { ...writer, phase: "free", liveLease: 0 }
pure def alwaysLeaseCoordinates(writer: Writer): bool =
  writer.inode > 0 and writer.lastLease >= 0 and writer.liveLease >= 0 and
  (writer.phase == "free" implies writer.liveLease == 0) and
  (writer.phase != "free" implies writer.liveLease == writer.lastLease and writer.liveLease > 0)
pure def alwaysConnectedKeyHasBeenWiped(writer: Writer): bool = writer.phase == "connection" implies writer.keyWiped
pure def sometimesOpenedAndWiped(writer: Writer): bool = writer.phase == "connection" and writer.keyWiped
pure def sometimesFailedOpenWipesKey(writer: Writer): bool = writer.phase == "free" and writer.lastLease > 0 and writer.keyWiped
pure val leaseIdValues = Set(0, 1, 2, 3)
pure val lockInodeValues = Set(0, 1, 2, 3)
pure val weight_lockWriter = 8
pure val weight_startKeyFetch = 8
pure val weight_finishOpen = 10
```

### Retiring a writer frees its descriptor, and changing the named inode fences the old writer

On successful close, the connection releases its descriptor without unlinking the persistent lock file. The ordinary replacement writer can acquire the same inode. Close can run even when the owner guard or the named lock guard would refuse a database operation. The writing process's death closes the descriptor. A separate credential broker's death cannot free the descriptor held by the writer, and an exec'ed child does not inherit it. If the named entry is replaced, the old descriptor can continue holding its old inode but `unwrap` rejects that connection against the current named entry. A replacement writer can acquire the new valid entry. This machine reconstructs the effective writer for the current inode. Replacing the named entry clears that slot without closing any stale descriptor. Exact current lease identity is required to release the current slot. A release or later completion for an old lease cannot affect a newer connection. The old descriptor still has its normal close or process-death lifecycle. The machine covers replacement by a distinct inode, with monotonic identifiers for that sequence. The native identity predicate separately checks exact device and inode. An external owner that puts the original named inode back while its descriptor remains live can satisfy that native predicate again. The model prescribes no authority over such a filesystem change.

Eliza `task-sqlcipher/writer-lease.h:18–61`, `task-sqlcipher/driver.c:31–55,270–287`, and `task-sqlcipher.mjs:211–245`.

```quint
type NamedLeaseEvidence = { descriptorLive: bool, validNamedFile: bool, leaseDevice: int, leaseInode: int, descriptorDevice: int, descriptorInode: int, namedDevice: int, namedInode: int }
pure def descriptorStillCurrent(namedLease: NamedLeaseEvidence): bool =
  namedLease.descriptorLive and namedLease.validNamedFile and
  namedLease.namedDevice == namedLease.leaseDevice and namedLease.namedInode == namedLease.leaseInode and
  namedLease.descriptorDevice == namedLease.namedDevice and namedLease.descriptorInode == namedLease.namedInode
pure def lawReplacementRequiresDifferentNativeIdentity(namedLease: NamedLeaseEvidence): bool =
  namedLease.namedDevice != namedLease.leaseDevice or namedLease.namedInode != namedLease.leaseInode implies not(descriptorStillCurrent(namedLease))
pure val exactLockIdentity: NamedLeaseEvidence = { descriptorLive: true, validNamedFile: true, leaseDevice: 1, leaseInode: 1, descriptorDevice: 1, descriptorInode: 1, namedDevice: 1, namedInode: 1 }
pure val namedLeaseValues = Set(exactLockIdentity, { ...exactLockIdentity, namedDevice: 2 }, { ...exactLockIdentity, namedInode: 2 }, { ...exactLockIdentity, descriptorInode: 2 }, { ...exactLockIdentity, descriptorLive: false }, { ...exactLockIdentity, validNamedFile: false })
pure def canCloseWriter(writer: Writer, leaseId: int, lockInode: int): bool =
  writer.phase == "connection" and isCurrentLease(writer, leaseId, lockInode)
pure def closeWriter(writer: Writer, leaseId: int, lockInode: int): Writer = { ...writer, phase: "free", liveLease: 0 }
pure def observeWriterDeath(writer: Writer, leaseId: int, lockInode: int): Writer =
  if (isCurrentLease(writer, leaseId, lockInode)) { ...writer, phase: "free", liveLease: 0 } else writer
pure def observeBrokerDeath(writer: Writer, leaseId: int): Writer = writer
pure def observeExecChild(writer: Writer): Writer = writer
pure def replaceNamedLock(writer: Writer): Writer =
  { ...writer, inode: writer.inode + 1, phase: "free", liveLease: 0, keyWiped: false }
pure def permitsNativeOperation(writer: Writer, leaseId: int, lockInode: int, ownerBeforeOperation: bool): bool =
  writer.phase == "connection" and isCurrentLease(writer, leaseId, lockInode) and ownerBeforeOperation
pure def lawOldDescriptorCannotUseReplacement(writer: Writer, leaseId: int, lockInode: int): bool =
  lockInode != writer.inode implies not(permitsNativeOperation(writer, leaseId, lockInode, true))
pure def lawOldDeathDoesNotReleaseNewWriter(writer: Writer, leaseId: int, lockInode: int): bool =
  not(isCurrentLease(writer, leaseId, lockInode)) implies observeWriterDeath(writer, leaseId, lockInode) == writer
pure def lawContenderCannotTakeHeldWriter(writer: Writer, lockFacts: LockEvidence): bool =
  writer.phase != "free" implies not(canLockWriter(writer, lockFacts))
pure def stepWriterIdentitiesNeverRegress(before: Writer, after: Writer): bool =
  after.inode >= before.inode and after.lastLease >= before.lastLease
pure def sometimesReplacementCanOpen(writer: Writer): bool = writer.phase == "connection" and writer.inode > 1
pure val writerValues = Set(initial, { ...initial, phase: "key-pending", lastLease: 1, liveLease: 1 }, { ...initial, phase: "connection", lastLease: 2, liveLease: 2, keyWiped: true })
```

## Story: Return an encrypted operation's receipt only while ownership still permits it

### A post-operation refusal can coexist with a committed write

The adapter checks that the provider connection is live and `checkOwner` still returns undefined before and after each `exec` and each prepared `get`, `run`, or `all`. Native execution resolves the tagged handle and verifies its lock inode. `assertEncryption` requires the exact connection object and path recorded by this provider, checks owner before and after native verification, and only accepts a literal true native result. A prepared statement carries no independent ownership. Any guard failure prevents returning that operation's result. Outside open, a thrown synchronous owner error propagates unchanged, while a non-undefined return or a closed connection produces TASK_STORAGE_UNAVAILABLE. The native driver has its own TASK_SQLCIPHER_FAILED error. The reviewed provider unit test expects the storage-unavailable code even when its injected owner callback throws a plain error. The pinned provider preserves the callback error, as observed on Linux with an unprivileged caller. At this pin, Grace passes the derived-key resolver and no checkOwner callback. The provider's callback seam is generic and Grace's surrounding task-gateway fences own account authorization. The injected error mismatch therefore tests the generic seam, while lock admission and release both apply on the installed path. A failure after calling a write-capable native command says nothing about committed changes. SQLite may have made an autocommit write before the last owner check, or an earlier statement in a native `exec` can have completed before a later one failed. The output below classifies caller knowledge. It never retries a write or interprets an exception as rollback. Reconciliation must establish actual durable state through a separately authorized read.

Grace `apps/app/host/task-storage-encryption.ts:164–185`. Eliza `task-sqlcipher.mjs:164–175,211–256`; `task-sqlcipher/driver.c:45–55,288–308,398–473`. The pinned `task-sqlcipher/lease.integration.mjs` tests competing admission, release with persistent inode, ownership retirement and key wiping, replaced/invalid locks, one-time path binding, broker death, actual writer death and descriptor inheritance. Its post-write scenario sees an exception then reopens and finds the written row. The pinned `task-sqlcipher.test.mjs` exercises provider/artifact behavior and a controlled native API. Linux tests qualify the reviewed host build. Installed Android musl and SELinux are a separate external boundary.

```quint
type OperationEvidence = { connectionAdmitted: bool, ownerBefore: bool, nativeHandleCurrent: bool, canWrite: bool, nativeSucceeded: bool, ownerAfter: bool }
pure def ownerGuardResult(guardObservation: str): str =
  if (guardObservation == "returned-undefined") "continue"
  else if (guardObservation == "threw") "preserve-callback-error"
  else "TASK_STORAGE_UNAVAILABLE"
pure def lawThrownOwnerErrorSurvivesOperationSentinel(guardObservation: str): bool =
  guardObservation == "threw" implies ownerGuardResult(guardObservation) == "preserve-callback-error"
pure val guardObservationValues = Set("returned-undefined", "threw", "returned-other")
pure def operationReceipt(operation: OperationEvidence): str =
  if (not(operation.connectionAdmitted and operation.ownerBefore and operation.nativeHandleCurrent)) "refused-before-native-sql"
  else if (operation.nativeSucceeded and operation.ownerAfter) "returned"
  else if (operation.canWrite) "write-outcome-unknown"
  else "read-refused"
pure def verifiesBoundConnection(exactProviderConnection: bool, exactDatabasePath: bool, operation: OperationEvidence, nativeTrue: bool): bool =
  exactProviderConnection and exactDatabasePath and operationReceipt(operation) == "returned" and nativeTrue
pure def lawLostOwnerCannotReturnResult(operation: OperationEvidence): bool =
  not(operation.ownerBefore and operation.ownerAfter) implies operationReceipt(operation) != "returned"
pure def lawPostWriteRefusalKeepsOutcomeUnknown(operation: OperationEvidence): bool =
  operation.connectionAdmitted and operation.ownerBefore and operation.nativeHandleCurrent and operation.canWrite and operation.nativeSucceeded and not(operation.ownerAfter) implies operationReceipt(operation) == "write-outcome-unknown"
pure def lawVerificationRequiresOwnConnection(exactProviderConnection: bool, exactDatabasePath: bool, operation: OperationEvidence, nativeTrue: bool): bool =
  not(exactProviderConnection and exactDatabasePath) implies not(verifiesBoundConnection(exactProviderConnection, exactDatabasePath, operation, nativeTrue))
pure val knownOperation: OperationEvidence = { connectionAdmitted: true, ownerBefore: true, nativeHandleCurrent: true, canWrite: true, nativeSucceeded: true, ownerAfter: true }
pure val operationValues = Set(knownOperation, { ...knownOperation, ownerAfter: false }, { ...knownOperation, ownerBefore: false }, { ...knownOperation, nativeHandleCurrent: false }, { ...knownOperation, nativeSucceeded: false }, { ...knownOperation, canWrite: false, ownerAfter: false }, { ...knownOperation, connectionAdmitted: false })
```
