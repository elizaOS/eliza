# Alpha durable composer draft and send custody

Alpha's `assistant-draft-controller.ts` reexports the Eliza
`DurableDraftController`; `runtime/assistant-draft-store.ts` binds the
pinned `packages/ui/src/state/durable-draft.ts` storage ports. The installed
store is a secure Android raw slot, or a browser transaction under
`alpha.browser.`. Both retain the name `assistant-draft:v1:` followed by
the SHA-256 of the UTF-8 binding. Alpha refuses an empty binding or one
over 4,096 UTF-16 units. The binding carries owner, agent and conversation.
Existing Alpha Quint references are `ComposerSend`, `DraftDispatch` and
`FirstSendDraftMigration`. [The conversation contract](../conversation.md)
owns actual message dispatch, target identity and history reconciliation.

## Story: Restore my authored text without automatically offering an uncertain send again

### Only exact durable data may authorize a transition

The row is exactly version 1, with binding, nonempty revision, text, and an
optional literal `sending: true`. It has no source handles, approval,
or receipt; restoring text does not restore admission. A malformed row,
wrong binding, invalid byte limit or failed read cannot produce a usable
draft or reset authority. The 64,000 limit counts UTF-8 text bytes by
default; rejection retains the authored text. Exact record expectation
checks revision and content before replacement. On Android the backend
compares the exact bytes read instead of reserializing them. An unchanged
text and mark keep the row revision. For a changed row or confirmed reset,
allocate a fresh revision. Reset requires the same store and exact current
raw capture, and cannot repair a row while silently discarding its bytes.
The browser substrate specifies its own [document receipt](./documentStore.md).

```quint
type DraftRow = { version: int, owner: int, revision: int, text: str, marked: bool }
pure val rowValues = Set(
  { version: 1, owner: 1, revision: 1, text: "older", marked: false },
  { version: 1, owner: 2, revision: 2, text: "newer", marked: true },
  { version: 0, owner: 1, revision: 0, text: "", marked: false }
)
pure def validDraft(row: DraftRow, ownerId: int, shapeExact: bool, utf8Size: int): bool =
  shapeExact and ownerId > 0 and row.owner == ownerId and row.version == 1 and row.revision > 0 and utf8Size >= 0 and utf8Size <= 64000
pure def mayDraftReset(capturedOwner: int, ownerId: int, reviewed: bool, capturedRaw: str, currentRaw: str): bool =
  capturedOwner > 0 and capturedOwner == ownerId and reviewed and capturedRaw == currentRaw
pure def lawOversizeDoesNotValidate(row: DraftRow, ownerId: int, shapeExact: bool, utf8Size: int): bool =
  utf8Size > 64000 implies not(validDraft(row, ownerId, shapeExact, utf8Size))
pure def lawForeignDraftDoesNotValidate(row: DraftRow, ownerId: int, shapeExact: bool, utf8Size: int): bool =
  row.owner != ownerId implies not(validDraft(row, ownerId, shapeExact, utf8Size))
pure def lawChangedRawCaptureCannotReset(capturedOwner: int, ownerId: int, reviewed: bool, capturedRaw: str, currentRaw: str): bool =
  capturedRaw != currentRaw implies not(mayDraftReset(capturedOwner, ownerId, reviewed, capturedRaw, currentRaw))
```

### The durable sending mark separates review, dispatch, and settlement

This reducer tracks one installed binding and the current editor's membership
of it. The host validates the full binding and current editor generation
before marks or editor changes. Opening the row restores it when the editor
is empty; divergent authored and saved text become an explicit two-copy
review. An external sending mark or one left after teardown is a special
review and cannot self-admit a send. Explicit adoption is allowed after the
person checks the history. Failed writes keep authored text and block send.
Do not clear the editor for a nonempty send until the exact text is marked.
A checked empty draft needs no durable mark; attachment-only authorization
belongs to the conversation caller. Later typing is volatile until the held
send settles. A known non-dispatch unmarks and restores held text followed
by later typing, or keeps it in the original binding if the editor moved.
Known dispatch and unknown dispatch both release the send and clear the
old marked text, saving any newer text for that binding. If the clear
fails or the process is torn down, the mark remains for review upon reopening.
A restored record is never a second dispatch receipt.

The reducer combines a successful mark/clear with its transaction receipt.
An inactive composition has no editor buffer in this binding; proof
requires that ownership fact to preserve other editors at settlement.
It tracks ordered authored fragments; the host inserts the pinned newline
separator and follows the source check for whitespace-only later typing.
Pending editor callback and same-binding peer coordination must preserve
the exact generation and coherent record; they are separate adapter checks.
Alpha's switch between bindings keeps any queued writes with the original
binding. Asynchronous editor restore must compare its expected display
text and active generation before applying. The controller reads with an
initial attempt and two retries, after 150 and 600 ms, and never publishes
a stale read as a new binding. If the independent form save uses
`consume`, the controller clears only after trimmed text and ownership match.
Post-clear drift or failure must attempt to recover that write through its
new receipt; the form effect cannot proceed after a failed consume.

```quint
type SendResult = Dispatched | NotDispatched | Unknown
type Composer = { active: bool, editor: List[str], saved: List[str], marked: bool, held: bool, review: bool, failed: bool, revision: int, seen: int }
pure val initial: Composer = { active: false, editor: List(), saved: List(), marked: false, held: false, review: false, failed: false, revision: 0, seen: 0 }
pure def canOpenDraft(s: Composer, editorText: List[str]): bool = not(s.active)
pure def openDraft(s: Composer, editorText: List[str]): Composer =
  { ...s, active: true, editor: if (not(s.marked) and editorText == List()) s.saved else editorText,
    review: not(s.held) and (s.marked or (editorText != List() and s.saved != List() and editorText != s.saved)),
    failed: false, seen: s.revision }
pure def canEditDraft(s: Composer, editorText: List[str]): bool = s.active
pure def editDraft(s: Composer, editorText: List[str]): Composer = { ...s, editor: editorText }
pure def canSaveDraft(s: Composer): bool =
  s.active and not(s.held or s.marked or s.review or s.failed) and s.seen == s.revision and s.editor != s.saved
pure def saveDraft(s: Composer): Composer = { ...s, saved: s.editor, revision: s.revision + 1, seen: s.revision + 1 }
pure def canConflictDraft(s: Composer, editorText: List[str]): bool = not(s.held or s.marked) and editorText != s.saved
pure def conflictDraft(s: Composer, editorText: List[str]): Composer =
  { ...s, saved: editorText, revision: s.revision + 1, review: s.active }
pure def canReviewDraft(s: Composer): bool = s.active and not(s.held) and s.review
pure def reviewDraft(s: Composer): Composer =
  { ...s, editor: s.saved, marked: false, revision: s.revision + 1, seen: s.revision + 1, review: false, failed: false }
pure def canHoldDraft(s: Composer): bool =
  s.active and not(s.marked or s.held or s.review or s.failed) and s.saved != List() and s.editor == s.saved and s.seen == s.revision
pure def holdDraft(s: Composer): Composer =
  { ...s, editor: List(), marked: true, held: true, revision: s.revision + 1, seen: s.revision + 1 }
pure def canCloseDraft(s: Composer): bool = s.active
pure def closeDraft(s: Composer): Composer = { ...s, active: false, editor: List(), review: false, failed: false }
pure def canAbandonDraft(s: Composer): bool = s.held
pure def abandonDraft(s: Composer): Composer = { ...s, active: false, held: false, editor: List(), review: false }
pure def canSettleDraft(s: Composer, sendResult: SendResult, ack: bool): bool = s.held
pure def settleDraft(s: Composer, sendResult: SendResult, ack: bool): Composer = {
  val later = if (s.active) s.editor else List()
  val kept = if (sendResult != NotDispatched) later else
    if (later == List()) s.saved else s.saved.concat(later)
  if (not(ack)) { ...s, held: false, failed: s.active, review: s.active }
  else { ...s, held: false, editor: if (s.active) kept else List(), saved: kept, marked: false,
    revision: s.revision + 1, seen: s.revision + 1, review: false, failed: false }
}
pure def alwaysHeldHasMark(s: Composer): bool = s.held implies s.marked and s.saved != List()
pure def alwaysMarkHasText(s: Composer): bool = s.marked implies s.saved != List()
pure def alwaysOrphanMarkWhileOpenIsForReview(s: Composer): bool = (s.active and s.marked and not(s.held)) implies s.review
pure def alwaysInactiveEditorIsDetached(s: Composer): bool = not(s.active) implies s.editor == List()
pure def alwaysNonnegativeRevision(s: Composer): bool = s.revision >= 0 and s.seen >= 0 and s.seen <= s.revision
pure def stepTeardownKeepsMarkedRow(before: Composer, via: str, after: Composer): bool =
  via == "abandonDraft" implies after.marked and after.saved == before.saved and after.revision == before.revision
pure def stepSettlementCannotAlterAnotherEditor(before: Composer, via: str, after: Composer): bool =
  via == "settleDraft" and not(before.active) implies not(after.active) and after.editor == before.editor
pure def lawMarkedCannotAdmitNewHold(s: Composer): bool = s.marked implies not(canHoldDraft(s))
pure def lawUnknownMatchesDispatch(s: Composer, ack: bool): bool = settleDraft(s, Unknown, ack) == settleDraft(s, Dispatched, ack)
pure def sometimesDurablyHeld(s: Composer): bool = s.held
pure def sometimesReviewAfterUnknown(s: Composer): bool = s.active and s.marked and s.review
pure def sometimesRetainsBoth(s: Composer): bool = not(s.marked or s.held) and s.editor == List("older", "newer") and s.saved == s.editor
pure val ownerIdValues = Set(0, 1, 2)
pure val utf8SizeValues = Set(-1, 0, 12, 64000, 64001)
pure val editorTextValues = Set(List(), List("older"), List("newer"))
pure val weight_holdDraft = 6
pure val weight_editDraft = 5
pure val weight_settleDraft = 6
pure val weight_saveDraft = 5
```
