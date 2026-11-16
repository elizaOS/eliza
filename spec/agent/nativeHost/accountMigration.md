# Native account file migration

Before the [runtime supervisor](./runtimeSupervisor.md) launches an
account's child, the native host removes a selected credential string from
that account's configuration files. It visits the files in a fixed
order, writes each replacement to a private temporary file and publishes
it by atomic rename. A file that is absent or
already lacks the string is retained as it is.

## Story: Upgrade an account's files without losing or half-writing one

> As a device owner, my account's files are cleaned of the old credential
> one at a time, each either fully replaced or untouched, and a file the
> host cannot read is left for me to repair rather than overwritten.

### Files are visited in order, and success means no selected credential remains

A migration attempt starts at the first file and moves to the next only
after the current one is retained or cleaned. It succeeds when every file
has been visited; every file before the cursor is then retained or clean.

```quint
type FileState = Dirty | Retained | Invalid | Clean
type MigrationPhase = MigrationIdle | Inspecting | Writing | Renaming | MigrationDone | MigrationFailed
type AccountFiles = { files: int -> FileState, cursor: int, phase: MigrationPhase, attempts: int }
pure val fileCount = 3
pure val slots = List(0, 1, 2)
pure val initial: AccountFiles = { files: Map(0 -> Dirty, 1 -> Invalid, 2 -> Retained), cursor: 0, phase: MigrationIdle, attempts: 0 }
pure def fileAt(files: int -> FileState, slot: int): FileState = if (files.keys().contains(slot)) files.get(slot) else Retained
pure def settledFile(fileState: FileState): bool = fileState == Retained or fileState == Clean
pure def canBeginMigration(a: AccountFiles): bool = a.phase == MigrationIdle or a.phase == MigrationDone or a.phase == MigrationFailed
pure def beginMigration(a: AccountFiles): AccountFiles = { ...a, cursor: 0, phase: Inspecting, attempts: a.attempts + 1 }
pure def canInspectFile(a: AccountFiles): bool = a.phase == Inspecting
pure def inspectFile(a: AccountFiles): AccountFiles = {
  val fileState = fileAt(a.files, a.cursor)
  if (settledFile(fileState)) { ...a, cursor: a.cursor + 1, phase: if (a.cursor == fileCount - 1) MigrationDone else Inspecting }
  else if (fileState == Dirty) { ...a, phase: Writing }
  else { ...a, phase: MigrationFailed }
}
pure def alwaysVisitedFilesAreSettled(a: AccountFiles): bool =
  a.cursor >= 0 and a.cursor <= fileCount and
  ((a.phase == Inspecting or a.phase == Writing or a.phase == Renaming) implies a.cursor < fileCount) and
  (a.phase == MigrationDone implies a.cursor == fileCount) and
  slots.every(slot => slot < a.cursor implies settledFile(fileAt(a.files, slot)))
pure def sometimesMigrationSucceeded(a: AccountFiles): bool = a.phase == MigrationDone and a.attempts > 1
```

### Only a dirty file is staged, and a clean file stays clean

The host stages a private replacement only for the file under the cursor
that still holds the credential, and publishing it by rename marks that
file clean. A clean file is never written again.

```quint
pure def canStageFile(a: AccountFiles): bool = a.phase == Writing
pure def stageFile(a: AccountFiles): AccountFiles = { ...a, phase: Renaming }
pure def canPublishFile(a: AccountFiles): bool = a.phase == Renaming
pure def publishFile(a: AccountFiles): AccountFiles =
  { ...a, files: a.files.put(a.cursor, Clean), cursor: a.cursor + 1, phase: if (a.cursor == fileCount - 1) MigrationDone else Inspecting }
pure def alwaysOnlyDirtyFilesAreStaged(a: AccountFiles): bool = (a.phase == Writing or a.phase == Renaming) implies fileAt(a.files, a.cursor) == Dirty
pure def stepCleanFilesStayClean(before: AccountFiles, after: AccountFiles): bool =
  slots.every(slot => fileAt(before.files, slot) == Clean implies fileAt(after.files, slot) == Clean)
pure def sometimesEarlierFileCleanedBeforeFailure(a: AccountFiles): bool = a.phase == MigrationFailed and fileAt(a.files, 0) == Clean
```

### A failure leaves every file as it was, and only the host repairs an unreadable one

An I/O failure while inspecting, writing or renaming ends the attempt with
the files unchanged; a staged replacement is never published. A file the
migration cannot parse fails the attempt and is never replaced by it; the
host repairs it in a separate step, after which a new attempt can clean it;
a repair names one of the account's files, and any other slot is refused.
Assuming inspection, staging and publication settle, every attempt ends.

```quint
pure def canIoFailure(a: AccountFiles): bool = a.phase == Inspecting or a.phase == Writing or a.phase == Renaming
pure def ioFailure(a: AccountFiles): AccountFiles = { ...a, phase: MigrationFailed }
pure def canRepairConfiguration(a: AccountFiles, slot: int): bool = a.phase == MigrationFailed and fileAt(a.files, slot) == Invalid and a.files.keys().contains(slot)
pure def repairConfiguration(a: AccountFiles, slot: int): AccountFiles = { ...a, files: a.files.put(slot, Dirty) }
pure val slotValues = Set(0, 1, 2, 3)
pure def stepFailureChangesNoFile(before: AccountFiles, via: str, after: AccountFiles): bool =
  (after.phase == MigrationFailed and before.phase != MigrationFailed) implies
    slots.every(slot => fileAt(after.files, slot) == fileAt(before.files, slot))
pure def stepOnlyRepairTouchesInvalidFiles(before: AccountFiles, via: str, after: AccountFiles): bool =
  (via != "repairConfiguration") implies
    slots.every(slot => fileAt(before.files, slot) == Invalid implies fileAt(after.files, slot) == Invalid)
pure def leadsToMigrationSettles(a: AccountFiles, later: AccountFiles): bool =
  (a.phase == Inspecting or a.phase == Writing or a.phase == Renaming) implies (later.phase == MigrationDone or later.phase == MigrationFailed)
pure val fair_inspectFile = "weak"
pure val fair_stageFile = "weak"
pure val fair_publishFile = "weak"
```
