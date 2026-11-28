# SQLite atomic backup publication

## Story: Publish a durable SQLite backup without overwriting an existing destination

> As a host backing up an agent's SQLite database, I want snapshot creation, file sync, exclusive publication, and newly created ancestor directory flushes to finish before success is reported, while any concurrent creator at the destination wins without replacement.

### Backup publication reports success only after the snapshot and its ancestor directory chain are durable

A backup stages its `VACUUM INTO` snapshot in a private sibling directory, flushes the snapshot file, publishes it with an exclusive hard link, and flushes every newly created ancestor directory plus its pre-existing parent before reporting completion. Any concurrent creator at the destination causes publication to fail without replacing the existing file.

```quint
type BackupPhase =
  | BackupIdle
  | BackupSnapshot
  | BackupPublish
  | BackupDirectories
  | BackupComplete
  | BackupFailed

type BackupDestination = DestAbsent | DestOurs | DestOther

type BackupState = {
  phase: BackupPhase,
  destination: BackupDestination,
  fileSynced: bool,
  newDirectories: int,
  flushed: int,
  reported: bool
}

pure val initial: BackupState = {
  phase: BackupIdle,
  destination: DestAbsent,
  fileSynced: false,
  newDirectories: 0,
  flushed: 0,
  reported: false
}

pure def canPrepare(s: BackupState, newDirs: int): bool =
  s.phase == BackupIdle and newDirs >= 0 and newDirs <= 2

pure def prepare(s: BackupState, newDirs: int): BackupState =
  { ...s, phase: BackupSnapshot, newDirectories: newDirs }

pure def canFlushFile(s: BackupState): bool =
  s.phase == BackupSnapshot

pure def flushFile(s: BackupState): BackupState =
  { ...s, phase: BackupPublish, fileSynced: true }

pure def canConcurrentCreate(s: BackupState): bool =
  (s.phase == BackupIdle or s.phase == BackupSnapshot or s.phase == BackupPublish) and
  s.destination == DestAbsent

pure def concurrentCreate(s: BackupState): BackupState =
  { ...s, destination: DestOther }

pure def canPublish(s: BackupState): bool =
  s.phase == BackupPublish

pure def publish(s: BackupState): BackupState =
  if (s.destination == DestAbsent)
    { ...s, destination: DestOurs, phase: BackupDirectories }
  else
    { ...s, phase: BackupFailed }

pure def canFlushDirectory(s: BackupState): bool =
  s.phase == BackupDirectories and s.flushed < s.newDirectories + 1

pure def flushDirectory(s: BackupState): BackupState =
  { ...s, flushed: s.flushed + 1 }

pure def canReport(s: BackupState): bool =
  s.phase == BackupDirectories and s.flushed == s.newDirectories + 1

pure def report(s: BackupState): BackupState =
  { ...s, phase: BackupComplete, reported: true }

pure def canAbortBackup(s: BackupState): bool =
  s.phase != BackupComplete and s.phase != BackupFailed

pure def abortBackup(s: BackupState): BackupState =
  { ...s, phase: BackupFailed }

pure def alwaysBackupBounds(s: BackupState): bool =
  s.newDirectories >= 0 and s.newDirectories <= 2 and
  s.flushed >= 0 and s.flushed <= s.newDirectories + 1

pure def alwaysPrePublishNotDurable(s: BackupState): bool =
  (s.phase == BackupIdle or s.phase == BackupSnapshot) implies
    (s.destination != DestOurs and not(s.fileSynced) and s.flushed == 0 and not(s.reported))

pure def alwaysPublishAwaitingLink(s: BackupState): bool =
  s.phase == BackupPublish implies
    (s.fileSynced and s.destination != DestOurs and s.flushed == 0 and not(s.reported))

pure def alwaysDirectoriesLinked(s: BackupState): bool =
  s.phase == BackupDirectories implies
    (s.fileSynced and s.destination == DestOurs and not(s.reported))

pure def alwaysReportOnlyDurable(s: BackupState): bool =
  s.reported implies
    (s.fileSynced and s.destination == DestOurs and s.flushed == s.newDirectories + 1 and s.phase == BackupComplete)

pure def alwaysFailureIsNotSuccess(s: BackupState): bool =
  s.phase == BackupFailed implies not(s.reported)

pure def stepExistingDestinationPreserved(before: BackupState, via: str, after: BackupState): bool =
  before.destination == DestOther implies after.destination == DestOther

pure def sometimesBackupReported(s: BackupState): bool =
  s.reported and s.newDirectories == 2

pure def sometimesConcurrentCreatorWins(s: BackupState): bool =
  s.phase == BackupFailed and s.destination == DestOther

pure def sometimesBackupFailed(s: BackupState): bool =
  s.phase == BackupFailed and not(s.reported)

pure val newDirsValues = Set(0, 1, 2)
```
