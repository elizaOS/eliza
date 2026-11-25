# The agent's canonical Notes collection

The agent keeps the owner's Notes as one document in the agent's own
storage: the saved notes, their [Trash](./trash.md), and one collection
revision. The [Notes client](./client.md) reads and edits it through the
owner's routes; the agent's own Notes actions change it only as the owner
asked in the current turn.

## Story: Keep my notes as one collection the agent edits only as I asked

> As the owner, I want my notes kept as one collection that the agent
> changes only on my own words, under the account I am using now, and never
> over an edit it did not read.

### Every commit advances the revision once, and a replacement needs the revision it was read at

A committed change advances the collection revision by exactly one; a
read changes nothing. Replacing a note's fields, editing an authored entry,
appending, restoring and clearing need the revision of the complete read
they were prepared from, and any other change since, to any note, refuses
them with nothing written. A literal substitution needs no revision, but its
old text must match the current field exactly once.

```quint
pure def committedRevision(currentRevision: int, changed: bool): int = if (changed) currentRevision + 1 else currentRevision
pure def revisionAdmits(needsRevision: bool, supplied: bool, expected: int, currentRevision: int): bool =
  if (needsRevision) supplied and expected == currentRevision else (not(supplied) or expected == currentRevision)
pure def literalEditAdmitted(matches: int): bool = matches == 1
pure val currentRevisionValues = Set(0, 1, 2)
pure val expectedValues = Set(0, 1, 2)
pure val matchesValues = Set(0, 1, 2)
pure def lawStaleReplacementRefused(supplied: bool, expected: int, currentRevision: int): bool =
  expected != currentRevision implies not(revisionAdmits(true, supplied, expected, currentRevision))
pure def lawReplacementNeedsARevision(expected: int, currentRevision: int): bool = not(revisionAdmits(true, false, expected, currentRevision))
pure def lawAmbiguousLiteralEditRefused(matches: int): bool = matches != 1 implies not(literalEditAdmitted(matches))
pure def lawCommitAdvancesOnce(currentRevision: int): bool = committedRevision(currentRevision, true) == currentRevision + 1 and committedRevision(currentRevision, false) == currentRevision
```

### A creation the client names is made once, and every record is one bounded note

A note has an ID no other saved or trashed note has, a title of at most 240
units, a body of at most 20,001 units, one of four colors and authored
content that is not blank. A creation that carries the client's own creation
ID returns the note that ID made, even from Trash, and never adds a second;
the ID is retired when its note is erased. Without one, an agent creation
whose text and color match a plain saved note returns that note, and a
creation the owner's editor marked as new always adds one.

```quint
type CreationReplay = { creationKnown: bool, createdNoteKept: bool, forceNew: bool, plainMatch: bool }
pure def creationReturnsExisting(c: CreationReplay): bool =
  (c.creationKnown and c.createdNoteKept) or (not(c.creationKnown) and not(c.forceNew) and c.plainMatch)
pure def noteRecordAdmitted(titleUnits: int, bodyUnits: int, authored: bool, uniqueId: bool): bool =
  uniqueId and authored and titleUnits >= 0 and titleUnits <= 240 and bodyUnits >= 0 and bodyUnits <= 20001
pure val titleUnitsValues = Set(0, 240, 241)
pure val bodyUnitsValues = Set(0, 20001, 20002)
pure def lawKnownCreationIsNotRepeated(forceNew: bool, plainMatch: bool): bool =
  creationReturnsExisting({ creationKnown: true, createdNoteKept: true, forceNew: forceNew, plainMatch: plainMatch })
pure def lawEditorDraftAlwaysCreates(plainMatch: bool): bool =
  not(creationReturnsExisting({ creationKnown: false, createdNoteKept: false, forceNew: true, plainMatch: plainMatch }))
pure def lawBlankNoteRefused(titleUnits: int, bodyUnits: int, uniqueId: bool): bool =
  not(noteRecordAdmitted(titleUnits, bodyUnits, false, uniqueId))
```

### A note's title and body are saved as well-formed text

A note's title and body are made well-formed before they are saved, by every
creation and edit: a surrogate code unit that is not half of a high and low
pair is saved as U+FFFD, and every other unit is kept as written, so no length
changes. Content is made well-formed before its first line becomes the title.

```quint
pure def surrogateCodeUnit(codeUnit: int): bool = codeUnit >= 55296 and codeUnit <= 57343
pure def savedNoteCodeUnit(codeUnit: int, paired: bool): int = if (surrogateCodeUnit(codeUnit) and not(paired)) 65533 else codeUnit
pure val codeUnitValues = Set(65, 55295, 55296, 56319, 56320, 57343, 57344, 65533)
pure def lawLoneSurrogateSavedAsReplacement(codeUnit: int): bool = surrogateCodeUnit(codeUnit) implies savedNoteCodeUnit(codeUnit, false) == 65533
pure def lawPairedOrPlainUnitKept(codeUnit: int, paired: bool): bool = (paired or not(surrogateCodeUnit(codeUnit))) implies savedNoteCodeUnit(codeUnit, paired) == codeUnit
```

### A checklist the owner asks for is a new note holding the owner's items

A new checklist the owner asks Notes for is a creation, never an edit: one
new note whose label is the title the owner gave, holding the owner's items
as checklist entries in the order given, each unchecked. The Notes actions
tell the model so, that the model asks the owner what to call a checklist
they gave no title, and that adding items to a checklist already saved is an
edit of that note. A checklist creation is never answered by a saved note,
not even a checklist of the same title, unless it repeats the client's own
creation ID. A checklist holds 1 to 100 items, each at most 240 units, the
bound of a title, since an item is one line of the list. A checklist with a
blank title, with no item, with a blank item, with more items or a longer
item than that, or with a body or other authored content beside its label
and items is refused with nothing written. Text the owner supplied without
asking for a checklist is saved as written, never turned into one.

```quint
pure def creationForcesNew(editorDraft: bool, authoredContent: bool, clientCreationId: bool): bool =
  editorDraft or authoredContent or clientCreationId
pure def checklistCreationAdmitted(titled: bool, itemCount: int, blankItemCount: int, longestItemUnits: int, besideItems: bool): bool =
  titled and itemCount >= 1 and itemCount <= 100 and blankItemCount == 0 and longestItemUnits <= 240 and not(besideItems)
pure val itemCountValues = Set(0, 1, 2, 100, 101)
pure val blankItemCountValues = Set(0, 1, 2)
pure val longestItemUnitsValues = Set(1, 240, 241)
pure def lawAChecklistIsNeverAnsweredByASavedNote(editorDraft: bool, clientCreationId: bool, plainMatch: bool): bool =
  not(creationReturnsExisting({ creationKnown: false, createdNoteKept: false, forceNew: creationForcesNew(editorDraft, true, clientCreationId), plainMatch: plainMatch }))
pure def lawAChecklistNeedsItsTitle(itemCount: int, blankItemCount: int, longestItemUnits: int, besideItems: bool): bool =
  not(checklistCreationAdmitted(false, itemCount, blankItemCount, longestItemUnits, besideItems))
pure def lawAChecklistNeedsAnItem(titled: bool, blankItemCount: int, longestItemUnits: int, besideItems: bool): bool =
  not(checklistCreationAdmitted(titled, 0, blankItemCount, longestItemUnits, besideItems))
pure def lawABlankChecklistItemIsRefused(titled: bool, itemCount: int, blankItemCount: int, longestItemUnits: int, besideItems: bool): bool =
  blankItemCount != 0 implies not(checklistCreationAdmitted(titled, itemCount, blankItemCount, longestItemUnits, besideItems))
pure def lawAChecklistIsBounded(titled: bool, itemCount: int, blankItemCount: int, longestItemUnits: int, besideItems: bool): bool =
  (itemCount > 100 or longestItemUnits > 240) implies not(checklistCreationAdmitted(titled, itemCount, blankItemCount, longestItemUnits, besideItems))
pure def lawATitledChecklistWithinBoundsIsAdmitted(itemCount: int, longestItemUnits: int): bool =
  (itemCount >= 1 and itemCount <= 100 and longestItemUnits <= 240) implies checklistCreationAdmitted(true, itemCount, 0, longestItemUnits, false)
pure def lawNothingBesideTheChecklistItems(titled: bool, itemCount: int, blankItemCount: int, longestItemUnits: int): bool =
  not(checklistCreationAdmitted(titled, itemCount, blankItemCount, longestItemUnits, true))
```

### The agent reads and changes Notes only for the owner, and changes the note the model picked

Only the owner reaches the Notes actions, the saved-notes context and the
owner routes. The actions are offered on every owner turn, in the general
context as well as the Notes one, so a request about a note needs no
earlier Notes turn. When no saved note has the title the owner asked for,
the saved-notes context tells the agent to ask which note to use before
citing another one. The named-notes context reads the words the owner typed
in the request the host bound to this turn, never the text a route wrapped
around it; with no bound request, it reads the message's own text with its
envelopes removed. The model picks the note to edit or delete from the
saved-notes index, whatever words the owner used for it, and an exact ID
edits or deletes that note when no other distinct note has its title, case
and spacing aside. When another one does, the model's pick is a guess: the
agent answers with every note of that title for the owner to choose from
and changes nothing, unless a Notes read or an answer like it, in an
earlier message of this conversation and in the last ten minutes, returned
that ID among the notes of its title, so the model could ask and the owner
has chosen since. A read again of the same notes keeps the message that
first returned them. That choice serves the one message that changes a
note by it, and no message after. A change the owner makes in the Notes app by a note's ID is the
owner's own pick and is never asked about. A delete the agent asks for by content deletes
only the note whose exact title, case and spacing aside, that content
gives; a match on other text offers the closest note for the owner to
confirm and deletes nothing. Content that matches distinct notes asks the
owner which one, and nothing is changed.

```quint
type OwnerWords = BoundRequestWords | MessageWords
pure def ownerWordsSource(requestBound: bool): OwnerWords = if (requestBound) BoundRequestWords else MessageWords
pure def notesAccessAllowed(isOwner: bool): bool = isOwner
type NotesTurnContext = GeneralContext | NotesContext | AnotherContext
pure def notesOffered(isOwner: bool, context: NotesTurnContext): bool = notesAccessAllowed(isOwner) and context != AnotherContext
pure def lawNotesNeedNoEarlierNotesTurn(isOwner: bool): bool = notesOffered(isOwner, GeneralContext) == notesOffered(isOwner, NotesContext)
pure def deleteByContentAllowed(isOwner: bool, givesExactTitle: bool): bool = notesAccessAllowed(isOwner) and givesExactTitle
pure def lawBoundRequestWins(requestBound: bool): bool = requestBound implies ownerWordsSource(requestBound) == BoundRequestWords
pure def lawOnlyTheOwnerReachesNotes(givesExactTitle: bool): bool = not(deleteByContentAllowed(false, givesExactTitle))
pure def lawAnInexactMatchIsNotDeleted(isOwner: bool): bool = not(deleteByContentAllowed(isOwner, false))
pure def pickedNoteChanged(isOwner: bool, titleShared: bool, ownerChoseEarlier: bool): bool =
  notesAccessAllowed(isOwner) and (not(titleShared) or ownerChoseEarlier)
pure def lawAGuessBetweenSharedTitlesAsksFirst(isOwner: bool): bool = not(pickedNoteChanged(isOwner, true, false))
pure def lawTheOwnersChoiceIsChanged(titleShared: bool): bool = pickedNoteChanged(true, titleShared, true)
pure def lawAnUnsharedTitleNeedsNoChoice(ownerChoseEarlier: bool): bool = pickedNoteChanged(true, false, ownerChoseEarlier)
```

### A read by a title no saved note has reads nothing and offers the one note whose title holds it

When the owner names the note to read by its title, the agent reads by that
title: the saved notes whose title it is, case and spacing aside. One such
note is read. Several are offered for the owner to choose, and none is read.
When no saved note has the title, no note is read and no other note is
cited in its place. When exactly one saved note's title holds the words
asked for as a phrase, case and spacing aside, as "Taco Night Plan" holds
"Taco Night", the answer names that note with its ID and leaves the choice
to the model: it reads that note by its ID and goes on with the request,
opening it if that was asked, when it is plainly the note the owner meant,
and asks which note only when it may not be. The owner is not asked to
confirm one clear near title. Otherwise, with no such note or several, the
agent answers that no note has that title, with the titles of the notes
whose text mentions it, and waits on the owner to say which note to use. A
read by text the note contains, rather than by its title, searches every
note's text.

```quint
type TitledRead = ReadsTitledNote | AsksAmongTitledNotes | OffersNearTitle | AsksWhichNote
pure def titledRead(titledNotes: int, nearTitles: int): TitledRead =
  if (titledNotes == 1) ReadsTitledNote
  else if (titledNotes > 1) AsksAmongTitledNotes
  else if (nearTitles == 1) OffersNearTitle
  else AsksWhichNote
pure val titledNotesValues = Set(0, 1, 2, 3)
pure val nearTitlesValues = Set(0, 1, 2)
pure def lawOnlyTheOneTitledNoteIsRead(titledNotes: int, nearTitles: int): bool = (titledRead(titledNotes, nearTitles) == ReadsTitledNote) iff (titledNotes == 1)
pure def lawOnlyOneNearTitleIsOffered(titledNotes: int, nearTitles: int): bool =
  (titledRead(titledNotes, nearTitles) == OffersNearTitle) iff (titledNotes <= 0 and nearTitles == 1)
pure def lawAnAbsentTitleWithoutOneNearTitleAsksWhichNote(titledNotes: int, nearTitles: int): bool =
  (titledNotes <= 0 and nearTitles != 1) implies titledRead(titledNotes, nearTitles) == AsksWhichNote
```

### A move by name takes the identical copies of the note along

Plain saved notes with the same title, body and color are one note to a
lookup, as when the owner's editor saved the same text twice. A move that
names the note by its words puts every such copy in the folder, so no copy
stays behind outside it; a move by ID changes only that note.

```quint
pure def moveTakesCopy(byName: bool, resolvedNote: bool, identicalCopy: bool): bool =
  resolvedNote or (byName and identicalCopy)
pure def lawResolvedNoteMoves(byName: bool, identicalCopy: bool): bool = moveTakesCopy(byName, true, identicalCopy)
pure def lawMoveByIdLeavesOtherNotes(identicalCopy: bool): bool = not(moveTakesCopy(false, false, identicalCopy))
pure def lawMoveByNameLeavesNoCopyBehind(resolvedNote: bool): bool = moveTakesCopy(true, resolvedNote, true)
pure def lawDifferentNoteStays(byName: bool): bool = not(moveTakesCopy(byName, false, false))
```

### A delete or an edit by name leaves no identical copy behind

A delete that names the note by its words moves every identical copy to
Recently deleted with it, so none survives the deletion the owner just
confirmed. An edit that names the note changes that note and drops its
identical copies, and any plain note the edit made it identical to, so one
note holds the result. A delete or an edit by ID changes only that note,
and a note that differs is never touched.

```quint
type NoteChange = DeletesNote | EditsNote
type CopyFate = CopyStays | CopyTrashed | CopyDropped
pure def copyFate(change: NoteChange, byName: bool, identicalBefore: bool, identicalAfter: bool): CopyFate =
  if (not(byName)) CopyStays
  else if (change == DeletesNote) (if (identicalBefore) CopyTrashed else CopyStays)
  else if (identicalBefore or identicalAfter) CopyDropped
  else CopyStays
pure def lawAChangeByIdLeavesEveryOtherNote(change: NoteChange, identicalBefore: bool, identicalAfter: bool): bool =
  copyFate(change, false, identicalBefore, identicalAfter) == CopyStays
pure def lawADeleteByNameTrashesEveryCopy(identicalAfter: bool): bool = copyFate(DeletesNote, true, true, identicalAfter) == CopyTrashed
pure def lawADeleteNeverDropsANote(byName: bool, identicalBefore: bool, identicalAfter: bool): bool =
  copyFate(DeletesNote, byName, identicalBefore, identicalAfter) != CopyDropped
pure def lawAnEditByNameKeepsOneNote(identicalAfter: bool): bool = copyFate(EditsNote, true, true, identicalAfter) == CopyDropped
pure def lawANoteThatDiffersIsNeverTouched(change: NoteChange, byName: bool): bool = copyFate(change, byName, false, false) == CopyStays
```

### A Notes change answers with a receipt of the note and the revision it committed, and a refusal says what it waits on

A create, edit, move, delete or restore asked in chat answers with one
durable receipt of kind notes.note for the note's ID at the collection
revision the change produced, named notes.note.create, notes.note.update,
notes.note.delete or notes.note.restore, with the same operation and note
ID in its data; a move is an update. The phone follows the change to that
revision. A creation that returned the note already saved is a replayed
no-op, never a second commit, and a read carries no receipt. A refusal
that needs the owner's choice between notes, or the owner's word that the
closest note is the one meant, says it waits on the owner and carries the
candidates. A refused edit the planner can correct from a fresh read (a
stale or missing revision, old text that is absent or matches twice, a
rich note edited as plain text) is coaching for the planner, not an
outcome the owner is told. Every other refusal is an outcome. A list of
the whole collection that finds no note says the collection is empty at
that revision.

```quint
type NotesWrite = WriteCreate | WriteEdit | WriteMove | WriteDelete | WriteRestore
type ReceiptOutcome = AppliedReceipt | ReplayedReceipt
pure def receiptOperation(write: NotesWrite): str =
  if (write == WriteCreate) "notes.note.create"
  else if (write == WriteDelete) "notes.note.delete"
  else if (write == WriteRestore) "notes.note.restore"
  else "notes.note.update"
pure def receiptOutcome(write: NotesWrite, replayed: bool): ReceiptOutcome =
  if (write == WriteCreate and replayed) ReplayedReceipt else AppliedReceipt
type NotesRefusal = AmbiguousNote | NameMismatch | EditConflict | RevisionRequired | TextNotFound | TextAmbiguous | RichEditRequired | OtherRefusal
type RefusalKind = RefusalWaitsOnOwner | RefusalCoachesPlanner | RefusalIsOutcome
pure def refusalKind(refusal: NotesRefusal): RefusalKind =
  if (refusal == AmbiguousNote or refusal == NameMismatch) RefusalWaitsOnOwner
  else if (refusal == OtherRefusal) RefusalIsOutcome
  else RefusalCoachesPlanner
pure def emptyCollectionObserved(filtered: bool, found: int): bool = not(filtered) and found == 0
pure val foundValues = Set(0, 1, 2)
pure def lawOnlyARepeatedCreationIsANoOp(write: NotesWrite, replayed: bool): bool =
  receiptOutcome(write, replayed) == ReplayedReceipt iff (write == WriteCreate and replayed)
pure def lawAMoveIsAnUpdate(replayed: bool): bool =
  receiptOperation(WriteMove) == receiptOperation(WriteEdit) and receiptOutcome(WriteMove, replayed) == AppliedReceipt
pure def lawAChoiceBetweenNotesIsNeverCoaching(refusal: NotesRefusal): bool =
  refusalKind(refusal) == RefusalWaitsOnOwner iff (refusal == AmbiguousNote or refusal == NameMismatch)
pure def lawAFilteredReadNeverSaysTheCollectionIsEmpty(found: int): bool = not(emptyCollectionObserved(true, found))
```

### A read tells a note's times in the owner's zone when the turn knows it

A read gives each note's created and updated times as instants. When the
turn carries the owner's zone, the one the phone observed or else the one
its interface reported, and the host knows that zone, each note read also
carries the two times as that zone's local date and time, so "my latest
note" is named on the owner's day, not on UTC's. With no known zone the
instants stand alone and no local date is guessed.

```quint
type DisplayZone = ObservedZone | InterfaceZone | NoOwnerZone
pure def displayZoneSource(observedKnown: bool, interfaceKnown: bool): DisplayZone =
  if (observedKnown) ObservedZone else if (interfaceKnown) InterfaceZone else NoOwnerZone
pure def localTimesShown(source: DisplayZone): bool = source != NoOwnerZone
pure def lawTheObservedZoneWins(interfaceKnown: bool): bool = displayZoneSource(true, interfaceKnown) == ObservedZone
pure def lawNoLocalDateIsGuessed(observedKnown: bool, interfaceKnown: bool): bool =
  localTimesShown(displayZoneSource(observedKnown, interfaceKnown)) iff (observedKnown or interfaceKnown)
```

### A calendar draft made from a note is admitted only while that exact note is unchanged

A draft made from a note carries a source reference: this agent's ID, the
note's ID and a hash of the agent ID, note ID, title and body as they were.
Before the draft is dispatched, the agent waits for pending Notes writes and
reads the collection again. The draft is admitted only when the collection
can be read, the note is still saved, the agent is the one that made the
reference and the hash is unchanged; anything else is a conflict the owner
reconciles, and nothing is dispatched.

```quint
pure def sourceStillExact(readable: bool, noteSaved: bool, sameAgent: bool, sameHash: bool): bool =
  readable and noteSaved and sameAgent and sameHash
pure def lawChangedSourceRefused(readable: bool, noteSaved: bool, sameAgent: bool): bool =
  not(sourceStillExact(readable, noteSaved, sameAgent, false))
pure def lawUnreadableSourceRefused(noteSaved: bool, sameAgent: bool, sameHash: bool): bool =
  not(sourceStillExact(false, noteSaved, sameAgent, sameHash))
```

### A Notes write runs when the model calls a write action, and a read action never writes

What the owner's message asks of Notes is the model's to read: it calls a
read action (list, get) or a write action (create, patch, update, move,
delete, restore), and that call is the request. Nothing classifies the
message before the model, so no fixed reading of the words refuses a write
the owner asked for. The guards stay on what a write may touch: the owner
alone reaches Notes, a delete or edit by name follows the owner's own
words (above), a replacement needs the revision it was read at, and a
delete moves the note to Trash. Each action is tagged by what it does, so
the planner and the turn see a read action as a read and a write action
as a write.

```quint
type NotesCall = ReadCall | WriteCall
type NotesCapability = ReadCapability | WriteCapability
pure def notesCapability(call: NotesCall): NotesCapability = if (call == WriteCall) WriteCapability else ReadCapability
pure def lawOnlyAWriteActionIsTaggedForWriting(call: NotesCall): bool = (notesCapability(call) == WriteCapability) iff (call == WriteCall)
```

## Story: Keep the notes I saved before this version

> As the owner, I want the notes, Trash and pending recording cleanup I
> saved with the earlier Notes store to be here after the update, once,
> exactly, and never to overwrite what I saved since.

### The earlier document is imported once, exactly, and never over the collection

When the collection has never been saved, the agent reads the earlier
Notes document of this agent from its state directory: schema 1, 2 or 3,
validated as the earlier store did, with schema 1 bodies given their
framing newline. A valid document becomes the collection with the same
notes, Trash, creation IDs and pending recording cleanup, a revision one
past its own, and an import receipt naming its schema, revision, SHA-256
and counts. No earlier document means an empty collection. An earlier
document that cannot be read or validated makes Notes unavailable for
review and never starts an empty collection. Once the collection has been
saved, with a receipt or by any change, the earlier document is never read
again, and it is never changed or removed. An import whose commit is
unknown is not reported; the next read either finds its receipt or imports
again from the same document.

```quint
type PriorDocument = PriorAbsent | PriorValid | PriorInvalid | PriorUnreadable
type CollectionHolds = NothingSaved | SavedCollection
type ImportStep = StartEmpty | ImportPrior | KeepCollection | ImportNeedsReview
pure def importStep(holds: CollectionHolds, prior: PriorDocument): ImportStep =
  if (holds == SavedCollection) KeepCollection
  else if (prior == PriorAbsent) StartEmpty
  else if (prior == PriorValid) ImportPrior
  else ImportNeedsReview
pure def importedRevision(priorRevision: int): int = priorRevision + 1
pure def importSettled(commitSaved: bool, receiptReadBack: bool): bool = commitSaved or receiptReadBack
pure val priorRevisionValues = Set(0, 7)
pure def lawImportNeverOverwritesTheCollection(prior: PriorDocument): bool = importStep(SavedCollection, prior) == KeepCollection
pure def lawBrokenPriorNeverStartsEmpty(holds: CollectionHolds): bool =
  importStep(holds, PriorInvalid) != StartEmpty and importStep(holds, PriorUnreadable) != StartEmpty
pure def lawImportedRevisionAdvances(priorRevision: int): bool = importedRevision(priorRevision) > priorRevision
pure def lawUnknownImportIsNotSettled(receiptReadBack: bool): bool = importSettled(false, receiptReadBack) == receiptReadBack
```
