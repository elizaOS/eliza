# Grace bill outcome journal framing and recovery

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` uses
`plugins/plugin-personal-assistant/native-host/bill-outcome-store.mjs`
from Eliza `7743504b7c936a764b3938a44cad918808b621df`.
[Bill review and outcome](./billReview.md) owns observation, row
commit and task completion. [Task storage](./taskStorage.md) owns
Grace's sealed file codec and key. This specification owns the file's
framing, write fence and interpretation of entries on startup.

## Story: Keep acknowledged payment evidence when the local journal is interrupted

### A failed append preserves the earlier acknowledged records and fences a damaged tail

The optional journal accepts a codec with callable encode and decode
operations. Encode the record's JSON before opening the file. A
nonempty encoded string with neither CR nor LF forms one record,
terminated by LF. A nonstring decode result or an invalid complete
record fails on read. The default codec keeps JSON text as-is.
On append, capture the previous file length, write the complete line
and sync the descriptor opened in append mode with file mode 0600.
Close the descriptor even if the write fails. If write or sync fails,
truncate to the captured length and sync again. If either rollback
operation fails, subsequent appends in that store instance fail until
startup recovery. A failed encode or open leaves the rollback fence
clear. The model assumes the owning process serializes this journal's
synchronous operations. File-system durability remains a port result.

```quint
type JournalFile = { acknowledged: int, appendFenced: bool, recoveredFromFence: bool }
type AppendEvidence = { encoded: bool, opened: bool, written: bool, synced: bool, tailTruncated: bool, repairSynced: bool }
pure val initial: JournalFile = { acknowledged: 0, appendFenced: false, recoveredFromFence: false }
pure def validEncodedJournalLine(text: bool, units: int, hasCarriageReturn: bool, hasNewline: bool): bool =
  text and units > 0 and not(hasCarriageReturn or hasNewline)
pure def canObserveJournalAppend(s: JournalFile): bool = not(s.appendFenced)
pure def observeJournalAppend(s: JournalFile, appendFacts: AppendEvidence): JournalFile =
  if (not(appendFacts.encoded and appendFacts.opened)) s
  else if (appendFacts.written and appendFacts.synced) { ...s, acknowledged: s.acknowledged + 1 }
  else { ...s, appendFenced: not(appendFacts.tailTruncated and appendFacts.repairSynced) }
pure def alwaysAcknowledgedCountIsNonnegative(s: JournalFile): bool = s.acknowledged >= 0
pure def stepAppendAcknowledgesAtMostOneLine(before: JournalFile, via: str, after: JournalFile): bool =
  via == "observeJournalAppend" and after.acknowledged > before.acknowledged implies not(before.appendFenced) and after.acknowledged == before.acknowledged + 1
pure def lawFailedSyncCannotAcknowledge(s: JournalFile, appendFacts: AppendEvidence): bool =
  not(appendFacts.written and appendFacts.synced) implies observeJournalAppend(s,appendFacts).acknowledged == s.acknowledged
pure def sometimesJournalNeedsRestart(s: JournalFile): bool = s.appendFenced
pure val cleanAppend: AppendEvidence = { encoded: true, opened: true, written: true, synced: true, tailTruncated: true, repairSynced: true }
pure val appendFactsValues = Set(cleanAppend, { ...cleanAppend, encoded: false },
  { ...cleanAppend, opened: false }, { ...cleanAppend, synced: false },
  { ...cleanAppend, synced: false, repairSynced: false }, { ...cleanAppend, written: false, tailTruncated: false })
```

### Startup can ignore an unfinished final fragment and fails closed on an invalid complete line

A missing file supplies no entries. Remove the final split segment
before decoding, whether it is empty or an unfinished line. Every
preceding line must decode to valid JSON. An invalid complete line
aborts opening the store. Other read failures also abort. Preserve
the original file if recovery fails. On successful recovery, encode
the retained entries, write and sync a separate exclusive 0600
temporary file, close it, then rename it over the old path. Only a
successful startup operation opens a new writer. A failed replacement
can leave a temporary file. Rows whose replay already committed can
be recognized on the next startup. The count observed by the model is
the number of retained entries in the successfully replaced file. The
state also records whether recovery has cleared an append fence.

```quint
type FileRead = MissingJournal | ReadJournal | JournalReadError
type RestartEvidence = { kind: FileRead, completeLinesValid: bool, recordsReconciled: bool, replacementCommitted: bool, retained: int }
pure def journalReadAdmitted(kind: FileRead, completeLinesValid: bool): bool =
  kind == MissingJournal or (kind == ReadJournal and completeLinesValid)
pure def canReopenJournal(s: JournalFile, restart: RestartEvidence): bool =
  journalReadAdmitted(restart.kind,restart.completeLinesValid) and restart.recordsReconciled and
    restart.replacementCommitted and restart.retained >= 0 and (restart.kind != MissingJournal or restart.retained == 0)
pure def reopenJournal(s: JournalFile, restart: RestartEvidence): JournalFile =
  { acknowledged: restart.retained, appendFenced: false, recoveredFromFence: s.recoveredFromFence or s.appendFenced }
pure def stepReopeningClearsAppendFence(before: JournalFile, via: str, after: JournalFile): bool =
  before.appendFenced and not(after.appendFenced) implies via == "reopenJournal"
pure def lawDamagedCompleteLinePreventsReopen(s: JournalFile, restart: RestartEvidence): bool =
  restart.kind == ReadJournal and not(restart.completeLinesValid) implies not(canReopenJournal(s,restart))
pure def lawFencedWriterCannotAppend(s: JournalFile): bool =
  s.appendFenced implies not(canObserveJournalAppend(s))
pure def sometimesRestartsAfterAppendFence(s: JournalFile): bool = s.recoveredFromFence
pure val restartOkay: RestartEvidence = { kind: ReadJournal, completeLinesValid: true, recordsReconciled: true, replacementCommitted: true, retained: 1 }
pure val restartValues = Set(restartOkay, { ...restartOkay, kind: MissingJournal, retained: 0 },
  { ...restartOkay, completeLinesValid: false }, { ...restartOkay, recordsReconciled: false },
  { ...restartOkay, replacementCommitted: false }, { ...restartOkay, kind: JournalReadError })
```

## Story: Recover saved evidence without sending anything to the payment website

### Recovery distinguishes a prior committed row from a pending observation

Each entry carries its task ID and serialized owner tuple. Outcomes
have no `kind` property or an undefined one. Attempts have kind
`attempt`. Any other kind or absent string identity fails. Decode the
owner tuple to four strings when looking up the task. Attempt replay
checks the original task before validating the stored attempt.
For an owned live task, keep its first valid database attempt.
When there is no row, try the original attempt insert. A refused
insert keeps the entry and the pending attempt in memory. If the task
no longer exists, drop the journal entry.

Validate an outcome before checking whether its owner row already
holds that exact decoded record. An equal row drops the journal entry.
A different or malformed row fails recovery. An absent row for an
existing task restores the observation in memory and keeps the entry
for a later explicit save. An absent row for a missing task drops the
entry. Replay can hand back the same local evidence after interruption.
Recovery only reads local evidence and writes local storage. The model takes codec, indexed row, and task-store
answers as observations of the same entry.

```quint
type RecoveryEntryKind = JournalAttempt | JournalOutcome | OtherJournalEntry
type JournalRow = NoJournalRow | ExactJournalRow | DifferentValidJournalRow | MalformedJournalRow
type EntryRecovery = DropJournalEntry | KeepPendingOutcome | KeepPendingAttempt | InsertedJournalAttempt | RejectJournalRestart
type EntryFacts = { envelopeValid: bool, kind: RecoveryEntryKind, taskExists: bool, recordValid: bool, storedRow: JournalRow, inserted: bool }
pure def classifyJournalEntry(entry: EntryFacts): EntryRecovery =
  if (not(entry.envelopeValid) or entry.kind == OtherJournalEntry) RejectJournalRestart
  else if (entry.kind == JournalAttempt and not(entry.taskExists)) DropJournalEntry
  else if (not(entry.recordValid) or entry.storedRow == MalformedJournalRow) RejectJournalRestart
  else if (entry.kind == JournalAttempt)
    (if (entry.storedRow != NoJournalRow) DropJournalEntry
     else if (entry.inserted) InsertedJournalAttempt else KeepPendingAttempt)
  else if (entry.storedRow == ExactJournalRow) DropJournalEntry
  else if (entry.storedRow == DifferentValidJournalRow) RejectJournalRestart
  else if (entry.taskExists) KeepPendingOutcome else DropJournalEntry
pure def lawRestoredObservationBelongsToAnExistingTask(entry: EntryFacts): bool =
  (classifyJournalEntry(entry) == KeepPendingOutcome or classifyJournalEntry(entry) == KeepPendingAttempt) implies entry.taskExists
pure def lawRecoveryNeverReplacesTheFirstAttempt(entry: EntryFacts): bool =
  classifyJournalEntry(entry) == InsertedJournalAttempt implies entry.kind == JournalAttempt and entry.storedRow == NoJournalRow and entry.inserted
pure def lawConflictingOutcomeRequiresRepair(entry: EntryFacts): bool =
  entry.kind == JournalOutcome and entry.storedRow == DifferentValidJournalRow implies classifyJournalEntry(entry) == RejectJournalRestart
pure val outcomeEntry: EntryFacts = { envelopeValid: true, kind: JournalOutcome, taskExists: true, recordValid: true, storedRow: NoJournalRow, inserted: false }
pure val entryValues = Set(outcomeEntry, { ...outcomeEntry, taskExists: false },
  { ...outcomeEntry, storedRow: ExactJournalRow }, { ...outcomeEntry, storedRow: DifferentValidJournalRow },
  { ...outcomeEntry, storedRow: MalformedJournalRow }, { ...outcomeEntry, kind: JournalAttempt },
  { ...outcomeEntry, kind: JournalAttempt, inserted: true }, { ...outcomeEntry, kind: JournalAttempt, storedRow: DifferentValidJournalRow },
  { ...outcomeEntry, kind: JournalAttempt, taskExists: false, recordValid: false }, { ...outcomeEntry, envelopeValid: false })
```

The pinned `bill-outcome-store.test.mjs` exercises real SQLite and files
across restart, interrupted row insertion, partial tails, malformed
complete lines, erased tasks, encoded records and append failures.
