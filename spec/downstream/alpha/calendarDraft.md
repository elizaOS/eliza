# Alpha Calendar editor and reviewed provider mutation

`apps/app/src/prototype/agent-calendar-adapter.ts` binds the supported
Eliza linked Calendar clients and event-editor policy. Its draft adapters
use the same owner-bound editor slot for Calendar, Notes, and scanned
Calendar proposals. `canonical-calendar-draft.ts` encodes authored fields
with the owner, creation ID, optional event identity and provider version,
recurrence scope, timing, guests and all-day range. Related pinned Quint
models include `CanonicalCalendarDraft`, `CanonicalCalendarDraftHandoff`,
`CanonicalCalendarEditorClose`, `AgentCalendarMutation`, and
`CalendarPreservationConfirmation`.

## Story: Preserve my Calendar draft and mutate only the event version I reviewed

### A restored draft supplies hints and must be confirmed against live Calendar

A saved draft must decode under its schema and exact owner, and cannot
replace a live editor or retained draft through a scan or Notes handoff.
A current source may permit reads without permitting writes. Existing
Calendar writes require a fresh exact target and provider version.
The editor preserves original timing when the stored time cannot be
represented or confirmed in the form. Managing a recurrence needs the
admitted scope. A provider that cannot faithfully preserve unsupported
attendees, recurrence details, or timing requires a new review or a
separate edit in that provider. A create uses its stable operation key.
A deletion or invitation decline follows the provider's distinct action
and first requires current selection, verified bytes and owner review.
The codec, exact mutable fields, idempotency storage and provider calls
require conformance beyond this owner/version and publication model.

```quint
type CalendarEdit = Create | Update | Remove | Decline
type CalendarWriteFacts = { ownerCurrent: bool, writableSource: bool, validForm: bool, exactTarget: bool, versionMatches: bool, preservesFields: bool, scopedRecurrence: bool, reviewed: bool }
pure val factsValues = Set(
  { ownerCurrent: true, writableSource: true, validForm: true, exactTarget: true, versionMatches: true, preservesFields: true, scopedRecurrence: true, reviewed: true },
  { ownerCurrent: true, writableSource: true, validForm: true, exactTarget: true, versionMatches: false, preservesFields: true, scopedRecurrence: true, reviewed: true },
  { ownerCurrent: false, writableSource: true, validForm: true, exactTarget: true, versionMatches: true, preservesFields: true, scopedRecurrence: true, reviewed: true },
  { ownerCurrent: true, writableSource: true, validForm: true, exactTarget: true, versionMatches: true, preservesFields: false, scopedRecurrence: true, reviewed: true }
)
pure def admitsEdit(kind: CalendarEdit, facts: CalendarWriteFacts): bool =
  facts.ownerCurrent and facts.writableSource and facts.validForm and facts.preservesFields and facts.scopedRecurrence and
  (kind == Create or (facts.exactTarget and facts.versionMatches and ((kind != Remove and kind != Decline) or facts.reviewed)))
pure def lawExistingEditRequiresExactVersion(kind: CalendarEdit, facts: CalendarWriteFacts): bool =
  kind != Create and admitsEdit(kind, facts) implies facts.exactTarget and facts.versionMatches
pure def lawRemovalRequiresReview(kind: CalendarEdit, facts: CalendarWriteFacts): bool =
  (kind == Remove or kind == Decline) and admitsEdit(kind, facts) implies facts.reviewed
pure def admitsImport(ownerCurrent: bool, feedAvailable: bool, editorOccupied: bool, retainedDraft: bool, recovering: bool): bool =
  ownerCurrent and feedAvailable and not(editorOccupied or retainedDraft or recovering)
pure def lawImportNeverReplacesDraft(ownerCurrent: bool, feedAvailable: bool, editorOccupied: bool, retainedDraft: bool, recovering: bool): bool =
  admitsImport(ownerCurrent, feedAvailable, editorOccupied, retainedDraft, recovering) implies not(editorOccupied or retainedDraft)
```

### An acknowledgement settles the old snapshot without replacing later authored input

An in-flight mutation keeps the owner, draft token, version, and operation
key it captured. A successful save of the current unchanged form closes
that form. If the owner edited the same form meanwhile, an explicit saved
event identity can rebase its revision and rotate the key for the next
mutation. Without that identity the still-authored form becomes uncertain
and requires review. A new form token or retired owner does not get
replaced. A failed write preserves the current fields and admits only
verified recovery. The reducer models a single editor and one current
mutation; effect dispatch and durable idempotency remain in the linked
workflow/Calendar ports.

```quint
type EditorReceipt = Applied | Unknown | Failed
type Draft = { owner: int, formId: int, draftVersion: int, capturedId: int, capturedVersion: int, counter: int, pending: bool, uncertain: bool, afterVersion: int }
pure val initial: Draft = { owner: 0, formId: 0, draftVersion: 0, capturedId: 0, capturedVersion: 0, counter: 0, pending: false, uncertain: false, afterVersion: 0 }
pure def canOpenForm(s: Draft, ownerId: int): bool = ownerId > 0 and not(s.pending) and s.formId == 0
pure def openForm(s: Draft, ownerId: int): Draft = { ...s, owner: ownerId, formId: s.counter + 1, counter: s.counter + 1, draftVersion: 0, uncertain: false, afterVersion: 0 }
pure def canEditForm(s: Draft): bool = s.formId > 0 and not(s.uncertain)
pure def editForm(s: Draft): Draft = { ...s, draftVersion: s.draftVersion + 1 }
pure def canBeginWrite(s: Draft, kind: CalendarEdit, facts: CalendarWriteFacts): bool = s.formId > 0 and not(s.pending or s.uncertain) and admitsEdit(kind, facts)
pure def beginWrite(s: Draft, kind: CalendarEdit, facts: CalendarWriteFacts): Draft = { ...s, pending: true, capturedId: s.formId, capturedVersion: s.draftVersion }
pure def canCloseForm(s: Draft): bool = s.formId > 0
pure def closeForm(s: Draft): Draft = { ...s, formId: 0, draftVersion: 0, uncertain: false }
pure def canAcceptWrite(s: Draft, ownerId: int, formId: int): bool = s.pending and ownerId == s.owner and formId == s.capturedId
pure def acceptWrite(s: Draft, ownerId: int, formId: int, receipt: EditorReceipt, providerVersion: int): Draft = {
  val same = s.formId == s.capturedId
  val edited = s.draftVersion != s.capturedVersion
  val discard = same and receipt == Applied and not(edited)
  val rebased = same and receipt == Applied and edited and providerVersion > 0
  { ...s, pending: false, formId: if (discard) 0 else s.formId, afterVersion: if (rebased) providerVersion else s.afterVersion,
    uncertain: if (same) receipt == Unknown or (receipt == Applied and edited and providerVersion <= 0) else s.uncertain }
}
pure def retireEditor(s: Draft): Draft = { ...initial, counter: s.counter }
pure def alwaysPendingRetainsCapture(s: Draft): bool = s.pending implies s.capturedId > 0 and s.owner > 0
pure def alwaysUncertainHasDraft(s: Draft): bool = s.uncertain implies s.formId > 0
pure def alwaysDraftHasOwner(s: Draft): bool = s.formId > 0 implies s.owner > 0
pure def alwaysSerialPreservesAllocatedIdentity(s: Draft): bool = s.counter >= 0 and s.formId <= s.counter and s.capturedId <= s.counter
pure def stepSettledOlderWriteKeepsNewEdits(before: Draft, via: str, after: Draft): bool =
  via == "acceptWrite" and before.draftVersion != before.capturedVersion implies before.draftVersion == after.draftVersion and before.formId == after.formId
pure def sometimesUncertainDraft(s: Draft): bool = s.uncertain
pure def sometimesRebasedDraft(s: Draft): bool = s.formId > 0 and s.afterVersion > 0
pure val ownerIdValues = Set(1, 2)
pure val formIdValues = Set(1, 2, 3, 4)
pure val providerVersionValues = Set(0, 1, 2)
pure val weight_acceptWrite = 5
```
