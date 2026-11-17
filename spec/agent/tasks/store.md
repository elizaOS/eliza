# Interactive task store

The custody of the store that keeps the owner's interactive task records on
the device, for the task host (`index.md`). The engine is the `TaskDatabase`
port (default `node:sqlite`, built into Node; no native addon). Every record
payload is sealed with AES-256-GCM under a key that `TaskKeySource` derives
with HKDF-SHA256 from the launch frame's `storageKey` for the launch account,
the host's namespace and one purpose; ids, revisions and timestamps stay in
clear beside the payload. The os keeps `storageKey` in the Keystore and
releases it only for the current account, so an account change is a new
launch. This spec models who may open the store, how a writer is fenced, what
an operation may report and which records are held aside. SQL, file modes,
key bytes and the cipher stay in the shell (`tasks/store.vibe`,
`tasks/sealing.vibe`). There is no migration from plaintext, no evidence log
and no fallback to an unsealed store.

## Story: Refuse task storage when custody cannot be verified

> As the owner, I want my task records stored only when the private path,
> the writer lock, the key and my account are all verified, so that nothing
> of a task is written where another process or account could read it.

### Storage opens only with a private path, the exclusive lock, a 32-byte key and the launch account

Opening checks the canonical private path (directories 0700, file 0600),
takes the exclusive writer lock, then reads the key. The launch frame's
`storageKey` must be exactly 32 bytes; it is wiped as soon as the
per-purpose keys are derived, whether or not the open succeeds, and the
derived keys are wiped when the store closes or its writer is fenced. The
first open binds the store to the launch account; a later open in the same
process must name the same account. A refused open writes nothing and
reports `TASK_STORAGE_UNAVAILABLE`. `GET /api/tasks/storage` reports
`deferred` before the first open, `ok` while this process holds the lock and
`unavailable` otherwise.

```quint
type KeyRead = KeyOk | KeyMissing | KeyWrongLength
type OpenEvidence = { privatePath: bool, exclusiveLock: bool, key: KeyRead }
type Writer = Unopened | OpenRefused | Opened({ generation: int }) | WriterClosed
type Purpose = TaskRecord | TaskEvidence | OutcomeJournal
type Seal = { account: str, purpose: Purpose }
type Hold = Readable | Held | Released
type StoredTask = { taskId: str, seal: Seal, unfinished: bool, hold: Hold }
type TaskStore = { account: str, lockGeneration: int, writer: Writer, records: List[StoredTask] }
type StorageStatus = StorageOk | StorageUnavailable | StorageDeferred
pure val initial: TaskStore = { account: "", lockGeneration: 0, writer: Unopened, records: List() }
pure val verifiedCustody: OpenEvidence = { privatePath: true, exclusiveLock: true, key: KeyOk }
pure val evidenceValues = Set(verifiedCustody, { ...verifiedCustody, privatePath: false }, { ...verifiedCustody, exclusiveLock: false }, { ...verifiedCustody, key: KeyMissing }, { ...verifiedCustody, key: KeyWrongLength })
pure val accountValues = Set("account1", "account2")
pure def holdsLock(s: TaskStore): bool = {
  val w = s.writer
  match w { | Opened(x) => x.generation == s.lockGeneration | _ => false }
}
pure def admitsOpen(evidence: OpenEvidence): bool = evidence.privatePath and evidence.exclusiveLock and evidence.key == KeyOk
pure def admitsAccount(s: TaskStore, account: str): bool = account != "" and (s.account == "" or s.account == account)
pure def canOpenStore(s: TaskStore): bool = not(holdsLock(s))
pure def openStore(s: TaskStore, account: str, evidence: OpenEvidence): TaskStore = if (admitsOpen(evidence) and admitsAccount(s, account)) { ...s, account: account, writer: Opened({ generation: s.lockGeneration }) } else { ...s, writer: OpenRefused }
pure def storageStatus(s: TaskStore): StorageStatus = if (holdsLock(s)) StorageOk else if (s.writer == Unopened) StorageDeferred else StorageUnavailable
pure def lawUnverifiedCustodyNeverOpens(evidence: OpenEvidence, account: str): bool = not(admitsOpen(evidence)) implies storageStatus(openStore(initial, account, evidence)) == StorageUnavailable
pure def alwaysOpenedStoreBelongsToAnAccount(s: TaskStore): bool = {
  val w = s.writer
  match w { | Opened(x) => s.account != "" and x.generation <= s.lockGeneration | _ => true }
}
pure def stepAccountIsFixed(before: TaskStore, after: TaskStore): bool = before.account != "" implies after.account == before.account
pure def sometimesOpened(s: TaskStore): bool = storageStatus(s) == StorageOk
pure def sometimesOpenRefused(s: TaskStore): bool = s.writer == OpenRefused and s.lockGeneration == 0
```

### Replacing the writer lock fences the old writer

The lock is a named file; replacing it gives the lock a new identity. The
writer that held the old one may still have its descriptor, but no record is
written through it, and a new writer may open on the new lock. While a
writer holds the current lock no other can open. Closing frees the lock and
keeps the file.

```quint
pure def replaceLock(s: TaskStore): TaskStore = { ...s, lockGeneration: s.lockGeneration + 1 }
pure def isOpened(w: Writer): bool = match w { | Opened(x) => true | _ => false }
pure def canCloseStore(s: TaskStore): bool = isOpened(s.writer)
pure def closeStore(s: TaskStore): TaskStore = { ...s, writer: WriterClosed }
pure def stepFencedWriterWritesNothing(before: TaskStore, via: str, after: TaskStore): bool = (not(holdsLock(before)) and via != "foundRecord") implies after.records == before.records
pure def sometimesReplacementOpened(s: TaskStore): bool = holdsLock(s) and s.lockGeneration > 0
```

### An operation returns its result only while ownership holds before and after it

Every statement runs only while this process holds the current lock, and
the lock is checked again after the call. A call that failed, or after which
the lock was lost, returns no result: a statement that could write has an
unknown outcome, is never retried and is never reported as not having
happened; a read is refused. Either is a storage failure, so the host
poisons itself (`failStorage` in the task host (`index.md`)) and serves
nothing more until the agent restarts.

```quint
type Receipt = Returned | OutcomeUnknown | ReadRefused
type StoreStep = { state: TaskStore, out: List[Receipt] }
pure def receiptFor(writes: bool, succeeded: bool, ownerAfter: bool): Receipt = if (succeeded and ownerAfter) Returned else if (writes) OutcomeUnknown else ReadRefused
pure def canOperate(s: TaskStore): bool = holdsLock(s)
pure def operate(s: TaskStore, writes: bool, succeeded: bool, ownerAfter: bool): StoreStep = { state: if (ownerAfter) s else { ...s, lockGeneration: s.lockGeneration + 1 }, out: List(receiptFor(writes, succeeded, ownerAfter)) }
pure def lawLostWriteIsUnknown(succeeded: bool): bool = receiptFor(true, succeeded, false) == OutcomeUnknown
pure def stepReturnedOnlyUnderOwnership(before: TaskStore, via: str, after: TaskStore, out: List[Receipt]): bool = out.includes(Returned) implies (holdsLock(before) and holdsLock(after))
pure def sometimesFencedWriterStillOpen(s: TaskStore): bool = isOpened(s.writer) and not(holdsLock(s))
```

### A sealed record reads as a task only under the launch account's task-record key

A payload opens only when it authenticates under the key of its account,
namespace and purpose, so a record copied from another account's store, or
a value sealed for evidence or the outcome journal, never reads as a task.
Such a record, or one with torn bytes, fails explicitly as
`TASK_STORAGE_CORRUPT`: it is never held aside, never released and never
served. The file may hold records from before this open, and anything copied
into it while no writer holds the lock.

```quint
type TaskRead = NoTask | TaskUnreadable | TaskCorrupt | TaskReadable
pure def authentic(r: StoredTask, account: str): bool = r.seal.account == account and r.seal.purpose == TaskRecord
pure val noRecord: StoredTask = { taskId: "", seal: { account: "", purpose: TaskRecord }, unfinished: false, hold: Readable }
pure def recordFor(s: TaskStore, taskId: str): StoredTask = s.records.select(r => r.taskId == taskId).nthOr(0, noRecord)
pure def hasRecord(s: TaskStore, taskId: str): bool = s.records.some(r => r.taskId == taskId)
pure def readTask(s: TaskStore, taskId: str): TaskRead = {
  val r = recordFor(s, taskId)
  if (not(hasRecord(s, taskId))) NoTask else if (not(authentic(r, s.account))) TaskCorrupt else if (r.hold != Readable) TaskUnreadable else TaskReadable
}
pure val taskIdValues = Set("task1", "task2")
pure def canFoundRecord(s: TaskStore, taskId: str, account: str): bool = not(holdsLock(s)) and taskId != "" and account != "" and not(hasRecord(s, taskId))
pure def foundRecord(s: TaskStore, taskId: str, account: str, purpose: Purpose, unfinished: bool): TaskStore = { ...s, records: s.records.append({ taskId: taskId, seal: { account: account, purpose: purpose }, unfinished: unfinished, hold: Readable }) }
pure def alwaysRecordsNameAnAccount(s: TaskStore): bool = s.records.every(r => r.taskId != "" and r.seal.account != "")
pure def alwaysOnlyAuthenticRecordsAreHeld(s: TaskStore): bool = s.records.every(r => r.hold != Readable implies authentic(r, s.account))
pure def sometimesForeignRecordRefused(s: TaskStore): bool = holdsLock(s) and s.records.some(r => readTask(s, r.taskId) == TaskCorrupt)
```

## Story: Keep records a build cannot read

> As the owner, when a new build cannot read one of my task records, I want
> it kept aside instead of deleted, so that a later build can recover it or I
> can let it go.

### A record this build cannot decode is held aside, never deleted or served

On open the store decodes each of the account's records. An authentic record
the build's task validator rejects (`TASK_INVALID`, with its diagnostic as the
reason) is held: a by-id read answers `TASK_UNREADABLE` and the current-task
lookup skips it. A build that decodes a held record returns it to use, unless
the owner has released it; a released record stays aside even when a later
build can read it. No record is ever removed.

```quint
pure def canScan(s: TaskStore, taskId: str): bool = holdsLock(s) and hasRecord(s, taskId) and authentic(recordFor(s, taskId), s.account)
pure def rehold(r: StoredTask, decodes: bool): Hold = if (r.hold == Released) Released else if (decodes) Readable else Held
pure def scan(s: TaskStore, taskId: str, decodes: bool): TaskStore = { ...s, records: s.records.listMap(r => if (r.taskId == taskId) { ...r, hold: rehold(r, decodes) } else r) }
pure def stepRecordsAreNeverDropped(before: TaskStore, after: TaskStore): bool = before.records.every(r => after.records.some(q => q.taskId == r.taskId))
pure def stepReleasedStaysAside(before: TaskStore, after: TaskStore): bool = before.records.every(r => r.hold == Released implies after.records.some(q => q.taskId == r.taskId and q.hold == Released))
pure def sometimesHeldRecordStaysUnfinished(s: TaskStore): bool = s.records.some(r => r.hold == Held and r.unfinished)
```

### An unreadable unfinished record keeps the task slot until the owner releases it

The account holds one task slot. A new task is refused `TASK_UNREADABLE`
while an unfinished record is held, `TASK_STORAGE_CORRUPT` while an
unfinished record does not authenticate, and `TASK_CONFLICT` while its id
exists or another unfinished record is readable; a released record still
keeps its id. Releasing is the owner's own authority, separate from
recovery: only the launch account, through `acknowledge-unreadable`, releases
a held record, which frees the slot and keeps the record and its reason.

```quint
type SlotAdmission = SlotFree | SlotTaken | SlotUnreadable | SlotCorrupt
pure def slotAdmission(s: TaskStore, taskId: str): SlotAdmission = if (s.records.some(r => r.unfinished and r.hold == Held)) SlotUnreadable else if (s.records.some(r => r.unfinished and not(authentic(r, s.account)))) SlotCorrupt else if (hasRecord(s, taskId) or s.records.some(r => r.unfinished)) SlotTaken else SlotFree
pure def canCreateRecord(s: TaskStore, taskId: str): bool = holdsLock(s) and taskId != "" and slotAdmission(s, taskId) == SlotFree
pure def createRecord(s: TaskStore, taskId: str): TaskStore = { ...s, records: s.records.append({ taskId: taskId, seal: { account: s.account, purpose: TaskRecord }, unfinished: true, hold: Readable }) }
pure def canEndRecord(s: TaskStore, taskId: str): bool = holdsLock(s) and readTask(s, taskId) == TaskReadable and recordFor(s, taskId).unfinished
pure def endRecord(s: TaskStore, taskId: str): TaskStore = { ...s, records: s.records.listMap(r => if (r.taskId == taskId) { ...r, unfinished: false } else r) }
pure val byValues = Set("account1", "account2")
pure def canAcknowledgeUnreadable(s: TaskStore, by: str, taskId: str): bool = holdsLock(s) and by == s.account and readTask(s, taskId) == TaskUnreadable and recordFor(s, taskId).hold == Held
pure val weight_createRecord = 4
pure val weight_scan = 4
pure val weight_acknowledgeUnreadable = 4
pure def acknowledgeUnreadable(s: TaskStore, by: str, taskId: str): TaskStore = { ...s, records: s.records.listMap(r => if (r.taskId == taskId) { ...r, hold: Released, unfinished: false } else r) }
pure def alwaysReleasedRecordIsFinished(s: TaskStore): bool = s.records.every(r => r.hold == Released implies not(r.unfinished))
pure def stepOnlyTheOwnerFinishesAHeldRecord(before: TaskStore, via: str, after: TaskStore): bool = before.records.every(r => (r.hold == Held and r.unfinished) implies (via == "acknowledgeUnreadable" or after.records.some(q => q.taskId == r.taskId and q.unfinished)))
pure def sometimesSlotRefusedAsUnreadable(s: TaskStore): bool = holdsLock(s) and slotAdmission(s, "task2") == SlotUnreadable
pure def sometimesReleasedThenNewTask(s: TaskStore): bool = s.records.some(r => r.hold == Released) and s.records.some(r => r.hold == Readable and r.unfinished)
```
