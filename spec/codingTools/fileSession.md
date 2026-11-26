# Coding file sessions

Tracks per-conversation optimistic concurrency for a workspace file: initial and continued reads, opaque read references, overwrite protection, secret detection refusal, and surgical edits.

## Story: Protect workspace files against stale edits, accidental overwrites, and secret leaks

> As the owner, I want file edits and overwrites to succeed only after a fresh read of the current file revision, refuse content containing detected secrets, and invalidate prior read references whenever the file changes.

### Reading a file records its current revision and binds a resumable reference

A file session tracks the current file revision, whether the conversation has read the file, the last read revision, whether the file exists, and whether an opaque read reference is bound to a revision.

```quint
type FileSession = {
  currentRev: int,
  lastReadRev: int,
  hasRead: bool,
  fileExists: bool,
  refBound: bool,
  refRev: int,
  editsApplied: int,
  writesApplied: int
}
pure val initial: FileSession = {
  currentRev: 1,
  lastReadRev: 0,
  hasRead: false,
  fileExists: true,
  refBound: false,
  refRev: 0,
  editsApplied: 0,
  writesApplied: 0
}
pure def canReadFile(s: FileSession): bool = s.fileExists
pure def readFile(s: FileSession): FileSession = {
  ...s,
  hasRead: true,
  lastReadRev: s.currentRev,
  refBound: true,
  refRev: s.currentRev
}
pure def canContinueRead(s: FileSession, expectedRev: int): bool =
  s.fileExists and s.refBound and expectedRev == s.refRev and expectedRev == s.currentRev
pure def continueRead(s: FileSession, expectedRev: int): FileSession = s
```

### Editing or overwriting requires a fresh read, unambiguous match, and clean content

Surgical edits require an existing file read at the current revision, no detected secrets, and either a single exact match or `replaceAll` with at least one match. Overwriting an existing file requires `overwrite = true`, a fresh read, and no detected secrets. Creating a new file requires that the file does not yet exist and contains no detected secrets. Every write or edit advances the file revision, updates the conversation's read revision, and invalidates previous read references.

```quint
pure def canEditFile(s: FileSession, hasSecret: bool, matchCount: int, replaceAll: bool): bool =
  s.fileExists and s.hasRead and s.lastReadRev == s.currentRev and not(hasSecret) and
  (matchCount == 1 or (replaceAll and matchCount > 0))
pure def editFile(s: FileSession, hasSecret: bool, matchCount: int, replaceAll: bool): FileSession = {
  val nextRev = s.currentRev + 1
  {
    ...s,
    currentRev: nextRev,
    lastReadRev: nextRev,
    refBound: false,
    refRev: 0,
    editsApplied: s.editsApplied + 1
  }
}
pure def canWriteExistingFile(s: FileSession, overwrite: bool, hasSecret: bool): bool =
  s.fileExists and overwrite and s.hasRead and s.lastReadRev == s.currentRev and not(hasSecret)
pure def writeExistingFile(s: FileSession, overwrite: bool, hasSecret: bool): FileSession = {
  val nextRev = s.currentRev + 1
  {
    ...s,
    currentRev: nextRev,
    lastReadRev: nextRev,
    refBound: false,
    refRev: 0,
    writesApplied: s.writesApplied + 1
  }
}
pure def canCreateNewFile(s: FileSession, hasSecret: bool): bool =
  not(s.fileExists) and not(hasSecret)
pure def createNewFile(s: FileSession, hasSecret: bool): FileSession = {
  val nextRev = s.currentRev + 1
  {
    ...s,
    fileExists: true,
    hasRead: true,
    currentRev: nextRev,
    lastReadRev: nextRev,
    refBound: false,
    refRev: 0,
    writesApplied: s.writesApplied + 1
  }
}
```

### External modifications invalidate freshness until the file is read again

An external modification advances the file's revision without updating the conversation's `lastReadRev`, forcing a fresh read before any edit or overwrite. Removing the file externally clears its existence and read reference.

```quint
pure def canExternalModify(s: FileSession): bool = s.fileExists
pure def externalModify(s: FileSession): FileSession = {
  ...s,
  currentRev: s.currentRev + 1
}
pure def canDeleteExternally(s: FileSession): bool = s.fileExists
pure def deleteExternally(s: FileSession): FileSession = {
  ...s,
  fileExists: false,
  refBound: false,
  refRev: 0
}
pure val matchCountValues = Set(0, 1, 2)
pure val expectedRevValues = Set(0, 1, 2, 3)
```

### A device file follows the same read-before-overwrite rule, by content

A file on the paired device's filesystem has no inode or modification time, so
its revision is the hash of its content. Creating a device file needs no prior
read; overwriting one needs `overwrite = true` and a read in this conversation
whose revision is still the file's current content. A write is done only once
reading the file back returns the written content, and it returns an effect
receipt. A read returns at most one output window of the file, says where it
stopped and the offset to continue from, and never cuts base64 content mid
quantum. A device bridge failure is a typed failure, never an empty result.

```quint
pure def deviceWriteAllowed(fileThere: bool, overwrite: bool, readMatchesCurrent: bool, hasSecret: bool): bool =
  not(hasSecret) and (not(fileThere) or (overwrite and readMatchesCurrent))
pure def lawDeviceOverwriteNeedsFreshRead(overwrite: bool, hasSecret: bool): bool =
  not(deviceWriteAllowed(true, overwrite, false, hasSecret))
pure def lawDeviceOverwriteNeedsFlag(readMatchesCurrent: bool, hasSecret: bool): bool =
  not(deviceWriteAllowed(true, false, readMatchesCurrent, hasSecret))
```

### File session invariants and reachability

Revisions stay positive and monotone, the last read revision never exceeds the current revision, bound read references always correspond to an existing read file, and every mutation advances the revision and clears stale references.

```quint
pure def alwaysFileSessionValid(s: FileSession): bool =
  s.currentRev >= 1 and
  s.lastReadRev >= 0 and s.lastReadRev <= s.currentRev and
  s.editsApplied >= 0 and s.writesApplied >= 0 and
  (s.refBound implies (s.fileExists and s.hasRead and s.refRev >= 1 and s.refRev <= s.currentRev))
pure def stepRevisionMonotone(before: FileSession, after: FileSession): bool =
  after.currentRev >= before.currentRev
pure def stepMutationRequiresFreshRead(before: FileSession, via: str, after: FileSession): bool =
  (via == "editFile" or via == "writeExistingFile") implies (
    before.hasRead and before.lastReadRev == before.currentRev and
    after.currentRev == before.currentRev + 1 and not(after.refBound)
  )
pure def sometimesEdited(s: FileSession): bool = s.editsApplied > 0
pure def sometimesCreatedAfterDelete(s: FileSession): bool = s.writesApplied > 0 and s.fileExists
pure def sometimesStaleAfterExternalChange(s: FileSession): bool = s.hasRead and s.lastReadRev < s.currentRev
```
