# Android workflow source publication

Alpha's pinned workflow worker uses
`plugins/plugin-workflow/src/services/workflow-source-publication.ts`
at Eliza `c518127a025ab173874af9c7d304f26b25213b0d`.
[Worker provenance](./workflowWorker.md) governs compiler and bundle identity.
This contract concerns cooperating publishers under the trusted Android app
UID and the exact source bytes an importer can see.

## Story: Import only complete reviewed workflow source

### Only the reservation owner can publish or release an incomplete write

The parent is the exact canonical, caller-owned directory with no group
or world write permission. Existing source must be an owned regular
file with private permissions and exact byte length and contents.
Existing equal source is successful after directory synchronization.
An incompatible file is refused. Otherwise a publisher exclusively
creates a private reservation directory. A waiter checks for an exact
published file and leaves the reservation intact when its 5-second
deadline runs out. A publisher exclusively opens a private temporary
file, writes and syncs it, rechecks the reservation's device, inode,
owner and mode, then renames the complete file. It checks the published
source and syncs the parent before acknowledging. Cleanup removes only
the owned reservation. A crash preserves the reservation for recovery.
A late cleanup error can follow a durable publication. If synchronization
fails after renaming, an exact file may remain visible after cleanup. A
later exact read and directory sync can acknowledge it.

```quint
type SourcePhase = SourceVacant | SourceReserved | SourceStaged | SourceRenamed | SourceDurable
type SourcePublication = { phase: SourcePhase, serial: int, reservation: int, fileKey: str, stagedKey: str, crashed: bool }
pure val initial: SourcePublication = { phase: SourceVacant, serial: 0, reservation: 0, fileKey: "", stagedKey: "", crashed: false }
pure def canReserveSource(s: SourcePublication, parentAdmitted: bool, custody: int): bool =
  s.phase == SourceVacant and parentAdmitted and custody == s.serial + 1
pure def reserveSource(s: SourcePublication, parentAdmitted: bool, custody: int): SourcePublication =
  { ...s, phase: SourceReserved, serial: custody, reservation: custody }
pure def canStageSource(s: SourcePublication, custody: int, sourceKey: str, temporarySynced: bool): bool =
  s.phase == SourceReserved and not(s.crashed) and custody == s.reservation and sourceKey != "" and temporarySynced
pure def stageSource(s: SourcePublication, custody: int, sourceKey: str, temporarySynced: bool): SourcePublication =
  { ...s, phase: SourceStaged, stagedKey: sourceKey }
pure def canRenameSource(s: SourcePublication, custody: int, inodeExact: bool, stillAbsent: bool): bool =
  s.phase == SourceStaged and not(s.crashed) and custody == s.reservation and inodeExact and stillAbsent
pure def renameSource(s: SourcePublication, custody: int, inodeExact: bool, stillAbsent: bool): SourcePublication =
  { ...s, phase: SourceRenamed, fileKey: s.stagedKey }
pure def canSyncSource(s: SourcePublication, fileExact: bool, parentSynced: bool): bool =
  s.phase == SourceRenamed and fileExact and parentSynced
pure def syncSource(s: SourcePublication, fileExact: bool, parentSynced: bool): SourcePublication = { ...s, phase: SourceDurable }
pure def canReleaseSource(s: SourcePublication, custody: int, inodeExact: bool): bool =
  s.reservation > 0 and not(s.crashed) and custody == s.reservation and inodeExact
pure def releaseSource(s: SourcePublication, custody: int, inodeExact: bool): SourcePublication =
  { ...s, phase: if (s.phase == SourceDurable or s.phase == SourceRenamed) s.phase else SourceVacant, reservation: 0, stagedKey: "" }
pure def canCrashPublisher(s: SourcePublication): bool = s.reservation > 0
pure def crashPublisher(s: SourcePublication): SourcePublication = { ...s, crashed: true }
pure val custodyValues = Set(1, 2, 3)
pure val sourceKeyValues = Set("", "sha-a", "sha-b")
pure def alwaysSourcePublicationCoordinates(s: SourcePublication): bool =
  s.serial >= 0 and s.reservation >= 0 and s.reservation <= s.serial and
  (s.phase == SourceVacant implies s.reservation == 0 and s.stagedKey == "" and not(s.crashed)) and
  ((s.phase == SourceReserved or s.phase == SourceStaged) implies s.reservation > 0) and
  (s.phase == SourceStaged implies s.stagedKey != "")
pure def alwaysOnlyCompleteSourceVisible(s: SourcePublication): bool =
  (s.fileKey != "") == (s.phase == SourceRenamed or s.phase == SourceDurable)
pure def stepPublishedSourceDoesNotChange(before: SourcePublication, after: SourcePublication): bool =
  before.fileKey != "" implies after.fileKey == before.fileKey
pure def stepCrashPreservesReservation(before: SourcePublication, after: SourcePublication): bool =
  before.crashed implies after.reservation == before.reservation
pure def sometimesRenameVisibleWithoutSync(s: SourcePublication): bool = s.phase == SourceRenamed and s.reservation == 0
pure def sometimesSourcePublished(s: SourcePublication): bool = s.phase == SourceDurable and s.reservation == 0
pure def sometimesCrashedReservationStays(s: SourcePublication): bool = s.crashed and s.reservation > 0
```
