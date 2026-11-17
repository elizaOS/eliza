# Notes draft retention

The notes client keeps the owner's unsaved edits in one encrypted draft
slot on the device, apart from the saved collection, so that a failed save
loses nothing. It also opens the notes collection an earlier version of
the client left on the device, the previous notes, without changing it.
The [Notes client](./client.md) owns canonical saves, [Trash](./trash.md)
owns removed notes and recordings, and the [secure store](../os/android/secureStore.md)
owns slot storage and compare-and-exchange.

## Story: Keep the unsaved text from my previous notes

> As the owner, I want an encrypted draft held on my device even when a
> save fails, and my saved notes to open with the contents I last saved.

### Opening previous notes preserves the saved collection and any earlier draft

Only the current owner's explicit selection opens previous notes, and only
an existing validated collection. A retired open publishes nothing. When
only the draft slot has a value, the view offers recovery guidance without
decoding that value or initializing a collection. If both slots and the
earlier sources are absent, the view reports there are no previous notes.
An unavailable collection, or earlier data that needs migration, requires
review. An unreadable draft beside a validated collection leaves the saved
list available but blocks edits. When the draft is readable, the view opens
the saved collection and keeps the draft for a later failed-save merge. The
open neither applies the draft nor writes or removes saved data.

```quint
type PreviousCollection = SavedPreviousNotes | NoPreviousNotes | PreviousNotesNeedReview
type PreviousDraftSlot = DraftAbsent | DraftReadable | DraftInvalid | DraftUnavailable
type PreviousOpen = OpenRetired | OpenAbsent | OpenReview | OpenDraftOnly | OpenSavedReadOnly | OpenSavedWithDraft | OpenSaved
pure def previousNotesOpen(ownerCurrent: bool, collection: PreviousCollection, draftSlot: PreviousDraftSlot): PreviousOpen =
  if (not(ownerCurrent)) OpenRetired
  else if (collection == PreviousNotesNeedReview) OpenReview
  else if (collection == NoPreviousNotes)
    (if (draftSlot == DraftAbsent) OpenAbsent else if (draftSlot == DraftUnavailable) OpenReview else OpenDraftOnly)
  else if (draftSlot == DraftInvalid or draftSlot == DraftUnavailable) OpenSavedReadOnly
  else if (draftSlot == DraftReadable) OpenSavedWithDraft
  else OpenSaved
pure def lawDraftAloneDoesNotOpenACollection(ownerCurrent: bool, draftSlot: PreviousDraftSlot): bool =
  ownerCurrent and (draftSlot == DraftReadable or draftSlot == DraftInvalid) implies
    previousNotesOpen(ownerCurrent, NoPreviousNotes, draftSlot) == OpenDraftOnly
pure def lawUnreadableDraftWithSavedNotesBlocksEditing(ownerCurrent: bool, draftSlot: PreviousDraftSlot): bool =
  ownerCurrent and (draftSlot == DraftInvalid or draftSlot == DraftUnavailable) implies
    previousNotesOpen(ownerCurrent, SavedPreviousNotes, draftSlot) == OpenSavedReadOnly
pure def lawRetiredReadDoesNotOpen(collection: PreviousCollection, draftSlot: PreviousDraftSlot): bool =
  previousNotesOpen(false, collection, draftSlot) == OpenRetired
```

### A failed save merges untouched changes and replaces only the editor's own prior attempt

A failed, uncertain or storage-full collection write can keep the attempted
changes in the encrypted slot. New changes take precedence for every note ID
they touch, removals included. Other IDs keep their previous authored
records and exact saved bytes. If the slot still exactly matches the
editor's last stored draft, the earlier session's kept draft is merged with
the editor's current changes instead, which lets the editor revert its own
attempted edit. An empty slot contributes no prior changes. If its value
cannot be read or validated, the write stops. After a compare-and-exchange
reply other than saved, the slot operation re-reads and merges again, for
at most three attempts. A read or write error stops the operation. Only a
saved reply confirms encrypted retention; if retention fails, the editor
keeps the unsaved text on screen.

```quint
type PriorDraftChoice = NoPriorDraft | EarlierSessionDraft | CurrentSlotDraft | DraftWriteBlocked
pure def priorDraftChoice(draftSlot: PreviousDraftSlot, matchesEditorDraft: bool): PriorDraftChoice =
  if (draftSlot == DraftAbsent) NoPriorDraft
  else if (draftSlot == DraftInvalid or draftSlot == DraftUnavailable) DraftWriteBlocked
  else if (matchesEditorDraft) EarlierSessionDraft else CurrentSlotDraft
type DraftChange = NoDraftChange | AddedDraftNote({ authored: str }) |
  EditedDraftNote({ beforeText: str, authored: str }) | RemovedDraftNote({ beforeText: str })
pure val keptChangeValues: Set[DraftChange] = Set(NoDraftChange, AddedDraftNote({ authored: "older" }),
  EditedDraftNote({ beforeText: "saved", authored: "older" }), RemovedDraftNote({ beforeText: "saved" }))
pure val newChangeValues: Set[DraftChange] = Set(NoDraftChange, AddedDraftNote({ authored: "latest" }),
  EditedDraftNote({ beforeText: "saved", authored: "latest" }), RemovedDraftNote({ beforeText: "saved" }))
pure def hasDraftChange(change: DraftChange): bool = match change { | NoDraftChange => false | _ => true }
pure def mergeDraftChange(keptChange: DraftChange, newChange: DraftChange): DraftChange =
  if (hasDraftChange(newChange)) newChange else keptChange
type DraftWriteReply = DraftSaved | DraftNotSaved | DraftVaultError
pure def retryDraftSave(attempts: int, reply: DraftWriteReply): bool =
  reply == DraftNotSaved and attempts >= 1 and attempts < 3
pure def lawReplacedOwnDraftUsesEarlierSessionCopy(draftSlot: PreviousDraftSlot): bool =
  draftSlot == DraftReadable implies priorDraftChoice(draftSlot, true) == EarlierSessionDraft
pure def lawUnreadableSlotCannotBeReplaced(draftSlot: PreviousDraftSlot, matchesEditorDraft: bool): bool =
  (draftSlot == DraftInvalid or draftSlot == DraftUnavailable) implies
    priorDraftChoice(draftSlot, matchesEditorDraft) == DraftWriteBlocked
pure def lawUntouchedDraftChangeSurvives(keptChange: DraftChange): bool =
  mergeDraftChange(keptChange, NoDraftChange) == keptChange
pure def lawLatestTouchedDraftChangeWins(keptChange: DraftChange, newChange: DraftChange): bool =
  hasDraftChange(newChange) implies mergeDraftChange(keptChange, newChange) == newChange
pure def lawDraftSaveStopsByThirdAttempt(attempts: int, reply: DraftWriteReply): bool =
  (attempts >= 3 or reply != DraftNotSaved) implies not(retryDraftSave(attempts, reply))
```

### A release build gives retention guidance, and a fixture reset requires the reviewed draft

A release build offers the retained-data notice; its recovery dialog does
not read raw bytes, download a backup or reset the draft. The test-mock
recovery dialog can read an exact raw snapshot and prepare a backup. The
owner confirms a fixture reset in the foreground. Clearing a draft then
requires a captured nonempty slot and a successful exact comparison against
its captured bytes. A failed or retired read supplies no reset authority.
The draft reset targets the draft slot alone; a collection reset, when
separately offered for a damaged collection, targets the collection slot.

```quint
type DraftRecoverySurface = RetentionNotice | FixtureRecovery
pure def draftRecoverySurface(testMocks: bool): DraftRecoverySurface =
  if (testMocks) FixtureRecovery else RetentionNotice
type DraftResetEvidence = { testMocks: bool, foreground: bool, confirmed: bool,
  captureCurrent: bool, capturedValue: bool, exactSlotValue: bool }
pure val reviewedFixture: DraftResetEvidence = { testMocks: true, foreground: true, confirmed: true,
  captureCurrent: true, capturedValue: true, exactSlotValue: true }
pure val evidenceValues = Set(reviewedFixture, { ...reviewedFixture, testMocks: false },
  { ...reviewedFixture, foreground: false }, { ...reviewedFixture, confirmed: false },
  { ...reviewedFixture, captureCurrent: false }, { ...reviewedFixture, capturedValue: false },
  { ...reviewedFixture, exactSlotValue: false })
pure def fixtureDraftReset(evidence: DraftResetEvidence): bool =
  draftRecoverySurface(evidence.testMocks) == FixtureRecovery and evidence.foreground and evidence.confirmed and
    evidence.captureCurrent and evidence.capturedValue and evidence.exactSlotValue
pure def lawReleaseCannotResetDraft(evidence: DraftResetEvidence): bool =
  not(evidence.testMocks) implies not(fixtureDraftReset(evidence))
pure def lawFixtureCannotClearChangedDraft(evidence: DraftResetEvidence): bool =
  not(evidence.exactSlotValue and evidence.captureCurrent) implies not(fixtureDraftReset(evidence))
```
