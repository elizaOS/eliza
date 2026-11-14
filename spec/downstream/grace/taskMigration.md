# Legacy task migration and key replacement

Grace's `task-storage-migration.ts` composes a legacy SQLite reader with the
pinned Eliza SQLCipher provider and authenticated file sealer. The app opens
the migrated task gateway only after this composition succeeds. The shared
[storage contract](./taskStorage.md) separately governs new encrypted opens.

## Story: Resume an interrupted migration without losing or exposing task data

### A verified destination and marker precede plaintext removal

For an empty destination the primary database may become the target. An
existing primary is preserved and the legacy data goes to a separate
archive. The building marker binds an attempt to a slot and target. A
building marker for another slot does not reuse that attempt. A verified
marker allows removal of known plaintext without reopening it. An
unreadable or invalid marker fails explicitly.

The encrypted database is verified before and after placement at its final
path. Existing tables, ordering and sequence values must compare. The
encrypted journals and evidence must read back before the verified
marker. No real filesystem or cryptography is executed by this machine.
Key mismatch, comparator failure and partial cleanup are explicit results
of the respective ports. Presence of a legacy database is separated from
presence of a legacy artifact, as a valid migration can consist of
journals and evidence alone.

```quint
type MigrationPhase = FoundPlaintext | MarkerBuilding | DestinationChecked | FilesChecked | MarkerVerified | MigrationDone
type MigrationTarget = TargetUnknown | PrimaryCopy | ArchiveCopy
type Migration = { phase: MigrationPhase, target: MigrationTarget, existingPrimary: bool, plaintext: bool }
pure val foundPlaintext: MigrationPhase = FoundPlaintext
pure val markerBuilding: MigrationPhase = MarkerBuilding
pure val destinationChecked: MigrationPhase = DestinationChecked
pure val filesChecked: MigrationPhase = FilesChecked
pure val markerVerified: MigrationPhase = MarkerVerified
pure val migrationDone: MigrationPhase = MigrationDone
pure val targetUnknown: MigrationTarget = TargetUnknown
pure val primaryCopy: MigrationTarget = PrimaryCopy
pure val archiveCopy: MigrationTarget = ArchiveCopy
pure val initial: Migration = { phase: foundPlaintext, target: targetUnknown, existingPrimary: false, plaintext: true }
pure def canBeginMigration(m: Migration): bool = m.phase == foundPlaintext
pure def beginMigration(m: Migration, primaryExists: bool): Migration =
  { ...m, phase: markerBuilding, existingPrimary: primaryExists, target: if (primaryExists) archiveCopy else primaryCopy }
pure def canVerifyDestination(m: Migration): bool = m.phase == markerBuilding
pure def verifyDestination(m: Migration, databaseSafe: bool): Migration =
  if (databaseSafe) { ...m, phase: destinationChecked } else m
pure def canVerifyFiles(m: Migration): bool = m.phase == destinationChecked
pure def verifyFiles(m: Migration, filesSafe: bool): Migration =
  if (filesSafe) { ...m, phase: filesChecked } else m
pure def canWriteVerifiedMarker(m: Migration): bool = m.phase == filesChecked
pure def writeVerifiedMarker(m: Migration, markerDurable: bool): Migration =
  if (markerDurable) { ...m, phase: markerVerified } else m
pure def canRemovePlaintext(m: Migration): bool = m.phase == markerVerified
pure def removePlaintext(m: Migration, removalCompleted: bool): Migration =
  if (removalCompleted) { ...m, phase: migrationDone, plaintext: false } else m
pure def restartMigration(m: Migration): Migration =
  if (m.phase == destinationChecked or m.phase == filesChecked) { ...m, phase: markerBuilding } else m
pure def alwaysExistingPrimaryUsesArchive(m: Migration): bool =
  m.existingPrimary implies m.target == archiveCopy
pure def alwaysDoneMeansPlaintextWasRemoved(m: Migration): bool =
  m.plaintext iff m.phase != migrationDone
pure def stepRemoveRequiresVerifiedMarker(before: Migration, after: Migration): bool =
  before.plaintext and not(after.plaintext) implies before.phase == markerVerified
pure def sometimesMigrationCompletes(m: Migration): bool = m.phase == migrationDone
pure def sometimesExistingPrimaryIsPreserved(m: Migration): bool = m.phase == migrationDone and m.target == archiveCopy
pure val weight_beginMigration = 4
pure val weight_verifyDestination = 4
pure val weight_verifyFiles = 4
pure val weight_writeVerifiedMarker = 4
pure val weight_removePlaintext = 4
```

## Story: Recover a slot whose task data key is gone

### An unavailable broker does not authorize key replacement

`openTaskStorage` distinguishes read error, present key and absent key.
A typed read error leaves the files alone. An absent key means existing
ciphertext cannot be decrypted. The app removes those files and diagnostics
before requesting a new key. Closing the in-process session wipes its
copies without revoking the resident key. Explicit revocation names the
current key ID. The [broker](../mobileBroker.md) owns its durable effect
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
