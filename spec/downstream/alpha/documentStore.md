# Alpha browser document receipts

Alpha's `apps/app/src/browser/documents.ts` creates the pinned Eliza
`BrowserDocumentStore` in `alpha.browser.documents.v1`.
`json-domain-document.ts` binds named browser state, including the
[assistant draft store](./durableDraft.md), and
`runtime/browser-notes-document.ts` binds Notes. IndexedDB is the writable
authority; localStorage can supply legacy input but cannot become a
parallel writable mirror. [The browser tab contract](./browser.md) owns
live page identity; a document receipt here describes stored bytes.

## Story: Edit the exact current browser record without losing another tab's work

### Browser edits require an exact receipt and one current owner

#### Initialization and raw exchange distinguish absence from an explicit reset

A store is scoped by its nonempty database namespace and record key.
A missing row returns `undefined`; an existing snapshot has nonempty
revision and either exact raw string bytes or a retained null tombstone.
`readOrCreate` preserves either an existing value or a tombstone. Its
IndexedDB transaction admits a single creator, even where Web Locks are
unavailable. A competing raw `compareExchange` write compares both
captured revision and raw content; comparing revision alone or just the
same text would permit erroneous writes. Every accepted exchange advances
the revision, including reset to null, repeated text and repeated reset.
Corrupt JSON is still recoverable as raw content and is not treated as
absent. Proof identities below are symbolic; the adapter uses fresh UUID
receipts and compares the exact bytes and namespace.

#### Transaction completion wins against later cancellation

A precommit abort cancels the transaction and returns failure. A
committed transaction returns its result even if aborted later. Aborted,
blocked or failed IndexedDB open is a typed failure; the host closes a
database that opens after its caller cancels. A read-only request cannot
publish a write. Tests against an actual browser backend must exercise
oncomplete versus onabort ordering.

#### An asynchronous editor runs once for each admitted edit

`edit` requires exclusive Web Locks for the exact database and key,
reads a snapshot and runs the editor once. Cancellation releases the
lock promptly even when the editor is still awaiting work. Its late
result cannot publish. The editor is side-effect free and returns both
next raw content and a result delivered only after the raw write
commits. Raw exchange can race a read and cannot be bypassed even when
an editor owns the Web Lock. Process failure or conflict never silently
replays user transformation logic.

This model runs one symbolic namespace and key and tracks one active
editor plus a raw competitor; per-key actor routing and actual Web Lock
admission implement the composition. An operation ticket models the
captured editor task so a late result after revoke cannot be accepted
by a replacement editor.

```quint
type DocumentRaw = { tombstone: bool, bytes: str }
pure val nullDocument: DocumentRaw = { tombstone: true, bytes: "" }
type DocumentReceipt = { present: bool, rev: int, rawValue: DocumentRaw }
type DocumentResult = Idle | Committed | Aborted | Conflict
type Document = { current: DocumentReceipt, captured: DocumentReceipt, active: bool, serial: int, ticket: int, result: DocumentResult }
pure val absent: DocumentReceipt = { present: false, rev: 0, rawValue: nullDocument }
pure val initial: Document = { current: absent, captured: absent, active: false, serial: 0, ticket: 0, result: Idle }
pure def exactReceipt(actual: DocumentReceipt, expected: DocumentReceipt): bool =
  actual.present == expected.present and actual.rev == expected.rev and actual.rawValue == expected.rawValue
pure def replaceRaw(s: Document, rawValue: DocumentRaw): DocumentReceipt =
  { present: true, rev: s.current.rev + 1, rawValue: rawValue }
pure def canInitializeDocument(s: Document, rawValue: DocumentRaw): bool = not(s.current.present) and not(s.active)
pure def initializeDocument(s: Document, rawValue: DocumentRaw): Document =
  { ...s, current: replaceRaw(s, rawValue), result: Committed }
pure def canExchangeDocument(s: Document, expected: DocumentReceipt, rawValue: DocumentRaw): bool =
  exactReceipt(s.current, expected)
pure def exchangeDocument(s: Document, expected: DocumentReceipt, rawValue: DocumentRaw): Document =
  { ...s, current: replaceRaw(s, rawValue), result: Committed }
pure def canCompeteWithEditor(s: Document, rawValue: DocumentRaw): bool = s.active
pure def competeWithEditor(s: Document, rawValue: DocumentRaw): Document =
  exchangeDocument(s, s.current, rawValue)
pure def canStartEdit(s: Document, locks: bool): bool = locks and not(s.active)
pure def startEdit(s: Document, locks: bool): Document =
  { ...s, captured: s.current, active: true, serial: s.serial + 1, ticket: s.serial + 1, result: Idle }
pure def canFinishEdit(s: Document, editId: int, rawValue: DocumentRaw): bool = s.active and editId == s.ticket
pure def finishEdit(s: Document, editId: int, rawValue: DocumentRaw): Document =
  if (exactReceipt(s.current, s.captured))
    { ...s, active: false, current: replaceRaw(s, rawValue), result: Committed }
  else { ...s, active: false, result: Conflict }
pure def canCancelEdit(s: Document, editId: int): bool = s.active and editId == s.ticket
pure def cancelEdit(s: Document, editId: int): Document = { ...s, active: false, result: Aborted }
pure def alwaysActiveEditorHasFreshTicket(s: Document): bool = s.active implies s.ticket == s.serial and s.ticket > 0
pure def alwaysStoredRecordHasPositiveRevision(s: Document): bool = s.current.present implies s.current.rev > 0
pure def alwaysAbsentHasInitialReceipt(s: Document): bool = not(s.current.present) implies s.current == absent
pure def alwaysSerialNonnegative(s: Document): bool = s.serial >= 0
pure def stepCancellationKeepsRecord(before: Document, via: str, after: Document): bool =
  via == "cancelEdit" implies after.current == before.current and not(after.active)
pure def stepDriftedEditorDoesNotPublish(before: Document, via: str, after: Document): bool =
  via == "finishEdit" and not(exactReceipt(before.captured, before.current)) implies after.current == before.current and after.result == Conflict
pure def lawTombstoneCannotReinitialize(s: Document, rawValue: DocumentRaw): bool =
  s.current.present and s.current.rawValue == nullDocument implies not(canInitializeDocument(s, rawValue))
pure def lawWrongTicketCannotFinish(s: Document, editId: int, rawValue: DocumentRaw): bool =
  editId != s.ticket or not(s.active) implies not(canFinishEdit(s, editId, rawValue))
pure def lawChangedRawCannotExchange(s: Document, expected: DocumentReceipt, rawValue: DocumentRaw): bool =
  expected.rawValue != s.current.rawValue implies not(canExchangeDocument(s, expected, rawValue))
pure def sometimesPersistedReset(s: Document): bool = s.current.present and s.current.rawValue == nullDocument and s.current.rev > 1
pure def sometimesEditorCancelled(s: Document): bool = s.result == Aborted
pure def sometimesEditorConflicted(s: Document): bool = s.result == Conflict
pure val rawValueValues: Set[DocumentRaw] = Set(nullDocument, { tombstone: false, bytes: "authored" }, { tombstone: false, bytes: "competitor" })
pure val expectedValues = Set(absent, { present: true, rev: 1, rawValue: nullDocument }, { present: true, rev: 1, rawValue: { tombstone: false, bytes: "authored" } })
pure val editIdValues = Set(1, 2, 3, 4)
pure val weight_startEdit = 5
pure val weight_finishEdit = 5
pure val weight_competeWithEditor = 5
```

#### Alpha Notes import and recovery preserve the exact legacy archive

The browser Notes key is `alpha.browser.notes.v1`. First import archives
the prior v1 Notes, v2 Notes, and Daily raw values and stores a separate
current collection in a version-1 envelope. Changes to the archived Notes
legacy bytes require recovery. A change to the Daily envelope that leaves
its exact parsed Notes array unchanged is acceptable; unparseable rival
Daily bytes are refused. Initialization requires Web Locks and a checked
absence; a competing initializer yields an explicit conflict.
Recovery captures exact current and legacy bytes, including malformed
bytes, before a distinct reset review. Reset runs under the audio
deletion lock and compare-exchanges the captured snapshot; it creates a
new empty collection with the captured archive and never reimports it.
These host archive/array equality and codec rules require platform
fixtures in addition to the receipt proofs above.
