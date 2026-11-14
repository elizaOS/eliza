# Alpha's canonical Notes client

`apps/app/src/prototype/canonical-notes-ui.ts` and the notes adapters use
Eliza's `plugins/plugin-notes/src/client/{notes-controller,notes-snapshot-state,notes-editor,notes-api}.ts`
and the canonical workspace/types. The browser/agent owns durable Notes.
The editor preserves a draft's token, authored fields and revision. It
uses the mutation reply's target rather than inferring a creation from a
collection diff. Alpha's prior `CanonicalNotesController`,
`CanonicalNotesDraft`, `CanonicalNotesMutation`, and `CanonicalNotesStore`
Quint models are indexed in the pinned source inventory.

## Story: Read and save a note under the current connection

### Late reads and old owner snapshots cannot replace the current collection

Refresh shares a pending read. While a mutation owns the controller,
refresh records an invalidation and the mutation cancels any pending
read. A same-or-older authenticated revision needs no refresh. Pending
newer/unknown invalidations coalesce into the next refresh. A snapshot is
published only under the captured current owner, and its revision under
that owner cannot go backward. Delivering a response for a retired or
superseded read cannot publish progress. Failed current operations have
an explicit recovery phase.

```quint
type NotesStatus = Detached | Loading | Ready | Saving | Review | Retired
pure val loadingStatus: NotesStatus = Loading
pure val savingStatus: NotesStatus = Saving
pure val reviewStatus: NotesStatus = Review
pure val readyStatus: NotesStatus = Ready
pure val retiredStatus: NotesStatus = Retired
type NoteView = { owner: int, ticket: int, status: NotesStatus, revision: int, invalidated: bool, reload: bool, draftToken: int, draftRevision: int, draftVersion: int, draftAuthored: bool, capturedToken: int, capturedVersion: int, queuedVersion: int, committedTarget: str }
pure val initial: NoteView = { owner: 0, ticket: 0, status: Detached, revision: -1, invalidated: false, reload: false, draftToken: 0, draftRevision: -1, draftVersion: 0, draftAuthored: false, capturedToken: 0, capturedVersion: 0, queuedVersion: -1, committedTarget: "" }
pure def resetNoteView(ownerId: int, s: NoteView): NoteView = { ...initial, owner: ownerId, ticket: s.ticket + 1, status: if (ownerId == 0) retiredStatus else loadingStatus }
pure def canBind(s: NoteView, ownerId: int): bool = ownerId > 0 and ownerId != s.owner
pure def bind(s: NoteView, ownerId: int): NoteView = resetNoteView(ownerId, s)
pure def canRetire(s: NoteView): bool = s.owner > 0
pure def retire(s: NoteView): NoteView = resetNoteView(0, s)
pure def canRefresh(s: NoteView): bool = s.owner > 0
pure def refresh(s: NoteView): NoteView =
  if (s.status == Saving) { ...s, invalidated: true }
  else if (s.status == Loading) s
  else { ...s, ticket: s.ticket + 1, status: loadingStatus, reload: false, invalidated: false }
pure def canInvalidate(s: NoteView, revision: int): bool = s.owner > 0 and (revision == -1 or revision > s.revision)
pure def invalidate(s: NoteView, revision: int): NoteView =
  if (s.status == Saving or s.status == Loading) { ...s, invalidated: true }
  else { ...s, ticket: s.ticket + 1, status: loadingStatus, reload: false, invalidated: false }
pure def canFinishRead(s: NoteView, ownerId: int, ticket: int): bool = s.status == Loading and s.owner > 0 and ownerId == s.owner and ticket == s.ticket
pure def finishRead(s: NoteView, ownerId: int, ticket: int, revision: int, success: bool): NoteView = {
  val accepted = success and revision >= 0 and revision >= s.revision
  { ...s, revision: if (accepted) revision else s.revision, reload: s.invalidated, invalidated: false, status: if (accepted) readyStatus else reviewStatus }
}
pure val ownerIdValues = Set(1, 2)
pure val ticketValues = Set(1, 2, 3, 4, 5, 6)
pure val revisionValues = Set(-1, 0, 1, 2, 3)
pure def alwaysCurrentSnapshotHasOwner(s: NoteView): bool = s.revision >= -1 and (s.revision >= 0 implies s.owner > 0)
pure def alwaysRetiredHasNoOwner(s: NoteView): bool = (s.status == Retired or s.status == Detached) iff s.owner == 0
pure def stepRevisionNeverRegressesForOwner(before: NoteView, after: NoteView): bool =
  before.owner == after.owner implies before.revision <= after.revision
pure def sometimesReadsSnapshot(s: NoteView): bool = s.status == Ready and s.revision >= 0
pure def sometimesQueuesReload(s: NoteView): bool = s.reload
```

### A save owns the captured draft and adopts only the server's exact target

The editor opens from a current canonical revision and checks that base
before saving. A revision conflict goes to review without granting
permission to overwrite. Save requires authored text or supported authored
format. While saving, an explicit later save queues the latest edited
version. Success requires a mutation reply with explicit note and target
identity and a nonstale snapshot. A replacement draft token is unaffected.
If the original draft was edited during its save, the acknowledgement
updates its target and base revision but preserves authored data. Clean
same-token success adopts the returned canonical fields. The successful
same-token save may start a newer queued edit. Failure keeps authored
content and avoids retrying an uncertain mutation. The model tracks
identity/version and whether an authored value exists. Format validation,
exact cloning/framing, snapshot payload admission and request effects
require implementation conformance.

```quint
pure def canOpenDraft(s: NoteView, token: int): bool = s.owner > 0 and s.revision >= 0 and token > 0 and token != s.draftToken and token != s.capturedToken
pure def openDraft(s: NoteView, token: int, authored: bool): NoteView =
  { ...s, draftToken: token, draftRevision: s.revision, draftVersion: 0, draftAuthored: authored, queuedVersion: -1, committedTarget: "" }
pure def canEditDraft(s: NoteView): bool = s.owner > 0 and s.draftToken > 0
pure def editDraft(s: NoteView, authored: bool): NoteView = { ...s, draftAuthored: authored, draftVersion: s.draftVersion + 1 }
pure def canCloseDraft(s: NoteView): bool = s.draftToken > 0
pure def closeDraft(s: NoteView): NoteView = { ...s, draftToken: 0, draftRevision: -1, draftVersion: 0, draftAuthored: false, queuedVersion: -1, committedTarget: "" }
pure def canSave(s: NoteView): bool = s.owner > 0 and s.draftToken > 0
pure def save(s: NoteView): NoteView =
  if (s.status == Saving) { ...s, queuedVersion: s.draftVersion }
  else if (s.revision != s.draftRevision or not(s.draftAuthored)) { ...s, status: reviewStatus }
  else { ...s, ticket: s.ticket + 1, status: savingStatus, capturedToken: s.draftToken, capturedVersion: s.draftVersion,
    queuedVersion: -1, invalidated: s.invalidated or s.status == Loading }
pure def canFinishSave(s: NoteView, ownerId: int, ticket: int): bool = s.status == Saving and s.owner > 0 and ownerId == s.owner and ticket == s.ticket
pure def finishSave(s: NoteView, ownerId: int, ticket: int, revision: int, target: str, observed: bool): NoteView = {
  val accepted = observed and target != "" and revision >= 0 and revision >= s.revision
  val same = s.draftToken == s.capturedToken and s.draftToken > 0
  val changed = same and s.draftVersion != s.capturedVersion
  val queued = accepted and same and s.queuedVersion > s.capturedVersion and s.draftAuthored
  val rebased = accepted and same
  { ...s, revision: if (accepted) revision else s.revision, reload: s.invalidated and not(queued),
    invalidated: s.invalidated and queued, ticket: if (queued) s.ticket + 1 else s.ticket,
    status: if (queued) savingStatus else if (accepted) readyStatus else reviewStatus,
    capturedToken: if (queued) s.draftToken else 0, capturedVersion: if (queued) s.draftVersion else 0,
    queuedVersion: -1, committedTarget: if (rebased) target else s.committedTarget,
    draftRevision: if (rebased) revision else s.draftRevision,
    draftVersion: if (rebased and not(changed)) 0 else s.draftVersion }
}
pure val tokenValues = Set(1, 2, 3)
pure val targetValues = Set("", "note-from-receipt", "different-note")
pure def alwaysSavingHasCapture(s: NoteView): bool = s.status == Saving implies s.capturedToken > 0
pure def alwaysVersionIsNonnegative(s: NoteView): bool = s.ticket >= 0 and s.draftVersion >= 0 and s.capturedVersion >= 0
pure def stepSaveDoesNotReplaceLaterDraft(before: NoteView, via: str, after: NoteView): bool =
  via == "finishSave" and before.draftToken != before.capturedToken implies
  before.draftRevision == after.draftRevision and before.draftVersion == after.draftVersion and before.committedTarget == after.committedTarget
pure def sometimesAdoptsReceiptTarget(s: NoteView): bool = s.committedTarget != ""
pure def sometimesEditedDuringSave(s: NoteView): bool = s.status == Saving and s.draftToken == s.capturedToken and s.draftVersion > s.capturedVersion
```
