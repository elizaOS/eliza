# Sealed diagnostics journal storage

A device host keeps its diagnostics journal in the account slot's
encrypted files. This spec owns atomic sealed replacement of the journal
file and the durable handoff of its records.
[Task storage custody](../tasks/storageCustody.md) owns key derivation and
account binding; what a diagnostic event contains, how it is redacted and
exported, and when it is captured and flushed belong to the consumer that
records diagnostics. An opaque journal value stands for the full text the
journal persists.

## Story: Publish an entire sealed journal under the current storage generation

> As a device owner, the diagnostics journal on disk is always a complete,
> sealed copy, never a half-written one.

### Only a sealed and synchronized stage can replace the old file

A read distinguishes a missing file, an unreadable or unauthenticated one
and a malformed journal; only an authenticated, decodable file is read. A
write seals the whole text, writes it to an exclusive owner-only temporary
file in the same directory, syncs and closes it, passes any supplied
verifier, and is renamed over the journal only while the storage
generation it captured is still current; a superseded write removes its
stage and publishes nothing. After the rename the directory is synced. A
directory sync that the platform does not support (`EINVAL`, `ENOTSUP`,
`EOPNOTSUPP`, `EISDIR`, or any error on Windows) is tolerated; any other
failure is reported even though the complete new file may already be
visible. Startup removes stale journal temporary files and leaves the
journal itself alone.

```quint
type FileRead = { present: bool, readSucceeded: bool, authenticated: bool, decodedJournal: bool }
pure def readJournalFile(readFacts: FileRead): str =
  if (not(readFacts.present)) "missing"
  else if (not(readFacts.readSucceeded and readFacts.authenticated)) "unread"
  else if (not(readFacts.decodedJournal)) "malformed"
  else "read"
type FilePublish = { sealed: bool, exclusiveTemp: bool, fileWrittenSynced: bool, fileClosed: bool, verificationPassed: bool, generationCurrent: bool, renamed: bool, directorySync: str, windows: bool, directoryClosed: bool }
pure def renameAllowed(writeFacts: FilePublish): bool =
  writeFacts.sealed and writeFacts.exclusiveTemp and writeFacts.fileWrittenSynced and writeFacts.fileClosed and writeFacts.verificationPassed and writeFacts.generationCurrent
pure def directorySyncAccepted(directorySync: str, windows: bool): bool =
  windows or directorySync == "ok" or directorySync == "EINVAL" or directorySync == "ENOTSUP" or directorySync == "EOPNOTSUPP" or directorySync == "EISDIR"
pure def fileResult(writeFacts: FilePublish): str =
  if (not(renameAllowed(writeFacts) and writeFacts.renamed)) "no-replacement"
  else if (writeFacts.directoryClosed and directorySyncAccepted(writeFacts.directorySync, writeFacts.windows)) "returned"
  else "visible-sync-failed"
pure def staleJournalTemp(mainPrefix: bool, tmpSuffix: bool): bool = mainPrefix and tmpSuffix
pure def lawFailedVerificationCannotReplace(writeFacts: FilePublish): bool =
  not(writeFacts.verificationPassed) implies fileResult(writeFacts) == "no-replacement"
pure def lawDirectoryFailureAfterRenameDoesNotEraseVisibility(writeFacts: FilePublish): bool =
  renameAllowed(writeFacts) and writeFacts.renamed and not(directorySyncAccepted(writeFacts.directorySync, writeFacts.windows)) implies fileResult(writeFacts) == "visible-sync-failed"
pure def lawUnauthenticatedReadDoesNotBecomeMalformedContent(readFacts: FileRead): bool =
  readFacts.present and not(readFacts.authenticated) implies readJournalFile(readFacts) == "unread"
pure val healthyRead: FileRead = { present: true, readSucceeded: true, authenticated: true, decodedJournal: true }
pure val readFactsValues = Set(healthyRead, { ...healthyRead, present: false }, { ...healthyRead, readSucceeded: false }, { ...healthyRead, authenticated: false }, { ...healthyRead, decodedJournal: false })
pure val readyPublish: FilePublish = { sealed: true, exclusiveTemp: true, fileWrittenSynced: true, fileClosed: true, verificationPassed: true, generationCurrent: true, renamed: true, directorySync: "ok", windows: false, directoryClosed: true }
pure val writeFactsValues = Set(readyPublish, { ...readyPublish, fileWrittenSynced: false }, { ...readyPublish, fileClosed: false }, { ...readyPublish, verificationPassed: false }, { ...readyPublish, generationCurrent: false }, { ...readyPublish, renamed: false }, { ...readyPublish, directorySync: "EIO" }, { ...readyPublish, directorySync: "EIO", windows: true }, { ...readyPublish, directorySync: "ENOTSUP" }, { ...readyPublish, directoryClosed: false })
```

## Story: Preserve each acknowledged record through a replacement handoff

> As a device owner, each diagnostic record that was acknowledged survives
> a restart once, neither lost nor duplicated.

### Assign a stable identity and reconcile only authenticated exact copies

Each record gets a stable identity, a journal launch and a sequence
number, before its first write, and keeps it and its whole payload through
retries and copies. Recovery reads both authenticated copies and yields a
record at most once per identity: identical copies are one record, and
copies of one identity with different payloads are a conflict that keeps
both. An unreadable copy refuses recovery and keeps its bytes; it is never
treated as missing or empty. Legacy rows without an identity are imported
as they are and deduplicated only by a trusted identity, never by a
timestamp, task or payload hash.

```quint
type RecoveryRead = { mainReadable: bool, fragmentReadable: bool, mainPayload: int, fragmentPayload: int }
type RecoveryRecord = { disposition: str, payload: int }
pure def hasRecoveryConflict(observed: RecoveryRead): bool =
  observed.mainPayload > 0 and observed.fragmentPayload > 0 and observed.mainPayload != observed.fragmentPayload
pure def recoveryRecord(observed: RecoveryRead): RecoveryRecord =
  if (not(observed.mainReadable and observed.fragmentReadable)) { disposition: "unreadable", payload: 0 }
  else if (hasRecoveryConflict(observed)) { disposition: "conflict", payload: 0 }
  else if (observed.mainPayload > 0) { disposition: "record", payload: observed.mainPayload }
  else if (observed.fragmentPayload > 0) { disposition: "record", payload: observed.fragmentPayload }
  else { disposition: "missing", payload: 0 }
pure def lawExactCopiesReturnOneRecord(observed: RecoveryRead): bool =
  observed.mainReadable and observed.fragmentReadable and observed.mainPayload > 0 and observed.mainPayload == observed.fragmentPayload implies
  recoveryRecord(observed) == { disposition: "record", payload: observed.mainPayload }
pure def lawUnreadableCopyCannotBeTreatedAsMissing(observed: RecoveryRead): bool =
  not(observed.mainReadable and observed.fragmentReadable) implies recoveryRecord(observed).disposition == "unreadable"
pure def lawConflictingCopiesCannotProduceARecord(observed: RecoveryRead): bool =
  observed.mainReadable and observed.fragmentReadable and hasRecoveryConflict(observed) implies recoveryRecord(observed).disposition == "conflict"
pure val observedValues = Set(
  { mainReadable: true, fragmentReadable: true, mainPayload: 0, fragmentPayload: 0 },
  { mainReadable: true, fragmentReadable: true, mainPayload: 0, fragmentPayload: 1 },
  { mainReadable: true, fragmentReadable: true, mainPayload: 1, fragmentPayload: 0 },
  { mainReadable: true, fragmentReadable: true, mainPayload: 1, fragmentPayload: 1 },
  { mainReadable: true, fragmentReadable: true, mainPayload: 1, fragmentPayload: 2 },
  { mainReadable: true, fragmentReadable: false, mainPayload: 1, fragmentPayload: 0 })
```

### A handoff deletes a fragment only after the same record is durable in main

A record is first written as its own fragment, only under a name known
to be absent and never over an unread fragment; an existing copy accepts
only a retry of the same identity and payload. A write is acknowledged
only after sealing, file sync, publication and directory sync; without
directory durability it is unconfirmed and its fragment is kept. The
record is then written into the main file, and only once that copy is
durable is the exact fragment removed. A failed removal leaves a harmless
exact duplicate, and a conflicting or unread recovery retires neither
copy. These guarantees hold as far as the host's reported syncs do; a
lost key, or a crash before a receipt, can still lose a record.

```quint
type DurableJournalCopies = { mainPayload: int, fragmentPayload: int }
pure def holdsAcknowledged(copies: DurableJournalCopies, acknowledged: int): bool =
  acknowledged > 0 and (copies.mainPayload == acknowledged or copies.fragmentPayload == acknowledged)
pure def keepDurableFragment(copies: DurableJournalCopies, payload: int, readCurrent: bool, directoryDurable: bool): DurableJournalCopies =
  if (payload > 0 and readCurrent and directoryDurable and copies.fragmentPayload == 0 and
      (copies.mainPayload == 0 or copies.mainPayload == payload))
    { ...copies, fragmentPayload: payload }
  else copies
pure def consolidateDurableFragment(copies: DurableJournalCopies, payload: int, bothReadable: bool, directoryDurable: bool): DurableJournalCopies =
  if (payload > 0 and bothReadable and directoryDurable and copies.fragmentPayload == payload and
      (copies.mainPayload == 0 or copies.mainPayload == payload))
    { ...copies, mainPayload: payload }
  else copies
pure def retireDurableFragment(copies: DurableJournalCopies, payload: int, bothReadable: bool, removalDurable: bool): DurableJournalCopies =
  if (payload > 0 and bothReadable and removalDurable and copies.fragmentPayload == payload and copies.mainPayload == payload)
    { ...copies, fragmentPayload: 0 }
  else copies
pure def lawWriteKeepsPreviouslyAcknowledged(copies: DurableJournalCopies, acknowledged: int, payload: int, readCurrent: bool, directoryDurable: bool): bool =
  holdsAcknowledged(copies, acknowledged) implies holdsAcknowledged(keepDurableFragment(copies, payload, readCurrent, directoryDurable), acknowledged)
pure def lawConsolidationKeepsPreviouslyAcknowledged(copies: DurableJournalCopies, acknowledged: int, payload: int, bothReadable: bool, directoryDurable: bool): bool =
  holdsAcknowledged(copies, acknowledged) implies holdsAcknowledged(consolidateDurableFragment(copies, payload, bothReadable, directoryDurable), acknowledged)
pure def lawRetirementKeepsPreviouslyAcknowledged(copies: DurableJournalCopies, acknowledged: int, payload: int, bothReadable: bool, removalDurable: bool): bool =
  holdsAcknowledged(copies, acknowledged) implies holdsAcknowledged(retireDurableFragment(copies, payload, bothReadable, removalDurable), acknowledged)
pure def lawUnreadFragmentCannotBeOverwritten(copies: DurableJournalCopies, payload: int, directoryDurable: bool): bool =
  keepDurableFragment(copies, payload, false, directoryDurable) == copies
pure def lawFailedSyncCannotRetire(copies: DurableJournalCopies, payload: int, bothReadable: bool, removalDurable: bool): bool =
  copies.mainPayload == 0 implies retireDurableFragment(
    consolidateDurableFragment(copies, payload, bothReadable, false), payload, bothReadable, removalDurable) == copies
pure def lawRestartAfterFailedRemovalHasOneExactRecord(copies: DurableJournalCopies, payload: int): bool = {
  val afterMain = consolidateDurableFragment(copies, payload, true, true)
  val afterFailedRemoval = retireDurableFragment(afterMain, payload, true, false)
  payload > 0 and copies.fragmentPayload == payload and copies.mainPayload == 0 implies
    recoveryRecord({ mainReadable: true, fragmentReadable: true, mainPayload: afterFailedRemoval.mainPayload, fragmentPayload: afterFailedRemoval.fragmentPayload }) ==
      { disposition: "record", payload: payload }
}
pure val copiesValues = Set(
  { mainPayload: 0, fragmentPayload: 0 },
  { mainPayload: 0, fragmentPayload: 1 },
  { mainPayload: 1, fragmentPayload: 0 },
  { mainPayload: 1, fragmentPayload: 1 },
  { mainPayload: 1, fragmentPayload: 2 })
pure val acknowledgedValues = Set(0, 1, 2)
pure val payloadValues = Set(0, 1, 2)
```
