# Grace sealed diagnostics journal storage

Grace at `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` attaches the installed task journal to its account slot's encrypted file ports. The shared file operations come from Eliza at `7743504b7c936a764b3938a44cad918808b621df`. This model owns atomic file replacement, delayed publication and restart handoff. Task storage custody owns key derivation and account binding. The journal's diagnostic event, redaction and export schemas are inputs here. An opaque journal value represents the full text selected by that journal for persistence.

The original Eliza `packages/host/native-host/task-storage-sealing.test.mjs` uses actual sealed files, fsync failures and verification refusal. Grace `apps/app/test/task-storage-encryption.test.mjs` uses the real sealed sync and background file ports and tests retirement of temporary files. Grace `apps/app/test/diagnostics-journal.test.mjs` controls reads, writes, timers and restart boundaries. Its `diagnostics-journal-faults.test.mjs` enumerates 1,024 combinations and records two known handoff defects. Those are observable compatibility evidence for the pinned behavior. A replacement must preserve readable authenticated data and address the defects to guarantee loss-free, duplicate-free recovery.

## Story: Publish an entire sealed journal under the current storage generation

### Only a sealed and synchronized stage can replace the old file

The installed gateway selects `diagnostics/accounts/<slot>/task-journal.json`. Its synchronous read, write and remove ports bind purpose `diagnostics-journal` to the Grace file sealer. Reading trims trailing whitespace and authenticates that line. Missing files retain ENOENT. Other read failures, including an invalid envelope or wrong key, propagate to the journal as unreadable. Writes seal the whole text before file I/O and append one newline. The shared synchronous writer creates the missing directory at mode 0700, exclusively creates an owner-only 0600 temporary file in the same directory, writes and fsyncs that file and closes it before replacement. An optional supplied verifier sees the actual staged UTF-8 bytes after file sync and before rename. Grace's sealed port does not supply a verifier. The asynchronous Grace path follows the same staging rules and checks the captured generation immediately before synchronous rename on the same event-loop turn. If superseded, it removes the staged file and reports no publication. A successful rename then requires a directory sync attempt. EINVAL, ENOTSUP, EOPNOTSUPP and EISDIR, or a directory-sync error on Windows, are tolerated in the respective shared or Grace sync adapter. A close error can still propagate. Another error such as EIO after rename reports failure even though the new complete file can now be visible. That error does not show that the old file remains or that the replacement survives a crash.

Startup with an available account slot removes diagnostics entries whose names start with `task-journal.json.` and end with `.tmp`. It leaves the main and `.unsaved` names alone during that sweep. Sweep failure propagates. The storage custody contract separately covers a key loss that removes the entire slot's unreadable data.

Grace `apps/app/host/local-agent-gateway.ts:440`, `apps/app/host/task-storage-encryption.ts:59–85,163–169,189–197`. Eliza `packages/host/native-host/task-storage-sealing.mjs:163–227,253–268`.

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

### A synchronous flush supersedes an older background snapshot even if the flush itself fails

The normal timer waits 1,000 ms and starts at most one background write. With an unread main file or no asynchronous port, the timer uses synchronous flush. An allowed background write captures the full current journal and the synchronous flush generation. A record that arrives while it waits stays in memory for a later timer. Recording alone does not invalidate the in-flight value. Every synchronous flush with a file increments the generation before its read and write work. That includes an explicit final flush, a recovery entry's immediate flush when the main file is readable, and an attempted flush that fails. Recovery entries are device events, browser operations and task pause, cancel, revoke or bill-stop. A withdrawal removes snapshots from memory while preserving their digests. If it removed any snapshot, it triggers the synchronous flush immediately. A failed withdrawal flush can leave snapshots already on disk. It still fences an older staged writer from publishing withdrawn snapshots after that point.

This machine tracks a readable slot with one pending write, an in-memory value and its last visible version. The staging result supplied by the shell says whether replacement occurred, including when directory sync later failed. When the captured generation differs, pending completion simply releases the slot and cannot change the visible value. The model's snapshot flag tells whether any retained payload remains. Authorization for a newly captured snapshot and the timer belong to the journal caller. Restart handoff for unread files is below.

Grace `apps/app/host/pilot/diagnostics-journal.ts:254–287,308–326,415–423,502–525`, `apps/app/host/task-storage-encryption.ts:72–84`.

```quint
type JournalValue = { identity: int, hasSnapshot: bool }
type JournalFile = { flushGeneration: int, memory: JournalValue, visible: JournalValue, pending: bool, staged: JournalValue, stagedGeneration: int }
pure val emptyJournal: JournalValue = { identity: 0, hasSnapshot: false }
pure val initial: JournalFile = { flushGeneration: 0, memory: emptyJournal, visible: emptyJournal, pending: false, staged: emptyJournal, stagedGeneration: 0 }
pure def recordJournalValue(journal: JournalFile, value: JournalValue): JournalFile = { ...journal, memory: value }
pure def canStartBackground(journal: JournalFile): bool = not(journal.pending)
pure def startBackground(journal: JournalFile): JournalFile =
  { ...journal, pending: true, staged: journal.memory, stagedGeneration: journal.flushGeneration }
pure def canFinishBackground(journal: JournalFile): bool = journal.pending
pure def finishBackground(journal: JournalFile, renamed: bool): JournalFile =
  if (renamed and journal.stagedGeneration == journal.flushGeneration)
    { ...journal, pending: false, visible: journal.staged }
  else { ...journal, pending: false }
pure def flushJournalFile(journal: JournalFile, renamed: bool): JournalFile =
  { ...journal, flushGeneration: journal.flushGeneration + 1, visible: if (renamed) journal.memory else journal.visible }
pure def canWithdrawSnapshots(journal: JournalFile): bool = journal.memory.hasSnapshot
pure def withdrawSnapshots(journal: JournalFile, renamed: bool): JournalFile =
  flushJournalFile({ ...journal, memory: { ...journal.memory, hasSnapshot: false } }, renamed)
pure def alwaysOnlyAStartedGenerationCanBePending(journal: JournalFile): bool =
  journal.flushGeneration >= 0 and journal.stagedGeneration <= journal.flushGeneration
pure def stepObsoleteBackgroundCannotReplace(before: JournalFile, via: str, after: JournalFile): bool =
  via == "finishBackground" and before.stagedGeneration != before.flushGeneration implies before.visible == after.visible
pure def stepSynchronousAttemptsAlwaysMoveGeneration(before: JournalFile, via: str, after: JournalFile): bool =
  via == "flushJournalFile" or via == "withdrawSnapshots" implies after.flushGeneration == before.flushGeneration + 1
pure def stepWithdrawalRemovesSnapshotFromMemory(before: JournalFile, via: str, after: JournalFile): bool =
  via == "withdrawSnapshots" implies not(after.memory.hasSnapshot)
pure def sometimesFreshBackgroundLands(journal: JournalFile): bool =
  not(journal.pending) and journal.flushGeneration == 0 and journal.visible.identity > 0
pure def sometimesWithdrawalLeavesOldDiskSnapshot(journal: JournalFile): bool =
  journal.flushGeneration > 0 and journal.visible.hasSnapshot and not(journal.memory.hasSnapshot)
pure def sometimesStagedSnapshotIsObsolete(journal: JournalFile): bool =
  journal.pending and journal.staged.hasSnapshot and not(journal.memory.hasSnapshot) and journal.stagedGeneration < journal.flushGeneration
pure val valueValues = Set(emptyJournal, { identity: 1, hasSnapshot: true }, { identity: 2, hasSnapshot: false })
pure val weight_recordJournalValue = 6
pure val weight_startBackground = 4
pure val weight_finishBackground = 4
pure val weight_withdrawSnapshots = 8
```

## Story: Recover the prior journal without hiding handoff failures

### The main file receives bounded read retries and final shutdown can write beside it

Startup reads `.unsaved` first, then the main journal. An authenticated decoded main file precedes the recovered sidecar and current entries in memory. A successful file read with malformed payload counts as read and contributes no rows. The journal's own row validation and configured retention bound apply independently. When the main file is absent, startup is readable and the next write can create it. An I/O or authentication failure of the main file sets three permitted retries. Each synchronous flush retries the main read. A successful or missing retry clears that count and writes the merged current value. If still unreadable, a non-final flush skips on each of the first two retry failures, then may replace the main on the third. A final unresolved read writes the current value to the sidecar without retiring the main. Once main successfully returns from writing, a sidecar that was read on startup is removed. A failed removal stays set for the next successful primary write. A failed sidecar read does not trigger main recovery's retry budget.

Grace `apps/app/host/pilot/diagnostics-journal.ts:239–241,261–285,502–525,528–596`.

```quint
pure val initialReadRetries = 3
type FlushDecision = { target: str, remaining: int }
pure def startupReadRetries(mainRead: str): int = if (mainRead == "unread") initialReadRetries else 0
pure def chooseFlush(remaining: int, finalFlush: bool, retryRead: str): FlushDecision =
  if (remaining <= 0 or retryRead != "unread") { target: "main", remaining: 0 }
  else if (finalFlush) { target: "unsaved", remaining: remaining }
  else if (remaining > 1) { target: "skip", remaining: remaining - 1 }
  else { target: "main", remaining: 0 }
pure def lawFinalUnreadMainUsesItsSidecar(remaining: int): bool =
  remaining > 0 implies chooseFlush(remaining, true, "unread").target == "unsaved"
pure def lawMainReadRetryBudgetIsBounded(remaining: int): bool =
  remaining > 0 and chooseFlush(remaining, false, "unread").target == "skip" implies chooseFlush(remaining, false, "unread").remaining < remaining
pure val mainReadValues = Set("missing", "unread", "malformed", "read")
pure val retryReadValues = Set("missing", "unread", "malformed", "read")
pure val remainingValues = Set(0, 1, 2, 3)
```

### A failed removal or an unread sidecar can corrupt the pinned handoff

This projection models the pinned fault fixture shape. Each process begins with one admitted urgent task record. Its configured faults are fixed across startup reads, any immediate urgent flush, and any final flush. A process killed with an unread main file has no final write. With successful synchronous I/O and readable files, the ordinary case preserves record order. If the main replacement already included a decoded sidecar and removal fails, startup can load those entries a second time. If startup cannot read the sidecar or main and the later final flush still cannot read main, a successful sidecar replacement can overwrite the prior entries. The model allows both outcomes. Neither diagnostic records nor readiness should claim the pinned handoff achieves exactly-once persistence across these failures. Ordered preservation in this projection is for the two-process fault fixture, independent of the journal's configured retention bound.

Grace `apps/app/host/pilot/diagnostics-journal.ts:261–271,311–325,502–525,536–566,593–596`, `apps/app/test/diagnostics-journal-faults.test.mjs:1–84`.

```quint
type HandoffDisk = { mainRows: List[int], sideRows: List[int] }
type ProcessFaults = { readMain: bool, readSide: bool, writeBlocked: bool, removeBlocked: bool, killed: bool }
pure val blankDisk: HandoffDisk = { mainRows: List(), sideRows: List() }
pure val cleanProcess: ProcessFaults = { readMain: false, readSide: false, writeBlocked: false, removeBlocked: false, killed: false }
pure def pinnedProcess(disk: HandoffDisk, faults: ProcessFaults, entry: int): HandoffDisk = {
  val recoveredSide = if (faults.readSide) List() else disk.sideRows
  val recorded = recoveredSide.append(entry)
  if (faults.writeBlocked) disk
  else if (faults.readMain)
    if (faults.killed) disk else { ...disk, sideRows: recorded }
  else { mainRows: disk.mainRows.concat(recorded), sideRows: if (faults.readSide or faults.removeBlocked) disk.sideRows else List() }
}
pure def restartRows(disk: HandoffDisk): List[int] = disk.mainRows.concat(disk.sideRows)
pure def lawCleanProcessPreservesOrder(disk: HandoffDisk, entry: int): bool =
  restartRows(pinnedProcess(disk, cleanProcess, entry)) == restartRows(disk).append(entry)
pure def lawFailedRemovalDuplicatesDecodedSidecar(entry: int, nextEntry: int): bool = {
  val fromOlder = pinnedProcess(blankDisk, { ...cleanProcess, readMain: true }, entry)
  val fromNewer = pinnedProcess(fromOlder, { ...cleanProcess, removeBlocked: true }, nextEntry)
  restartRows(fromNewer) == List(entry, nextEntry, entry)
}
pure def lawUnreadSidecarCanLoseADurableRecord(entry: int, nextEntry: int): bool = {
  val fromOlder = pinnedProcess(blankDisk, { ...cleanProcess, readMain: true }, entry)
  val fromNewer = pinnedProcess(fromOlder, { ...cleanProcess, readMain: true, readSide: true }, nextEntry)
  restartRows(fromNewer) == List(nextEntry)
}
pure val diskValues = Set(blankDisk, { mainRows: List(1), sideRows: List(2) }, { mainRows: List(1, 2), sideRows: List() })
pure val faultsValues = Set(cleanProcess, { ...cleanProcess, readMain: true }, { ...cleanProcess, readSide: true }, { ...cleanProcess, writeBlocked: true }, { ...cleanProcess, removeBlocked: true }, { ...cleanProcess, killed: true }, { ...cleanProcess, readMain: true, readSide: true })
pure val entryValues = Set(1, 2, 3)
pure val nextEntryValues = Set(1, 2, 3)
```

## Story: Preserve each acknowledged record through a replacement handoff

### Assign a stable identity and reconcile only authenticated exact copies

For the replacement, assign each new record a stable identity before staging its first write. The identity is a unique journal launch ID plus that launch's monotonic sequence number. Retries and copies keep both the identity and complete admitted payload. Two different records must not share an identity. Read both authenticated copies in source order and emit the record at most once for its identity. A duplicate with identical full payload needs no new write. Two authenticated copies with the same identity and different payloads produce a conflict, with both stored copies retained. If either relevant file is unreadable, return a typed recovery refusal and retain its bytes. A positively established missing file is distinct from unreadable. Do not assume a malformed ciphertext or corrupt payload contains no records.

Legacy rows have no stable record identity at this pin. Keep the original authenticated legacy material during import. Deduplicate only where a trusted identity establishes the same logical record. Preserve unresolved legacy copy ambiguity instead of inferring sameness from a timestamp, task ID or payload hash. The guarantee below applies to records written with replacement identities. The model projects one identity and uses a positive payload reference only for an exact, complete admitted payload.

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

A replacement uses independently staged fragments. Select a new exact name only for a positively established absent entry. Never write over an unread fragment. Existing copies accept only a retry of that same exact identity and payload. A successful durable receipt requires sealing, file sync, publication and a successful directory sync. If a platform cannot establish directory durability, report an unconfirmed write. Keep its fragment available through later recovery. Main consolidation writes the exact authenticated record, and retirement can begin only after the matching main copy is directory-durable. It retires only that exact fragment. If removal fails or crash recovery exposes a fragment again, its exact duplicate copy remains harmless. Retrying a conflicting or unread recovery cannot retire either copy.

The laws project durable presence, with zero for a positively established missing reference. A failed durability operation leaves the durable projection unchanged. This is a storage safety obligation conditional on reported durable syncs by the underlying host. A device may also lose the key, and process death can still lose entries for which no durable receipt was returned. The rules make no claim that a receipt forces future I/O to complete.

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
