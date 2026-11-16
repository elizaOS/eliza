# Provider account storage

The agent keeps the credentials of linked model-provider accounts on the
machine, encrypted, one record per account, under the storage policy of the
branded deployment. Every storage call runs under the
[storage lock](./accountStorageLock.md), and a whole-storage
[reset](./accountStorageReset.md) fences writers of an older storage epoch.
This machine follows the records themselves: each replacement gets a fresh
generation that later writers compare against, an old record is migrated
the first time it is read, and a provider's accounts are deleted together
or not at all. Provider names are placeholders (`p1`, `p2`).

[Provider access tokens](./accessTokens.md) commit refreshed tokens through
the generation rule here.

## Story: Store, migrate and delete provider account credentials on this machine

> As a person who linked model-provider accounts, I want a refresh, a
> profile edit or a relink never to undo a newer change, old records to keep
> working after an upgrade, and deleting a provider's accounts never to
> leave half of them behind.

### The branded storage policy owns the encryption key, never a runner signal

A deployment that keeps credentials in its runtime vault uses that vault or
writes nothing; an isolated runner gets a key of its own process, which a
restarted process cannot reopen.

```quint
type StoragePolicy = RuntimeVault | IsolatedRunner
type KeyKind = VaultKey | NoKey | ProcessKey
type CredentialKey = { kind: KeyKind, process: int }
pure def credentialKeyFor(policy: StoragePolicy, vaultAvailable: bool, process: int, runnerSignal: bool): CredentialKey =
  if (policy == RuntimeVault) { kind: if (vaultAvailable) VaultKey else NoKey, process: 0 } else { kind: ProcessKey, process: process }
pure def lawRunnerSignalsDoNotSelectTheKey(policy: StoragePolicy, vaultAvailable: bool, process: int): bool =
  credentialKeyFor(policy, vaultAvailable, process, true) == credentialKeyFor(policy, vaultAvailable, process, false)
pure def lawNoFallbackWithoutTheVault(process: int, runnerSignal: bool): bool = credentialKeyFor(RuntimeVault, false, process, runnerSignal).kind == NoKey
pure def lawIsolatedKeyDoesNotReopenAfterRestart(process: int): bool = credentialKeyFor(IsolatedRunner, false, process, false) != credentialKeyFor(IsolatedRunner, false, process + 1, false)
pure val processValues = Set(0, 1)
```

### Every replacement gets a fresh generation, and a commit from a stale generation is refused

A refresh or a profile edit captured a generation when it read the record.
It commits only while the record still has that generation, so a deleted
account is never recreated and an identical replacement still fences an old
refresh. A refresh keeps the current label, and keeps the ID token when the
provider sent none.

```quint
type RecordFormat = CurrentFormat | LegacyFormat | CorruptRecord
type CredentialRecord = { key: int, provider: str, generation: int, credential: int, idToken: int, label: int, format: RecordFormat, rewrites: int }
type ReaderStage = ReaderIdle | ReaderWaiting | ReaderDone
type Reader = { id: int, key: int, generation: int, stage: ReaderStage }
type StorageResult = NoStorageCall | Loaded | Updated | GenerationChanged | RecordMissing | Saved | Removed | InvalidRecord | Returned | ErrorBeforeRename | ErrorAfterRename | PlanPrepared | InventoryChanged | TargetChanged | ProviderDeleted | DeletionRolledBack
type DeletionPhase = NoDeletion | DeletionPrepared | Unlinking | RollingBack | DeletionFinished
type PlannedRecord = { key: int, generation: int }
type AccountStorage = {
  records: List[CredentialRecord], readers: List[Reader], nextGeneration: int, result: StorageResult,
  deletionProvider: str, plan: List[PlannedRecord], unlinked: List[CredentialRecord], deletionPhase: DeletionPhase, deletedCount: int
}
pure val initial: AccountStorage = {
  records: List(
    { key: 1, provider: "p1", generation: 1, credential: 1, idToken: 1, label: 1, format: CurrentFormat, rewrites: 0 },
    { key: 2, provider: "p1", generation: 2, credential: 2, idToken: 2, label: 2, format: LegacyFormat, rewrites: 0 },
    { key: 3, provider: "p2", generation: 0, credential: 3, idToken: 0, label: 3, format: CorruptRecord, rewrites: 0 }),
  readers: List({ id: 1, key: 0, generation: 0, stage: ReaderIdle }, { id: 2, key: 0, generation: 0, stage: ReaderIdle }),
  nextGeneration: 3, result: NoStorageCall, deletionProvider: "", plan: List(), unlinked: List(), deletionPhase: NoDeletion, deletedCount: 0
}
pure val noRecord: CredentialRecord = { key: 0, provider: "", generation: 0, credential: 0, idToken: 0, label: 0, format: CorruptRecord, rewrites: 0 }
pure val noReader: Reader = { id: 0, key: 0, generation: 0, stage: ReaderDone }
pure def recordOf(s: AccountStorage, key: int): CredentialRecord = s.records.select(r => r.key == key).nthOr(0, noRecord)
pure def present(s: AccountStorage, key: int): bool = s.records.some(r => r.key == key)
pure def readerOf(s: AccountStorage, id: int): Reader = s.readers.select(r => r.id == id).nthOr(0, noReader)
pure def withReader(id: int, change: Reader, s: AccountStorage): List[Reader] = s.readers.listMap(r => if (r.id == id) change else r)
pure def withRecord(key: int, change: CredentialRecord, s: AccountStorage): List[CredentialRecord] = s.records.listMap(r => if (r.key == key) change else r)
pure def canBeginRead(s: AccountStorage, reader: int, key: int): bool =
  readerOf(s, reader).stage != ReaderWaiting and readerOf(s, reader).id > 0 and recordOf(s, key).format == CurrentFormat and recordOf(s, key).generation > 0
pure def beginRead(s: AccountStorage, reader: int, key: int): AccountStorage =
  { ...s, readers: withReader(reader, { id: reader, key: key, generation: recordOf(s, key).generation, stage: ReaderWaiting }, s), result: Loaded }
pure def lockFree(s: AccountStorage): bool = s.deletionPhase != Unlinking and s.deletionPhase != RollingBack
pure def canRefreshCommit(s: AccountStorage, reader: int, credential: int, includesIdToken: bool): bool = readerOf(s, reader).stage == ReaderWaiting and lockFree(s)
pure def refreshCommit(s: AccountStorage, reader: int, credential: int, includesIdToken: bool): AccountStorage = {
  val held = readerOf(s, reader)
  val record = recordOf(s, held.key)
  val done = withReader(reader, { ...held, stage: ReaderDone }, s)
  if (not(present(s, held.key))) { ...s, readers: done, result: RecordMissing }
  else if (record.generation != held.generation) { ...s, readers: done, result: GenerationChanged }
  else { ...s, readers: done, nextGeneration: s.nextGeneration + 1, result: Updated,
    records: withRecord(held.key, { ...record, generation: s.nextGeneration, credential: credential, idToken: if (includesIdToken) credential else record.idToken }, s) }
}
pure def canSave(s: AccountStorage, key: int, provider: str, credential: int, includesIdToken: bool): bool = lockFree(s) and key > 0 and provider != "" and (not(present(s, key)) or recordOf(s, key).provider == provider)
pure def save(s: AccountStorage, key: int, provider: str, credential: int, includesIdToken: bool): AccountStorage = {
  val fresh = { key: key, provider: provider, generation: s.nextGeneration, credential: credential, idToken: if (includesIdToken) credential else 0, label: key, format: CurrentFormat, rewrites: recordOf(s, key).rewrites }
  { ...s, nextGeneration: s.nextGeneration + 1, result: Saved, records: if (present(s, key)) withRecord(key, fresh, s) else s.records.append(fresh) }
}
pure def canRemove(s: AccountStorage, key: int): bool = present(s, key) and lockFree(s)
pure def remove(s: AccountStorage, key: int): AccountStorage = { ...s, records: s.records.select(r => r.key != key), result: Removed }
pure val readerValues = Set(1, 2)
pure val keyValues = Set(1, 2, 3, 4)
pure val providerValues = Set("p1", "p2")
pure val credentialValues = Set(1, 5)
pure def alwaysGenerationsAreFresh(s: AccountStorage): bool =
  s.records.every(r => r.generation < s.nextGeneration and r.generation >= 0 and (r.generation > 0 implies s.records.select(o => o.generation == r.generation).length() == 1) and s.records.select(o => o.key == r.key).length() == 1)
    and s.readers.every(r => r.generation < s.nextGeneration)
pure def stepStaleCommitChangesNothing(before: AccountStorage, via: str, after: AccountStorage): bool =
  (via == "refreshCommit" and (after.result == GenerationChanged or after.result == RecordMissing)) implies after.records == before.records
pure def stepRefreshKeepsLabelAndProvider(before: AccountStorage, via: str, after: AccountStorage): bool =
  via == "refreshCommit" implies after.records.every(r => before.records.some(b => b.key == r.key and b.label == r.label and b.provider == r.provider))
pure def sometimesStaleRefreshFenced(s: AccountStorage): bool = s.result == GenerationChanged
pure def sometimesDeletedAccountNotRecreated(s: AccountStorage): bool = s.result == RecordMissing
```

### A profile edit changes only metadata, and a conditional edit honors its captured generation

```quint
pure def canEditLabel(s: AccountStorage, key: int, label: int): bool = lockFree(s) and present(s, key) and recordOf(s, key).format == CurrentFormat
pure def editLabel(s: AccountStorage, key: int, label: int): AccountStorage = { ...s, records: withRecord(key, { ...recordOf(s, key), label: label }, s), result: Updated }
pure def canEditLabelIfCurrent(s: AccountStorage, reader: int, label: int): bool = lockFree(s) and readerOf(s, reader).stage == ReaderWaiting
pure def editLabelIfCurrent(s: AccountStorage, reader: int, label: int): AccountStorage = {
  val held = readerOf(s, reader)
  val done = withReader(reader, { ...held, stage: ReaderDone }, s)
  if (not(present(s, held.key))) { ...s, readers: done, result: RecordMissing }
  else if (recordOf(s, held.key).generation != held.generation) { ...s, readers: done, result: GenerationChanged }
  else { ...s, readers: done, records: withRecord(held.key, { ...recordOf(s, held.key), label: label }, s), result: Updated }
}
pure val labelValues = Set(7, 8)
pure def stepEditKeepsCredentials(before: AccountStorage, via: str, after: AccountStorage): bool =
  (via == "editLabel" or via == "editLabelIfCurrent") implies (after.records.length() == before.records.length() and
    after.records.every(r => before.records.some(b => b.key == r.key and b.generation == r.generation and b.credential == r.credential and b.idToken == r.idToken)))
pure def sometimesConditionalEditApplied(s: AccountStorage): bool = s.result == Updated and s.records.some(r => r.label == 7 or r.label == 8)
```

### A record is migrated the first time it is read, keeping its contents and generation; an invalid record is never rewritten

A legacy record is rewritten once in the current format; one without a
generation gets a fresh one. A failure before the atomic rename leaves the
old record for a retry; a failure after it leaves the rewrite visible but
returns nothing.

```quint
type MigrationFault = NoFault | FaultBeforeRename | FaultAfterRename
pure def canMigrate(s: AccountStorage, key: int, fault: MigrationFault): bool = lockFree(s) and present(s, key)
pure def migrate(s: AccountStorage, key: int, fault: MigrationFault): AccountStorage = {
  val record = recordOf(s, key)
  val rewritten = { ...record, format: CurrentFormat, generation: if (record.generation == 0) s.nextGeneration else record.generation, rewrites: record.rewrites + 1 }
  val following = if (record.generation == 0) s.nextGeneration + 1 else s.nextGeneration
  if (record.format == CorruptRecord) { ...s, result: InvalidRecord }
  else if (record.format == CurrentFormat) { ...s, result: Returned }
  else if (fault == FaultBeforeRename) { ...s, result: ErrorBeforeRename }
  else { ...s, records: withRecord(key, rewritten, s), nextGeneration: following, result: if (fault == FaultAfterRename) ErrorAfterRename else Returned }
}
pure def alwaysRewrittenOnce(s: AccountStorage): bool = s.records.every(r => r.rewrites <= 1 and (r.rewrites == 1 implies r.format == CurrentFormat))
pure def stepMigrationKeepsContents(before: AccountStorage, via: str, after: AccountStorage): bool =
  via == "migrate" implies (after.records.length() == before.records.length() and after.records.every(r => before.records.some(b => b.key == r.key and b.credential == r.credential and b.label == r.label and (b.generation > 0 implies b.generation == r.generation) and (b.format == CorruptRecord implies b == r))))
pure def sometimesLegacyMigrated(s: AccountStorage): bool = s.records.some(r => r.key == 2 and r.rewrites == 1 and r.format == CurrentFormat)
pure def sometimesInvalidRecordRefused(s: AccountStorage): bool = s.result == InvalidRecord
```

### Provider deletion validates the whole plan before the first unlink and compensates a failed second unlink

The plan is taken under one lock and committed under another, so a writer
may run between them; the commit then holds the lock until its result, so
nothing else runs while it unlinks or restores. The commit refuses a changed inventory or a changed
record before it removes anything; if a later unlink fails, the records
already removed are restored before the call fails. Accounts of other
providers are never touched.

```quint
pure def providerRecords(s: AccountStorage, provider: str): List[PlannedRecord] = s.records.select(r => r.provider == provider).listMap(r => { key: r.key, generation: r.generation })
pure def canPrepareDeletion(s: AccountStorage, provider: str): bool = provider != "" and (s.deletionPhase == NoDeletion or s.deletionPhase == DeletionFinished)
pure def prepareDeletion(s: AccountStorage, provider: str): AccountStorage =
  { ...s, deletionProvider: provider, plan: providerRecords(s, provider), unlinked: List(), deletionPhase: DeletionPrepared, deletedCount: 0, result: PlanPrepared }
pure def canValidateDeletion(s: AccountStorage): bool = s.deletionPhase == DeletionPrepared
pure def validateDeletion(s: AccountStorage): AccountStorage = {
  val inventory = providerRecords(s, s.deletionProvider)
  if (inventory.listMap(p => p.key) != s.plan.listMap(p => p.key)) { ...s, deletionPhase: DeletionFinished, result: InventoryChanged }
  else if (inventory != s.plan) { ...s, deletionPhase: DeletionFinished, result: TargetChanged }
  else { ...s, deletionPhase: Unlinking }
}
pure def canUnlinkPlanned(s: AccountStorage, key: int): bool = s.deletionPhase == Unlinking and s.plan.some(p => p.key == key) and present(s, key)
pure def unlinkPlanned(s: AccountStorage, key: int): AccountStorage = { ...s, records: s.records.select(r => r.key != key), unlinked: s.unlinked.append(recordOf(s, key)) }
pure def canUnlinkFails(s: AccountStorage): bool = s.deletionPhase == Unlinking and s.unlinked.length() >= 1 and s.unlinked.length() < s.plan.length()
pure def unlinkFails(s: AccountStorage): AccountStorage = { ...s, deletionPhase: RollingBack }
pure def canRestoreUnlinked(s: AccountStorage): bool = s.deletionPhase == RollingBack
pure def restoreUnlinked(s: AccountStorage): AccountStorage = { ...s, records: s.records.concat(s.unlinked), unlinked: List(), deletionPhase: DeletionFinished, result: DeletionRolledBack }
pure def canConfirmDeletion(s: AccountStorage): bool = s.deletionPhase == Unlinking and s.unlinked.length() == s.plan.length()
pure def confirmDeletion(s: AccountStorage): AccountStorage = { ...s, deletionPhase: DeletionFinished, deletedCount: s.unlinked.length(), unlinked: List(), result: ProviderDeleted }
pure def alwaysUnlinksStayInsidePlan(s: AccountStorage): bool =
  s.unlinked.every(u => s.plan.some(p => p.key == u.key and p.generation == u.generation) and not(present(s, u.key)) and u.provider == s.deletionProvider)
    and ((s.deletionPhase == Unlinking or s.deletionPhase == RollingBack) implies s.plan.every(p => present(s, p.key) or s.unlinked.some(u => u.key == p.key)))
pure def stepOtherProvidersUntouched(before: AccountStorage, via: str, after: AccountStorage): bool =
  (via == "unlinkPlanned" or via == "restoreUnlinked" or via == "confirmDeletion" or via == "validateDeletion") implies
    before.records.every(b => b.provider == before.deletionProvider or after.records.includes(b))
pure def alwaysDeletionResultMatchesPlan(s: AccountStorage): bool =
  (s.result == ProviderDeleted implies (s.deletedCount == s.plan.length() and not(s.records.some(r => r.provider == s.deletionProvider and s.plan.some(p => p.key == r.key)))))
    and (s.deletionPhase == DeletionPrepared implies s.unlinked.length() == 0)
pure def stepRefusedPlanRemovesNothing(before: AccountStorage, via: str, after: AccountStorage): bool = via == "validateDeletion" implies after.records == before.records
pure def alwaysRollbackRestoresThePlan(s: AccountStorage): bool =
  s.result == DeletionRolledBack implies s.plan.every(p => s.records.some(r => r.key == p.key and r.generation == p.generation))
pure def sometimesProviderDeleted(s: AccountStorage): bool = s.result == ProviderDeleted and s.deletedCount == 2
pure def sometimesRolledBack(s: AccountStorage): bool = s.result == DeletionRolledBack
pure def sometimesChangedTargetRefused(s: AccountStorage): bool = s.result == TargetChanged or s.result == InventoryChanged
```
