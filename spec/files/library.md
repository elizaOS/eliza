# Browser file library

Where there is no device storage, as in a browser, Files keeps the owner's
files in the browser's own library: rows with a folder, a name, the bytes
and a revision, each change committed in one transaction across every tab.
The [reviewed operations](./reviewedOperations.md) act on it by path as on
the device, and its Trash keeps the same journal.

## Story: Keep my browser files and change each only as I last saw it

> As the owner, I want files I keep in the browser to change only at the
> revision I selected, never to replace another file, and to come back from
> Trash where they were.

### A change commits only at the revision it expected, never takes a name in use, and never puts a folder inside itself

A rename, move or delete names the row and the revision it expects, and the
transaction that commits it reads the row again: a row that is gone or has
another revision is refused as changed. A name already used in the
destination folder is refused, and a folder never moves into itself or a
folder inside it. Every committed change gives the row a new revision.

```quint
type LibraryChange = { present: bool, revisionMatches: bool, nameTaken: bool, intoItself: bool, destinationIsFolder: bool }
type LibraryAnswer = LibraryApplied | LibraryStale | LibraryNameTaken | LibraryOutside | LibraryNoFolder
pure def libraryAnswer(c: LibraryChange): LibraryAnswer =
  if (not(c.present) or not(c.revisionMatches)) LibraryStale
  else if (not(c.destinationIsFolder)) LibraryNoFolder
  else if (c.intoItself) LibraryOutside
  else if (c.nameTaken) LibraryNameTaken
  else LibraryApplied
pure val cValues = Set({ present: true, revisionMatches: true, nameTaken: false, intoItself: false, destinationIsFolder: true },
  { present: true, revisionMatches: false, nameTaken: false, intoItself: false, destinationIsFolder: true },
  { present: false, revisionMatches: false, nameTaken: false, intoItself: false, destinationIsFolder: true },
  { present: true, revisionMatches: true, nameTaken: true, intoItself: false, destinationIsFolder: true },
  { present: true, revisionMatches: true, nameTaken: false, intoItself: true, destinationIsFolder: true },
  { present: true, revisionMatches: true, nameTaken: false, intoItself: false, destinationIsFolder: false })
pure def lawOnlyTheExpectedRevisionChanges(c: LibraryChange): bool =
  libraryAnswer(c) == LibraryApplied implies c.present and c.revisionMatches and not(c.nameTaken) and not(c.intoItself) and c.destinationIsFolder
```

### A batch of library changes commits every row or none

A batch move or delete reads every selected row in one transaction. When
any row is gone, has another revision, or would be refused on its own, the
whole batch is refused and nothing changes. A permanent delete needs the
owner's confirmation and leaves a folder that still holds anything.

```quint
type LibraryBatch = { rows: int, rowsApplicable: int, confirmed: bool, deleting: bool, folderHoldsRows: bool }
pure def batchCommits(b: LibraryBatch): bool =
  b.rows >= 1 and b.rowsApplicable == b.rows and (not(b.deleting) or (b.confirmed and not(b.folderHoldsRows)))
pure val bValues = Set({ rows: 2, rowsApplicable: 2, confirmed: false, deleting: false, folderHoldsRows: false },
  { rows: 2, rowsApplicable: 1, confirmed: false, deleting: false, folderHoldsRows: false },
  { rows: 1, rowsApplicable: 1, confirmed: false, deleting: true, folderHoldsRows: false },
  { rows: 1, rowsApplicable: 1, confirmed: true, deleting: true, folderHoldsRows: true },
  { rows: 0, rowsApplicable: 0, confirmed: true, deleting: true, folderHoldsRows: false })
pure def lawABatchIsWholeOrNothing(b: LibraryBatch): bool = batchCommits(b) implies b.rowsApplicable == b.rows and b.rows >= 1
pure def lawDeletingNeedsConfirmationAndAnEmptyFolder(b: LibraryBatch): bool =
  (batchCommits(b) and b.deleting) implies b.confirmed and not(b.folderHoldsRows)
```

### A selection reads its file only while the file still has the revision it selected

Selecting a file binds the selection to the row and its revision. Reading
its bytes or text, or making an attachment of it, checks the row again
before and after the read; a row changed or gone since is refused, and the
owner selects again. A mail attachment holds at most 5 MiB and a chat one
at most 20 MiB, and text is read only from a text file of at most 2 MB that
decodes as UTF-8 without a NUL. Renaming a selected file renames that row
only at the revision the selection holds, to a valid name no other row of
its folder uses in any case, and binds the selection to the renamed
revision, so the owner keeps reading the file they renamed.

```quint
type SelectionRead = { present: bool, revisionMatches: bool, bytes: int, limit: int }
pure def selectionReadable(s: SelectionRead): bool = s.present and s.revisionMatches and s.bytes >= 0 and s.bytes <= s.limit
pure val mailLimit = 5242880
pure val chatLimit = 20971520
pure val textLimit = 2000000
pure val sValues = Set({ present: true, revisionMatches: true, bytes: 10, limit: 5242880 }, { present: true, revisionMatches: false, bytes: 10, limit: 5242880 },
  { present: false, revisionMatches: true, bytes: 10, limit: 5242880 }, { present: true, revisionMatches: true, bytes: 5242881, limit: 5242880 })
pure def lawAChangedSelectionIsNeverRead(s: SelectionRead): bool = selectionReadable(s) implies s.present and s.revisionMatches
```

## Story: Let a workflow save and read my browser files without repeating or half-reading anything

> As the owner, I want a workflow step that saves a file to save it once
> even when the step runs again, a workflow that reads my files to read all
> of them as they are or none, and a folder I import to arrive whole.

### A workflow attachment and its receipt commit together, and a replay returns the receipt without saving again

A workflow step saves its reviewed attachment into Receipts under a name
free there, and the file and the step's receipt commit in one transaction.
When the step runs again with the same name, type and content, the receipt
answers it and nothing is saved; with anything else it is refused. Deleting
the saved file keeps the receipt, so a replay never recreates it. A file
named Receipts that is not a folder refuses the save.

```quint
type AttachmentReplay = { receiptKept: bool, fingerprintMatches: bool, receiptsIsFolder: bool }
type AttachmentAnswer = SavedNew | ReturnedReceipt | ReceiptMismatch | ReceiptsBlocked
pure def attachmentAnswer(r: AttachmentReplay): AttachmentAnswer =
  if (r.receiptKept) (if (r.fingerprintMatches) ReturnedReceipt else ReceiptMismatch)
  else if (not(r.receiptsIsFolder)) ReceiptsBlocked else SavedNew
pure val rValues = Set({ receiptKept: false, fingerprintMatches: false, receiptsIsFolder: true }, { receiptKept: true, fingerprintMatches: true, receiptsIsFolder: true },
  { receiptKept: true, fingerprintMatches: false, receiptsIsFolder: true }, { receiptKept: false, fingerprintMatches: false, receiptsIsFolder: false })
pure def lawAKeptReceiptIsNeverSavedAgain(r: AttachmentReplay): bool = r.receiptKept implies attachmentAnswer(r) != SavedNew
```

### A workflow reads its Files source whole and unchanged, or not at all

A workflow reads either up to 20 of the most recently changed visible
files, or all visible files if there are at most 2,000. A text file is read whole up to 16,000 bytes; a larger text
file refuses the whole read, never part of it. The files are read again
after the read, and a source that changed meanwhile is refused so the step
runs again.

```quint
type SourceRead = { recent: bool, files: int, textOverLimit: bool, changedDuringRead: bool }
pure val sourceFilesLimit = 2000
pure val recentFilesLimit = 20
pure val sourceTextLimit = 16000
pure def sourceAdmitted(read: SourceRead): bool =
  (read.recent or read.files <= sourceFilesLimit) and not(read.textOverLimit) and not(read.changedDuringRead)
pure val readValues = Set({ recent: false, files: 3, textOverLimit: false, changedDuringRead: false }, { recent: false, files: 2001, textOverLimit: false, changedDuringRead: false },
  { recent: true, files: 2001, textOverLimit: false, changedDuringRead: false }, { recent: true, files: 3, textOverLimit: true, changedDuringRead: false },
  { recent: false, files: 3, textOverLimit: false, changedDuringRead: true })
pure def lawAChangedOrPartialSourceIsNeverRead(read: SourceRead): bool = sourceAdmitted(read) implies not(read.textOverLimit) and not(read.changedDuringRead)
```

### An imported folder arrives whole under a name not yet used, or not at all

The renderer picks a folder and hands over every file under it with its
path inside the folder. The import adds the folder and everything in it in
one transaction, refused when the top-level name is in use, any name is not
a valid file name, or two entries name the same place.

```quint
type FolderImport = { nameTaken: bool, duplicateEntry: bool, namesValid: bool }
pure def folderImported(f: FolderImport): bool = not(f.nameTaken) and not(f.duplicateEntry) and f.namesValid
pure val fValues = Set({ nameTaken: false, duplicateEntry: false, namesValid: true }, { nameTaken: true, duplicateEntry: false, namesValid: true },
  { nameTaken: false, duplicateEntry: true, namesValid: true }, { nameTaken: false, duplicateEntry: false, namesValid: false })
pure def lawAnImportNeverMergesIntoAFolderInUse(f: FolderImport): bool = folderImported(f) implies not(f.nameTaken)
```
