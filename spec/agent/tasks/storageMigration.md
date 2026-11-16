# Legacy task migration and key replacement

Moving a consumer's legacy plaintext task data into
[encrypted task storage](./storageCustody.md), and resetting a slot whose key
is really gone. The task gateway opens only after migration succeeds.

## Story: Resume an interrupted migration without losing or exposing task data

> As a user, when my task data moves to encrypted storage and the move is
> interrupted, it resumes without losing a record or leaving plain text
> behind.

### A verified destination and marker precede plaintext removal

For an empty destination the primary database may become the target. An
existing primary is preserved and the legacy data goes to a separate
archive. The building marker binds an attempt to a slot and target. A
building marker for another slot does not reuse that attempt. A verified
marker allows removal of known plaintext without reopening it. An
unreadable or invalid marker fails explicitly.
The encrypted database is verified before and after placement at its final
path, with tables, ordering and sequence values compared, and the encrypted
journals and evidence must read back, before the verified marker is
written.

```quint
type MigrationPhase = FoundPlaintext | MarkerBuilding | DestinationChecked | FilesChecked | MarkerVerified | MigrationDone
type MigrationTarget = TargetUnknown | PrimaryCopy | ArchiveCopy
type Migration = { phase: MigrationPhase, target: MigrationTarget, existingPrimary: bool, plaintext: bool }
pure val initial: Migration = { phase: FoundPlaintext, target: TargetUnknown, existingPrimary: false, plaintext: true }
pure def canBeginMigration(m: Migration): bool = m.phase == FoundPlaintext
pure def beginMigration(m: Migration, primaryExists: bool): Migration =
  { ...m, phase: MarkerBuilding, existingPrimary: primaryExists, target: if (primaryExists) ArchiveCopy else PrimaryCopy }
pure def canVerifyDestination(m: Migration): bool = m.phase == MarkerBuilding
pure def verifyDestination(m: Migration, databaseSafe: bool): Migration =
  if (databaseSafe) { ...m, phase: DestinationChecked } else m
pure def canVerifyFiles(m: Migration): bool = m.phase == DestinationChecked
pure def verifyFiles(m: Migration, filesSafe: bool): Migration =
  if (filesSafe) { ...m, phase: FilesChecked } else m
pure def canWriteVerifiedMarker(m: Migration): bool = m.phase == FilesChecked
pure def writeVerifiedMarker(m: Migration, markerDurable: bool): Migration =
  if (markerDurable) { ...m, phase: MarkerVerified } else m
pure def canRemovePlaintext(m: Migration): bool = m.phase == MarkerVerified
pure def removePlaintext(m: Migration, removalCompleted: bool): Migration =
  if (removalCompleted) { ...m, phase: MigrationDone, plaintext: false } else m
pure def restartMigration(m: Migration): Migration =
  if (m.phase == DestinationChecked or m.phase == FilesChecked) { ...m, phase: MarkerBuilding } else m
pure def alwaysExistingPrimaryUsesArchive(m: Migration): bool =
  m.existingPrimary implies m.target == ArchiveCopy
pure def alwaysDoneMeansPlaintextWasRemoved(m: Migration): bool =
  m.plaintext iff m.phase != MigrationDone
pure def stepRemoveRequiresVerifiedMarker(before: Migration, after: Migration): bool =
  before.plaintext and not(after.plaintext) implies before.phase == MarkerVerified
pure def sometimesMigrationCompletes(m: Migration): bool = m.phase == MigrationDone
pure def sometimesExistingPrimaryIsPreserved(m: Migration): bool = m.phase == MigrationDone and m.target == ArchiveCopy
pure val weight_beginMigration = 4
pure val weight_verifyDestination = 4
pure val weight_verifyFiles = 4
pure val weight_writeVerifiedMarker = 4
pure val weight_removePlaintext = 4
```

## Story: Recover a slot whose task data key is gone

> As a user, when the key for my task data is really gone, the slot is reset
> with a new key, and a broker that is only unavailable never causes that.

### An unavailable broker does not authorize key replacement

Opening task storage distinguishes a read error, present key and absent key.
A typed read error leaves the files alone. An absent key means existing
ciphertext cannot be decrypted. The app removes those files and diagnostics
before requesting a new key. Closing the in-process session wipes its
copies without revoking the resident key. Explicit revocation names the
current key ID. The [broker](../../auth/credentialBroker.md) owns its durable effect
and clears native files.

```quint
type KeyRead = KeyPresent | KeyAbsent | KeyReadError
type KeyAdmission = RetainData | RemoveAndRequestKey | CustodyUnavailable
pure def keyAdmission(read: KeyRead, cleanupComplete: bool): KeyAdmission =
  if (read == KeyPresent) RetainData
  else if (read == KeyAbsent and cleanupComplete) RemoveAndRequestKey
  else CustodyUnavailable
pure def lawUnreadableKeyNeverRequestsReplacement(cleanupComplete: bool): bool =
  keyAdmission(KeyReadError, cleanupComplete) == CustodyUnavailable
pure def lawReplacementRequiresCleanSlot(read: KeyRead, cleanupComplete: bool): bool =
  keyAdmission(read, cleanupComplete) == RemoveAndRequestKey implies read == KeyAbsent and cleanupComplete
```
