# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents can
create, inspect, update, and delete together.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-notes build  # build
bun run --cwd plugins/plugin-notes test   # tests
```

## Editing notes

`NOTES_PATCH` requires `expectedRevision` from the complete note snapshot used to prepare the edit. Any intervening Notes mutation requires a fresh read and reconciliation. For an atomic literal substitution without a revision, use `NOTES_UPDATE` with `textEdit`; it must match exactly once and preserves all other text.

Service create/update inputs using `title`/`body` treat a nonempty body as lines after the title: one separator is added, including when the supplied body already starts with a newline. An empty body clears it; omitted fields remain unchanged. Use `{ content }` for a complete verbatim note and `textEdit` for a literal edit of stored fields. Do not mix complete content with structured fields. Stored schema-2 `body` includes its separator and is not a structured input body.

The app renderer resolves the package to `src/browser.ts`, which keeps views and
client registration separate from runtime actions and provider storage.

The separate `./client` entry provides device-local note contracts, persistence
and encrypted compare-and-exchange migration. Hosts supply storage keys, the
native vault and legacy storage; preserve installed namespaces when adopting it.
These device clients do not replace Cloud tenant storage or grant account authority.

`DocumentNotesStore` reuses the same device-local envelope over a host-supplied
atomic asynchronous document port. Hosts own initial legacy capture, opaque
revision receipts, backup/reset and storage protection; the client never writes a
synchronous mirror or claims that browser storage is encrypted. A stale writer
fails instead of merging or replacing another view's saved Notes.

The encrypted adapter delegates commits to this same document engine. Its opaque
revision binds the complete encrypted envelope, including migration archives.
Authorization and cancellation are rechecked after edit preparation and before CAS.

The device client also provides Trash retention, maintenance and foreground scheduling.
Hosts supply retention and size limits, note kinds, durable storage, a shared mutation
lock and recording cleanup. Maintenance checks saved live notes again under that lock.
It retains expired entries when owned content cannot be erased and removes stale
Trash rows without erasing a restored note. These helpers do not change Cloud deletion
or start a background service.

Capacity limits apply when adding to Trash. Existing documents remain readable and
can be restored or purged after a host lowers its limits. A full Trash refuses new
additions with `NotesTrashFull` (`isNotesTrashFull` also recognizes a host store's
`storage-full` refusal); hosts must explain that the user can empty Trash to free space.

`createNotesTrashActions` owns the owner-initiated Trash flows over the same host ports:
write-ahead move to Trash, restore, delete forever, empty Trash, and the separately
confirmed permanent deletion offered after a full Trash refused a restorable copy. Each
action re-reads authoritative storage under the host's deletion lock, never replaces a
newer edit or the only restorable copy of a newer deletion, and resolves a typed outcome
instead of retrying. Entries that own a recording are returned to the host's reviewed
recording path.

Unsaved device-local edits after a failed or uncertain commit are kept as a change set
(`notesDraftChanges`) in one encrypted slot (`createNotesDraftSlot`). Applying it later
(`applyNotesDraft`) adds drafted notes and applies an edit or removal only while that note
is unchanged since; `notesDraftConflicts` reports notes whose newer saved edits won, and a
later failure merges an older kept draft (`mergeNotesDrafts`) instead of replacing it.
`capacityAwareNotesVault` keeps a host store's definite capacity refusal distinct from an
uncertain commit. `reconcileNotesEditor` lets only a clean editor adopt a newly committed
collection. The host owns the slot name, recovery export and presentation.

`noteShareText` serializes one selected note (text, checklist, link or voice) for copy,
share, export and email drafts from its stored authored content only; a voice note's
audio is never attached and a missing transcript is stated as missing.

Deleting a voice note has two durable effects, the note's tombstone and its recording.
`createNotesRecordingDeletionJournal` keeps one recovery row per reviewed deletion over a
host compare-and-exchange store: rows are bound to the exact reviewed revision, every
change is checked against the row it expects and read back, and `noteState` reports from
authoritative saved storage whether this operation's own tombstone committed. After process
death, `planInterruptedPermanentDeletion` names the single next step that finishes a
confirmed permanent deletion or returns to the state before it, and keeps anything with
inexact ownership under review. `leasedDeletionRow`/`deletionLeaseDue` keep native passes
away from a row a live view is working on (a host's native pass must use the same
`PERMANENT_DELETION_LEASE_MS`), `createNotesDeletionClaims` stops one view settling a row
another live view started, and `createNotesDeletionLock` is the exclusive same-origin lock
these steps share. Hosts own the slots, the recording store, the lock and claim names and
the order of their effects; nothing here dispatches or repeats a deletion.

`createNotesRecordingEffects` runs the recording side of those deletions over a host
recording store (describe, remove, restore, purge and per-operation receipts): an approved
deletion outside the editor that trashes note and recording together under one operation
(`trashWithRecording`), confirmed erase after a committed tombstone (`eraseForever`), Trash
expiry that never erases a recording a saved note or recovery row still holds
(`purgeTrashed`), the interrupted permanent-deletion backstop (`settleInterrupted`), one
status pass per row that leaves another live view's row alone (`reconcile`) and lease
renewal (`renewLeases`). Every step is confirmed by readback and never retried; the caller
holds the deletion lock.

`proposedRecordingSummary` turns a model answer about a recording into an editable summary
and action list only when the answer is exactly that JSON object within the note limits;
anything else is reviewed as text. Saving remains a separate owner action.

`NotesSnapshotState` shares owner-bound, monotonic snapshot publication across the
React view and embedded hosts. The host supplies an opaque current authority;
retired owners cannot publish or expose their cached notes. It does not choose
request scheduling or change the server's revision contract.

`NotesController` and `NotesEditor` provide the embedded-host lifecycle and editor
over `createNotesClient`: coalesced reads, serialized explicit mutations, stale
revision review, rich authored content, and Trash restoration. Hosts supply the
current-owner check and view callbacks. The editor keeps unsaved text in memory;
these clients do not migrate older local stores, acquire credentials, or replay
an uncertain write. Forward only authenticated invalidation events to `invalidate(revision)`;
omit the revision when an authenticated event requires a fresh snapshot.

`./workspace` exposes the shared editable React `NotesWorkspace`. Supply the
canonical client, a current-owner binding and admitted invalidation events.
Hosts own navigation and optional speech, sharing and source-opening ports;
the workspace owns editor controls and canonical mutations. Keep its binding
stable across layout changes. `requestLeave()` retains a failed draft and
returns false; a host must not discard the workspace after that result.
This component does not open or migrate an older local Notes collection.
The handle's `interact` method shares that controller for explicit host commands,
such as saving a chat card before opening Notes. Hidden UI stays inactive; those
commands still require the same current owner and return the canonical receipt.
