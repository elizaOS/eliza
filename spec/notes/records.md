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

### The agent reads and changes Notes only for the owner, on the owner's own words in the bound request

Only the owner reaches the Notes actions, the saved-notes context and the
owner routes. A name fence, a named read and a re-resolved ID read the words
the owner typed in the request the host bound to this turn, never the text a
route wrapped around it; with no bound request, they read the message's own
text with its envelopes removed. A delete by name happens only when those
words name the note's title; otherwise the closest note is offered and
nothing is deleted. A delete by an ID those words do not carry, of a note
whose title they name, is a delete by that title: notes that share the
title ask the owner which one, and nothing is deleted. A delete by an ID
the owner's words carry, or of a note they do not name, deletes that note.
An edit by an ID is read the same way: an ID those words do not carry, for
a note whose title they name, is an edit by that title, so two notes that
share the title ask the owner which one and nothing is changed.

```quint
type OwnerWords = BoundRequestWords | MessageWords
pure def ownerWordsSource(requestBound: bool): OwnerWords = if (requestBound) BoundRequestWords else MessageWords
pure def notesAccessAllowed(isOwner: bool): bool = isOwner
pure def deleteByNameAllowed(isOwner: bool, wordsNameTitle: bool): bool = notesAccessAllowed(isOwner) and wordsNameTitle
pure def lawBoundRequestWins(requestBound: bool): bool = requestBound implies ownerWordsSource(requestBound) == BoundRequestWords
pure def lawOnlyTheOwnerReachesNotes(wordsNameTitle: bool): bool = not(deleteByNameAllowed(false, wordsNameTitle))
pure def lawUnnamedNoteIsNotDeleted(isOwner: bool): bool = not(deleteByNameAllowed(isOwner, false))
pure def idDeleteByTitle(idInOwnerWords: bool, wordsNameItsTitle: bool): bool = not(idInOwnerWords) and wordsNameItsTitle
pure def lawATypedIdDeletesThatNote(wordsNameItsTitle: bool): bool = not(idDeleteByTitle(true, wordsNameItsTitle))
pure def lawAPlannerIdForANamedTitleIsReresolved(idInOwnerWords: bool): bool = idDeleteByTitle(false, true) and not(idDeleteByTitle(idInOwnerWords, false))
pure def idEditByTitle(idInOwnerWords: bool, wordsNameItsTitle: bool): bool = not(idInOwnerWords) and wordsNameItsTitle
pure def lawATypedIdEditsThatNote(wordsNameItsTitle: bool): bool = not(idEditByTitle(true, wordsNameItsTitle))
pure def lawAPlannerIdForANamedTitleIsReresolvedForAnEdit(idInOwnerWords: bool): bool = idEditByTitle(false, true) and not(idEditByTitle(idInOwnerWords, false))
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

### A turn's Notes classification narrows what Notes may write and never grants a write

For the owner's turn the planner classifies what the current message asks
of Notes: a read, a requested change with its operations, or nothing
resolved. A write runs only when the turn bound to it classified a change;
a read-only or unresolved turn refuses every write with nothing started,
and reads are always allowed. Moving, editing in place and restoring are
edits of one existing note. A turn that names exactly one saved note's
title and asks only to read it is answered by reading that note's exact ID.

```quint
type NotesClassification = ReadOnlyTurn | MutationTurn | UnresolvedTurn
pure def notesWriteAllowed(classification: NotesClassification, isRead: bool): bool =
  isRead or classification == MutationTurn
pure def namedReadRoutes(classification: NotesClassification, onlyGet: bool, namedNotes: int): bool =
  classification == ReadOnlyTurn and onlyGet and namedNotes == 1
pure val namedNotesValues = Set(0, 1, 2)
pure def lawReadOnlyTurnRefusesWrites(classification: NotesClassification): bool =
  classification != MutationTurn implies not(notesWriteAllowed(classification, false))
pure def lawReadsAreNeverRefused(classification: NotesClassification): bool = notesWriteAllowed(classification, true)
pure def lawAmbiguousNameIsNotRouted(classification: NotesClassification, onlyGet: bool): bool =
  not(namedReadRoutes(classification, onlyGet, 2))
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
