# Android photo replacement recovery

A consumer's Photos adapter offers a Replace control. Its photos plugin
inherits Eliza's `PhotosPlugin` and `OwnedPhotoEdits`.
[Photo copy](./photoCopy.md) owns new MediaStore rows.
[Photo permission epochs](./permissionEpochs.md) own library read tickets.
This contract owns replacement of the reviewed original and the
recovery of an interrupted truncating write.

## Story: Replace only the original I reviewed and preserve it across interrupted writes

> As the person, I want Replace to overwrite only the original I reviewed,
> and an interrupted write to leave me either the edit or the original,
> so that a crash never costs me the photo.

### Consent, source identity and two durable backups precede the live write

Replace applies to still JPEG, PNG or WebP. Owned photos can be
written directly. Another app's photo needs Android 11 or later,
with app-wide file access or a matching per-item write consent.
A saved operation is consulted before a new consent request. An
existing operation must be a Replace with the exact rotation, crop
and filter, and a crop must be one of the editor's crop identities. An unchanged edit returns `unchanged`; a changed source
returns `stale`. Both allow the original to remain untouched.

An admitted edit reserves an `incomplete` record. Read the original
and verify its SHA-256 and revision again. Decode upright sRGB up to
16 Mi pixels and encode the edit in the original format. JPEG retains
the selected EXIF fields and records normal orientation. Staging
does not grant write authority. Check the active editor and source
before creating files. Hold the original bytes and encoded edit in
private exclusive files. The parent and files reject symbolic-link
paths. Force each backup to disk. The `writing` record names both
files, target URI and both digests. Commit it before the truncating
write and recheck the same source revision, bytes and URI. A refused
consent or a stale or incomplete stage cannot authorize that write.
The model consumes observed consent, codec, journal and file-port
facts scoped to one operation.

```quint
type ReplaceAdmission = { supportedStill: bool, exactEditor: bool, validEdit: bool,
  existingOperation: bool, matchingReplace: bool, ownedPhoto: bool, androidWriteConsent: bool,
  allFiles: bool, exactConsent: bool, changedEdit: bool, exactSource: bool }
type ReplaceAdmissionResult = RefuseReplacement | ReadReplacement | ReplaceUnchanged | ReplaceStale | ReserveReplacement
pure def replacementAdmission(entry: ReplaceAdmission): ReplaceAdmissionResult =
  if (not(entry.validEdit)) RefuseReplacement
  else if (entry.existingOperation) (if (entry.matchingReplace) ReadReplacement else RefuseReplacement)
  else if (not(entry.supportedStill and entry.exactEditor)) RefuseReplacement
  else if (not(entry.changedEdit)) ReplaceUnchanged
  else if (not(entry.exactSource)) ReplaceStale
  else if (entry.ownedPhoto or (entry.androidWriteConsent and (entry.allFiles or entry.exactConsent))) ReserveReplacement
  else RefuseReplacement
pure def lawReplacementRetryDoesNotReserve(entry: ReplaceAdmission): bool =
  entry.existingOperation implies replacementAdmission(entry) != ReserveReplacement
type ReplacePreparation = { originalKept: bool, encodedKept: bool, writingCommitted: bool, exactTarget: bool, unchangedSource: bool }
pure def replacementMayOpen(preparation: ReplacePreparation): bool =
  preparation.originalKept and preparation.encodedKept and preparation.writingCommitted and preparation.exactTarget and preparation.unchangedSource
pure def lawReplacementWriteNeedsDurableOriginal(preparation: ReplacePreparation): bool =
  replacementMayOpen(preparation) implies preparation.originalKept and preparation.encodedKept and preparation.writingCommitted
pure val acceptedReplace: ReplaceAdmission = { supportedStill: true, exactEditor: true, validEdit: true,
  existingOperation: false, matchingReplace: false, ownedPhoto: true, androidWriteConsent: true,
  allFiles: false, exactConsent: false, changedEdit: true, exactSource: true }
pure val entryValues = Set(acceptedReplace, { ...acceptedReplace, ownedPhoto: false },
  { ...acceptedReplace, ownedPhoto: false, exactConsent: true }, { ...acceptedReplace, exactSource: false },
  { ...acceptedReplace, changedEdit: false }, { ...acceptedReplace, existingOperation: true, matchingReplace: true },
  { ...acceptedReplace, existingOperation: true, matchingReplace: false })
pure val preparedReplacement: ReplacePreparation = { originalKept: true, encodedKept: true, writingCommitted: true, exactTarget: true, unchangedSource: true }
pure val preparationValues = Set(preparedReplacement, { ...preparedReplacement, originalKept: false },
  { ...preparedReplacement, encodedKept: false }, { ...preparedReplacement, writingCommitted: false }, { ...preparedReplacement, unchangedSource: false })
```

### An edit operation's receipt stays bound to the crop it first reserved

A crop names one of the editor's crop identities; an area outside them is
refused and reserves nothing. The first valid save reserves the operation
with its crop and publishes once. Replaying the same crop returns the saved
receipt without publishing again. A different crop, including the centered
crop after a rectangle, cannot reuse the receipt, and the reserved crop
survives cancel and restart.

```quint
type CropReceipt = { reserved: bool, crop: int, published: int }
type CropSave = CropRefused | CropSaved
pure val cropIdentities = 4
pure def validCrop(crop: int): bool = crop >= 0 and crop < cropIdentities
pure def saveCrop(receipt: CropReceipt, crop: int): CropReceipt =
  if (not(validCrop(crop)) or receipt.reserved) receipt
  else { reserved: true, crop: crop, published: 1 }
pure def cropOutcome(receipt: CropReceipt, crop: int): CropSave =
  if (not(validCrop(crop)) or (receipt.reserved and receipt.crop != crop)) CropRefused else CropSaved
pure val receiptValues = Set({ reserved: false, crop: 0, published: 0 }, { reserved: true, crop: 2, published: 1 })
pure val cropValues = Set(-1, 0, 1, 2, 3, 4)
pure def lawCropReceiptPublishesOnce(receipt: CropReceipt, crop: int): bool =
  receipt.published <= 1 implies saveCrop(receipt, crop).published <= 1
pure def lawChangedCropCannotReuseReceipt(receipt: CropReceipt, crop: int): bool =
  receipt.reserved and crop != receipt.crop implies cropOutcome(receipt, crop) == CropRefused and saveCrop(receipt, crop) == receipt
pure def lawInvalidCropNeverReserves(receipt: CropReceipt, crop: int): bool =
  not(validCrop(crop)) implies saveCrop(receipt, crop) == receipt and cropOutcome(receipt, crop) == CropRefused
```

### Recovery recognizes complete versions and restores only damage it can attribute

A result for an exact `saved` record returns the stored item ID.
It includes a new revision only when the rescan observed it. An
exact `stale` record returns stale. A reserved operation that never
entered writing settles failed after committing that result.
A `writing` record needs the named regular original backup, the
original digest and readable bytes for the same target. A record
without a stored URI can still recognize the complete original or edit
by digest, but a restore write requires its exact stored URI.

The complete edit digest settles saved. The complete original
digest settles failed. Otherwise verify the original backup's
digest and require either the exact durable damage digest, or a
verified encoded backup and a strict prefix of that encoded edit.
A strict prefix can be empty. A prefix of the original is admitted
only for a recorded restore in progress, with that same verified
encoded backup. Newer or unrelated content, missing backup proof
and an unreadable target stay unknown and retain backup evidence.
Before restoring, durably mark restoring, recheck the target URI
and the same digest most recently observed, write the original, and
confirm its digest. A failed commit of the final receipt leaves the
writing record retryable. Backup removal after a settled recovery
is best effort and checks exact file digests. A successful direct
replacement can already return saved when its final receipt commit
fails. Backup evidence stays available for a later result read.

```quint
type PhotoBytes = FullEditedPhoto | FullOriginalPhoto | ExactRecordedDamage | PrefixOfEdit | PrefixOfOriginal | OtherPhotoBytes
type ReplaceRecovery = RetainUnknownBytes | RecoverSavedPhoto | RecoverOriginalPhoto | RestoreOwnedDamage
type RecoveryFacts = { originalBackupNamed: bool, originalDigestPresent: bool, readableBoundTarget: bool,
  exactRestoreUri: bool, originalBackupDigest: bool, encodedBackupDigest: bool, bytes: PhotoBytes }
pure def replacementRecovery(facts: RecoveryFacts, restoring: bool): ReplaceRecovery =
  if (not(facts.originalBackupNamed and facts.originalDigestPresent and facts.readableBoundTarget)) RetainUnknownBytes
  else if (facts.bytes == FullEditedPhoto) RecoverSavedPhoto
  else if (facts.bytes == FullOriginalPhoto) RecoverOriginalPhoto
  else if (facts.exactRestoreUri and facts.originalBackupDigest and
    (facts.bytes == ExactRecordedDamage or (facts.encodedBackupDigest and
      (facts.bytes == PrefixOfEdit or (facts.bytes == PrefixOfOriginal and restoring))))) RestoreOwnedDamage
  else RetainUnknownBytes
pure def lawOtherPhotoBytesCannotRestore(facts: RecoveryFacts, restoring: bool): bool =
  facts.bytes == OtherPhotoBytes implies replacementRecovery(facts,restoring) == RetainUnknownBytes
pure def lawOriginalPrefixNeedsDurableRestore(facts: RecoveryFacts): bool =
  facts.bytes == PrefixOfOriginal implies replacementRecovery(facts,false) != RestoreOwnedDamage
pure def lawRestoreMustTargetReviewedUri(facts: RecoveryFacts, restoring: bool): bool =
  replacementRecovery(facts,restoring) == RestoreOwnedDamage implies facts.exactRestoreUri and facts.originalBackupDigest
type ReplacementPhase = NoReplacement | ReplaceReserved | ReplaceWriting | ReplacementSaved | ReplacementFailed | ReplacementStale
type ReplaceState = { phase: ReplacementPhase, live: bool, restoring: bool, directSaved: bool, backups: bool, readbackOriginal: bool }
pure val initial: ReplaceState = { phase: NoReplacement, live: false, restoring: false, directSaved: false, backups: false, readbackOriginal: false }
pure def canReserveReplacement(s: ReplaceState, admitted: bool, reservationCommitted: bool): bool =
  s.phase == NoReplacement and admitted and reservationCommitted
pure def reserveReplacement(s: ReplaceState, admitted: bool, reservationCommitted: bool): ReplaceState =
  { ...s, phase: ReplaceReserved, live: true }
pure def canBeginReplacementWrite(s: ReplaceState, preparation: ReplacePreparation): bool =
  s.phase == ReplaceReserved and s.live and replacementMayOpen(preparation)
pure def beginReplacementWrite(s: ReplaceState, preparation: ReplacePreparation): ReplaceState =
  { ...s, phase: ReplaceWriting, backups: true }
pure def canAbortReservedReplacement(s: ReplaceState): bool = s.phase == ReplaceReserved
pure def abortReservedReplacement(s: ReplaceState, stale: bool, receiptCommitted: bool): ReplaceState =
  { ...s, live: false, phase: if (receiptCommitted) (if (stale) ReplacementStale else ReplacementFailed) else ReplaceReserved }
pure def canInterruptReplacement(s: ReplaceState): bool = s.phase == ReplaceWriting and s.live
pure def interruptReplacement(s: ReplaceState, directSaved: bool, receiptCommitted: bool): ReplaceState =
  { ...s, live: false, directSaved: directSaved,
    phase: if (directSaved and receiptCommitted) ReplacementSaved else ReplaceWriting,
    backups: not(directSaved and receiptCommitted) }
pure def canInspectReplacement(s: ReplaceState): bool = s.phase == ReplaceWriting and not(s.live)
type RestoreSettlement = { markerCommitted: bool, digestAndUriRechecked: bool, originalDigestRead: bool, receiptCommitted: bool }
pure def inspectReplacement(s: ReplaceState, facts: RecoveryFacts, settlement: RestoreSettlement): ReplaceState = {
  val plan = replacementRecovery(facts,s.restoring)
  val marked = plan == RestoreOwnedDamage and settlement.markerCommitted
  val confirmedOriginal = plan == RecoverOriginalPhoto or (marked and settlement.digestAndUriRechecked and settlement.originalDigestRead)
  if (settlement.receiptCommitted and plan == RecoverSavedPhoto)
    { ...s, phase: ReplacementSaved, backups: false, restoring: false }
  else if (settlement.receiptCommitted and confirmedOriginal)
    { ...s, phase: ReplacementFailed, backups: false, restoring: false, readbackOriginal: true }
  else { ...s, restoring: s.restoring or marked }
}
pure def alwaysWritingRetainsBackupEvidence(s: ReplaceState): bool =
  s.phase == ReplaceWriting implies s.backups
pure def alwaysRestoreMarkHasWritingRecord(s: ReplaceState): bool =
  s.restoring implies s.phase == ReplaceWriting and not(s.live)
pure def stepRecoveredFailureRequiresOriginalReadback(before: ReplaceState, via: str, after: ReplaceState): bool =
  via == "inspectReplacement" and after.phase == ReplacementFailed implies after.readbackOriginal
pure def stepUnknownReplacementKeepsBackups(before: ReplaceState, via: str, after: ReplaceState): bool =
  via == "inspectReplacement" and after.phase == ReplaceWriting implies after.backups == before.backups
pure def sometimesPhotoReplaceRestores(s: ReplaceState): bool = s.phase == ReplacementFailed and s.readbackOriginal
pure def sometimesReceiptNeedsPhotoReadback(s: ReplaceState): bool = s.phase == ReplaceWriting and s.directSaved
pure val baseRecovery: RecoveryFacts = { originalBackupNamed: true, originalDigestPresent: true, readableBoundTarget: true,
  exactRestoreUri: true, originalBackupDigest: true, encodedBackupDigest: true, bytes: PrefixOfEdit }
pure val factsValues = Set(baseRecovery, { ...baseRecovery, bytes: FullOriginalPhoto },
  { ...baseRecovery, bytes: FullEditedPhoto }, { ...baseRecovery, bytes: PrefixOfOriginal },
  { ...baseRecovery, bytes: ExactRecordedDamage }, { ...baseRecovery, bytes: OtherPhotoBytes },
  { ...baseRecovery, originalBackupDigest: false }, { ...baseRecovery, encodedBackupDigest: false },
  { ...baseRecovery, exactRestoreUri: false }, { ...baseRecovery, readableBoundTarget: false })
pure val completeRestore: RestoreSettlement = { markerCommitted: true, digestAndUriRechecked: true, originalDigestRead: true, receiptCommitted: true }
pure val settlementValues = Set(completeRestore, { ...completeRestore, markerCommitted: false },
  { ...completeRestore, digestAndUriRechecked: false }, { ...completeRestore, originalDigestRead: false },
  { ...completeRestore, receiptCommitted: false })
```
