# Photo replacement

A Replace writes an edit over the original photo the person reviewed,
instead of saving a copy. One operation id names one journal record that
moves through `incomplete`, `writing`, then `saved`, `failed` or `stale`.
The truncating write over the original is the only step that can cost the
person their photo, so it runs once, after two durable private backups, and
an interrupted write is settled later from what the target's bytes prove.
The source is `OwnedPhotoEdits` (`replaceConsent`, `replace`,
`settleReplace`, `replaceResult`, `sweepSettledBackups`) and `PhotoCrop` in
`plugins/plugin-native-media`. The shell owns decoding, encoding, file I/O,
digests and the journal; this spec owns the decisions on the facts they
report. [Media rows](./rows.md) supplies the source revision check.

## Story: Replace a photo only with two backups

> As the person, I want Replace to overwrite only the original I reviewed,
> and only after the app has kept both the original and the edit, so that
> no failure can leave me without my photo.

### Replace reserves an operation only for a changed edit of a writable still at its reviewed revision

Replace applies to a still JPEG, PNG or WebP. The app writes its own photos
directly; another app's photo needs Android 11 or later, and then app-wide
file access or the person's per-item write consent. A recorded operation
answers from its record before any new consent request. An edit that keeps
the whole photo, rotation 0 and no filter answers `unchanged`; a source
whose revision or SHA-256 differs from the reviewed one answers `stale`.
Neither reserves a record. A chosen crop rectangle outside the photo is
refused by the shell before an edit exists.

```quint
import rows.* from "./rows"
type CropChoice = WholePhoto | CenteredCrop | ChosenRect({ rectKey: int })
type ReplaceEdit = { rotation: int, crop: CropChoice, filtered: bool }
type WriteAuthority = AppOwned | AllFilesAccess | ItemConsent({ granted: bool }) | NoWriteConsentApi
type ReplaceRequest = { stillImage: bool, authority: WriteAuthority, source: RowInspection }
type ReplaceAdmission = RefuseReplace | AnswerUnchanged | AnswerStale | ReserveReplace
type ReplacePhase = Unreserved | Reserved | Prepared | WriteOpen | Interrupted({ restoring: bool })
  | Saved | Failed({ restored: bool }) | Stale
type ReplaceState = { phase: ReplacePhase, edit: ReplaceEdit, backups: bool, liveWrites: int }
pure val noEdit: ReplaceEdit = { rotation: 0, crop: WholePhoto, filtered: false }
pure val initial: ReplaceState = { phase: Unreserved, edit: noEdit, backups: false, liveWrites: 0 }
pure def editChanged(edit: ReplaceEdit): bool = edit.rotation != 0 or edit.crop != WholePhoto or edit.filtered
pure def replaceAdmission(request: ReplaceRequest, edit: ReplaceEdit): ReplaceAdmission =
  if (not(request.stillImage) or request.authority == NoWriteConsentApi) RefuseReplace
  else if (request.authority == ItemConsent({ granted: false })) RefuseReplace
  else if (not(editChanged(edit))) AnswerUnchanged
  else if (not(rowAtListing(request.source))) AnswerStale
  else ReserveReplace
pure def canReserveReplacement(s: ReplaceState, edit: ReplaceEdit, request: ReplaceRequest): bool =
  s.phase == Unreserved and replaceAdmission(request, edit) == ReserveReplace
pure def reserveReplacement(s: ReplaceState, edit: ReplaceEdit, request: ReplaceRequest): ReplaceState =
  { ...s, phase: Reserved, edit: edit }
pure def lawReservationNeedsAuthorityAndReviewedSource(request: ReplaceRequest, edit: ReplaceEdit): bool =
  replaceAdmission(request, edit) == ReserveReplace implies
    (request.stillImage and editChanged(edit) and rowAtListing(request.source) and
      (request.authority == AppOwned or request.authority == AllFilesAccess or request.authority == ItemConsent({ granted: true })))
pure val reviewedSource: RowInspection = RowAtListing({ alreadyDesired: false })
pure val ownedRequest: ReplaceRequest = { stillImage: true, authority: AppOwned, source: reviewedSource }
pure val requestValues = Set(ownedRequest, { ...ownedRequest, authority: ItemConsent({ granted: true }) },
  { ...ownedRequest, authority: ItemConsent({ granted: false }) }, { ...ownedRequest, authority: NoWriteConsentApi },
  { ...ownedRequest, source: RowChangedSinceListing }, { ...ownedRequest, stillImage: false })
pure val editValues = Set(noEdit, { ...noEdit, crop: ChosenRect({ rectKey: 2 }) }, { ...noEdit, crop: ChosenRect({ rectKey: 3 }) },
  { ...noEdit, crop: CenteredCrop }, { ...noEdit, rotation: 90, filtered: true })
```

### An operation stays bound to the edit it first reserved

The record keeps the rotation, the crop (the centered crop, or the chosen
rectangle's key) and the filter. A repeated Replace with the same edit
answers from the record without writing again; any other edit, including
the centered crop after a rectangle, is refused, across cancel and restart.

```quint
pure def stepReservedEditIsFixed(before: ReplaceState, after: ReplaceState): bool =
  before.phase != Unreserved implies after.edit == before.edit
pure def sometimesChosenCropSaved(s: ReplaceState): bool =
  s.phase == Saved and s.edit.crop != WholePhoto and s.edit.crop != CenteredCrop and s.liveWrites == 1
```

### Both backups and the writing record are durable before the one live write opens

Preparation reads the original, checks its SHA-256 and revision again,
decodes it upright in sRGB up to 16 Mi pixels and encodes the edit in the
original format (JPEG keeps the chosen EXIF fields with normal
orientation). With the editor still open and the source unchanged, it
writes the original bytes and the encoded edit to new private files that
refuse symbolic links, forces each to disk, and commits the `writing`
record naming both files, the target URI and both digests. A changed source
answers `stale`; any other failure, or a process death while `incomplete`,
settles `failed`. The truncating write opens only after the same source
revision, bytes and URI are checked once more, and at most once per
operation.

```quint
type StageResult = StagedWithBackups | StageSourceChanged | StageFailed
pure def canPrepareReplacement(s: ReplaceState, staged: StageResult): bool = s.phase == Reserved
pure def prepareReplacement(s: ReplaceState, staged: StageResult): ReplaceState =
  if (staged == StagedWithBackups) { ...s, phase: Prepared, backups: true }
  else if (staged == StageSourceChanged) { ...s, phase: Stale }
  else { ...s, phase: Failed({ restored: false }) }
pure def canOpenLiveWrite(s: ReplaceState, recheck: RowInspection): bool = s.phase == Prepared
pure def openLiveWrite(s: ReplaceState, recheck: RowInspection): ReplaceState =
  if (rowAtListing(recheck)) { ...s, phase: WriteOpen, liveWrites: s.liveWrites + 1 } else { ...s, phase: Stale }
pure def holdsWritingRecord(p: ReplacePhase): bool = match p {
  | Prepared => true | WriteOpen => true | Interrupted(_) => true | _ => false }
pure def alwaysWritingRecordKeepsBackups(s: ReplaceState): bool = holdsWritingRecord(s.phase) implies s.backups
pure def alwaysOneLiveWrite(s: ReplaceState): bool =
  s.liveWrites >= 0 and s.liveWrites <= 1 and
  ((s.phase == Unreserved or s.phase == Reserved or s.phase == Prepared) implies s.liveWrites == 0) and
  (s.phase == WriteOpen implies s.liveWrites == 1)
pure def stepLiveWriteFollowsDurableBackups(before: ReplaceState, after: ReplaceState): bool =
  after.liveWrites > before.liveWrites implies (before.phase == Prepared and before.backups)
pure val recheckValues = Set(reviewedSource, RowChangedSinceListing, RowInspectFailed)
```

### A stale answer means the original was never written

Stale tells the person their photo changed and nothing was written, so it
is given only before the live write opens.

```quint
pure def alwaysStaleNeverWroteOriginal(s: ReplaceState): bool = s.phase == Stale implies s.liveWrites == 0
pure def sometimesStaleAfterBackups(s: ReplaceState): bool = s.phase == Stale and s.backups
```

### A completed write is saved, and its receipt failure leaves the record to settle

A synced write of every edit byte is the saved edit; the reply is `saved`
with the original's id, and its new revision once MediaStore rescans it.
When the final receipt cannot be committed, the reply is still `saved` and
the record stays `writing` with both backups, so the next result read
recognizes the edit by digest. A write that throws, or a process death
after the record is committed, leaves the record `writing` to be settled.

```quint
pure def canCompleteLiveWrite(s: ReplaceState, receiptCommitted: bool): bool = s.phase == WriteOpen
pure def completeLiveWrite(s: ReplaceState, receiptCommitted: bool): ReplaceState =
  if (receiptCommitted) { ...s, phase: Saved } else { ...s, phase: Interrupted({ restoring: false }) }
pure def canInterruptReplacement(s: ReplaceState): bool = s.phase == Prepared or s.phase == WriteOpen
pure def interruptReplacement(s: ReplaceState): ReplaceState = { ...s, phase: Interrupted({ restoring: false }) }
pure def sometimesReplacementSaved(s: ReplaceState): bool = s.phase == Saved and s.liveWrites == 1
```

### Backups are discarded only after the record settles

Removal is best effort: a backup file is deleted only when its bytes still
have the recorded digest, and a startup sweep retries for `saved` and
`failed` records. An unknown record keeps both.

```quint
pure def settledPhase(p: ReplacePhase): bool = match p { | Saved => true | Failed(_) => true | Stale => true | _ => false }
pure def canDiscardBackups(s: ReplaceState): bool = settledPhase(s.phase) and s.backups
pure def discardBackups(s: ReplaceState): ReplaceState = { ...s, backups: false }
pure def sometimesSavedWithoutBackups(s: ReplaceState): bool = s.phase == Saved and not(s.backups)
```

## Story: Get my photo back after an interrupted write

> As the person, I want an interrupted Replace to leave me either the edit
> or my original, so that a crash never costs me the photo.

### Recovery restores only damage it can attribute to this operation

Recovery needs the named regular original backup and readable bytes at the
recorded target URI; anything else stays unknown. The full edit digest
settles saved and the full original digest settles failed. Restoring over
other bytes also needs the original backup's digest verified and either
the damage digest the failed writer recorded, or a verified edit backup and
a strict prefix of the edit (empty included). A prefix of the original is
admitted only after a durable restore mark, since only a restore writes
one. Newer or unrelated bytes are never overwritten.

```quint
type TargetBytes = TargetUnavailable | FullEdit | FullOriginal | RecordedDamage | EditPrefix | OriginalPrefix | OtherBytes
type BackupProof = BackupMissing | BackupPresent | BackupVerified
type RecoveryFacts = { target: TargetBytes, backup: BackupProof, editBackupVerified: bool }
type RecoveryPlan = KeepUnknown | RecoverSaved | RecoverOriginal | RestoreOriginal
pure def recoveryPlan(facts: RecoveryFacts, restoring: bool): RecoveryPlan =
  if (facts.backup == BackupMissing or facts.target == TargetUnavailable) KeepUnknown
  else if (facts.target == FullEdit) RecoverSaved
  else if (facts.target == FullOriginal) RecoverOriginal
  else if (facts.backup == BackupVerified and (facts.target == RecordedDamage or (facts.editBackupVerified and
    (facts.target == EditPrefix or (facts.target == OriginalPrefix and restoring))))) RestoreOriginal
  else KeepUnknown
pure def lawUnrelatedBytesAreNeverOverwritten(facts: RecoveryFacts, restoring: bool): bool =
  (facts.target == OtherBytes or facts.target == TargetUnavailable) implies recoveryPlan(facts, restoring) == KeepUnknown
pure def lawOriginalPrefixNeedsRestoreMark(facts: RecoveryFacts): bool =
  facts.target == OriginalPrefix implies recoveryPlan(facts, false) != RestoreOriginal
pure def lawRestoreNeedsVerifiedOriginalBackup(facts: RecoveryFacts, restoring: bool): bool =
  recoveryPlan(facts, restoring) == RestoreOriginal implies facts.backup == BackupVerified
pure val recoveredDamage: RecoveryFacts = { target: EditPrefix, backup: BackupVerified, editBackupVerified: true }
pure val factsValues = Set(recoveredDamage, { ...recoveredDamage, target: FullEdit }, { ...recoveredDamage, target: FullOriginal },
  { ...recoveredDamage, target: OriginalPrefix }, { ...recoveredDamage, target: RecordedDamage, editBackupVerified: false },
  { ...recoveredDamage, target: OtherBytes }, { ...recoveredDamage, target: TargetUnavailable },
  { ...recoveredDamage, backup: BackupPresent }, { ...recoveredDamage, editBackupVerified: false })
```

### A settled failure means the original's bytes are back

Before a restore, recovery durably marks the record `restoring`, checks
that the target URI and its bytes are still the ones just observed, writes
the original from the backup and reads its digest back. Only then, or when
the target already holds the full original, is `failed` committed. A step
that does not finish keeps the record `writing` and its restore mark, so a
later result read retries; a failed commit of the final receipt does too.

```quint
type RestoreSteps = { markCommitted: bool, targetRechecked: bool, originalReadBack: bool, receiptCommitted: bool }
pure def settledPhaseFor(restoring: bool, facts: RecoveryFacts, steps: RestoreSteps): ReplacePhase = {
  val plan = recoveryPlan(facts, restoring)
  val restored = plan == RestoreOriginal and steps.markCommitted and steps.targetRechecked and steps.originalReadBack
  if (steps.receiptCommitted and plan == RecoverSaved) Saved
  else if (steps.receiptCommitted and plan == RecoverOriginal) Failed({ restored: false })
  else if (steps.receiptCommitted and restored) Failed({ restored: true })
  else Interrupted({ restoring: restoring or (plan == RestoreOriginal and steps.markCommitted) })
}
pure def restoreMarked(p: ReplacePhase): bool = match p { | Interrupted(i) => i.restoring | _ => false }
pure def canSettleReplacement(s: ReplaceState, facts: RecoveryFacts, steps: RestoreSteps): bool = {
  val phase = s.phase
  match phase { | Interrupted(_) => true | _ => false }
}
pure def settleReplacement(s: ReplaceState, facts: RecoveryFacts, steps: RestoreSteps): ReplaceState =
  { ...s, phase: settledPhaseFor(restoreMarked(s.phase), facts, steps) }
pure def lawFailureNeedsOriginalBytes(restoring: bool, facts: RecoveryFacts, steps: RestoreSteps): bool =
  (settledPhaseFor(restoring, facts, steps) != Saved and settledPhase(settledPhaseFor(restoring, facts, steps))) implies
    (facts.target == FullOriginal or
      (recoveryPlan(facts, restoring) == RestoreOriginal and steps.markCommitted and steps.targetRechecked and steps.originalReadBack))
pure def stepRestoreMarkIsKeptUntilSettled(before: ReplaceState, after: ReplaceState): bool =
  (restoreMarked(before.phase) and not(settledPhase(after.phase))) implies restoreMarked(after.phase)
pure def sometimesDamageRestored(s: ReplaceState): bool = s.phase == Failed({ restored: true }) and s.liveWrites == 1
pure def sometimesRestoreAwaitsRetry(s: ReplaceState): bool = restoreMarked(s.phase)
pure val completeRestore: RestoreSteps = { markCommitted: true, targetRechecked: true, originalReadBack: true, receiptCommitted: true }
pure val stepsValues = Set(completeRestore, { ...completeRestore, markCommitted: false }, { ...completeRestore, targetRechecked: false },
  { ...completeRestore, originalReadBack: false }, { ...completeRestore, receiptCommitted: false })
```
