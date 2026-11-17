# Selected document grants

A document the owner picks in Android's document picker becomes an opaque
selection: a fresh ID the renderer names on every later call, resolved again
on each use. The registry is one per process, holds at most 32 selections,
and records the exact persisted grants it took so that it can give each back
when nothing needs it any more. A note's source link (owned by the notes
host) keeps a grant alive through its `retains` callback; here it is the
`noteKeeps` input. PDF rendering, text reads, share and open are separate
effects that call `resolves` first. Source:
`plugins/plugin-native-media/android/.../SelectedDocuments.java` and
`SelectedDocumentCalls.java`; one app binds it as `SelectedDocumentAccess`.

The shell serializes every event under the registry lock, saves the
registry (retained selections and taken grants) before it performs any
effect, and discards an event whose save fails, except a pick (below).
A document is a small number here; in the shell it is a `content:` URI.

## Story: Keep only the documents I selected

> As the owner, I want my app to reach only the documents I picked, and to
> give back Android's grant on a document as soon as nothing of mine still
> needs it, so that no access outlives my choice.

### The picker is the authority, and a pick keeps a grant only when Android offered one

A selection is retained when the picker took a persistable read grant
(with write only when offered); otherwise it is transient and lives only
in this process. A retained pick also inherits write from a retained
selection of the same document; a transient pick inherits nothing. If
saving the registry fails, the pick gives back the grant it just took
unless something else still holds the document.

```quint
import bridge.* from "../bridge"
type Retention = Transient | RetainedRead | RetainedReadWrite
type PickerGrant = NoPersistableGrant | PersistedRead | PersistedReadWrite
type RegistryCommit = Committed | CommitFailed
type SelectedDocument = { id: int, doc: int, retention: Retention }
type DocumentGrants = { entries: List[SelectedDocument], nextId: int, granted: Set[int], noteKeeps: Set[int] }
type GrantEffect = ReleaseGrant({ doc: int }) | ClearPreview({ id: int }) | RenameReported({ id: int, reply: ProviderReply })
type GrantStep = { state: DocumentGrants, out: List[GrantEffect] }
pure val maxSelections = 32
pure val initial: DocumentGrants = { entries: List(), nextId: 1, granted: Set(), noteKeeps: Set() }
pure val noSelection: SelectedDocument = { id: 0, doc: 0, retention: Transient }
pure def holds(entries: List[SelectedDocument], doc: int): bool = entries.some(e => e.doc == doc)
pure def hasEntry(entries: List[SelectedDocument], id: int): bool = entries.some(e => e.id == id)
pure def entryOf(entries: List[SelectedDocument], id: int): SelectedDocument = entries.select(e => e.id == id).nthOr(0, noSelection)
pure def pickedRetention(offered: PickerGrant, siblingWrite: bool): Retention =
  if (offered == NoPersistableGrant) Transient else if (offered == PersistedReadWrite or siblingWrite) RetainedReadWrite else RetainedRead
pure def admit(entries: List[SelectedDocument], entry: SelectedDocument, capacity: int): List[SelectedDocument] = {
  val grown = entries.append(entry)
  if (grown.length() > capacity and grown.length() > 0) grown.tail() else grown
}
pure def giveBack(doc: int, s: DocumentGrants): GrantStep =
  if (s.granted.contains(doc) and not(holds(s.entries, doc)) and not(s.noteKeeps.contains(doc)))
    { state: { ...s, granted: s.granted.exclude(Set(doc)) }, out: List(ReleaseGrant({ doc: doc })) }
  else { state: s, out: List() }
pure def canPick(s: DocumentGrants, doc: int): bool = doc > 0
pure def pick(s: DocumentGrants, doc: int, offered: PickerGrant, commit: RegistryCommit): GrantStep = {
  val taken = if (offered == NoPersistableGrant) s.granted else s.granted.union(Set(doc))
  val siblingWrite = s.entries.some(e => e.doc == doc and e.retention == RetainedReadWrite)
  val entry = { id: s.nextId, doc: doc, retention: pickedRetention(offered, siblingWrite) }
  val evicted = if (s.entries.length() + 1 > maxSelections) s.entries.nthOr(0, noSelection) else noSelection
  val released = giveBack(evicted.doc, { ...s, entries: admit(s.entries, entry, maxSelections), nextId: s.nextId + 1, granted: taken })
  if (commit == CommitFailed) giveBack(doc, { ...s, granted: taken })
  else { state: released.state, out: if (evicted.id > 0) released.out.append(ClearPreview({ id: evicted.id })) else released.out }
}
pure val docValues = Set(1, 2)
pure val idValues = Set(1, 2, 3)
pure def alwaysIdsWereIssued(s: DocumentGrants): bool = s.nextId >= 1 and s.entries.every(e => e.id >= 1 and e.id < s.nextId and e.doc >= 1)
pure def sometimesTwoSelectionsShareADocument(s: DocumentGrants): bool = s.entries.some(a => s.entries.some(b => a.id != b.id and a.doc == b.doc))
pure def sometimesTransientBesideRetained(s: DocumentGrants): bool = s.entries.some(e => e.retention == Transient) and s.entries.some(e => e.retention != Transient)
```

### The registry never holds more than 32 selections, and a new pick evicts the oldest

The oldest selection is the first picked, transient or not. The insert and
the eviction are saved together, so a failed save leaves neither.

```quint
pure val capacityValues = Set(1, 2)
pure val entriesValues = Set(List(), List({ id: 1, doc: 1, retention: RetainedRead }), List({ id: 1, doc: 1, retention: Transient }, { id: 2, doc: 2, retention: RetainedReadWrite }))
pure val entryValues = Set({ id: 3, doc: 1, retention: RetainedRead }, { id: 3, doc: 2, retention: Transient })
pure def lawAdmissionKeepsTheNewestWithinCapacity(entries: List[SelectedDocument], entry: SelectedDocument, capacity: int): bool = {
  val admitted = admit(entries, entry, capacity)
  (capacity >= 1 and entries.length() <= capacity) implies (admitted.length() <= capacity and hasEntry(admitted, entry.id) and admitted.length() >= entries.length())
}
pure def alwaysWithinCapacity(s: DocumentGrants): bool = s.entries.length() <= maxSelections
```

### Forgetting gives back the exact grant only when no selection and no note still name the document

Owner forget, a failed resolve and eviction share these mechanics. A
covering folder grant is never touched; a provider that already revoked
the grant answers the release with an error the shell ignores.

```quint
pure def canForget(s: DocumentGrants, id: int): bool = hasEntry(s.entries, id)
pure def forget(s: DocumentGrants, id: int): GrantStep = {
  val released = giveBack(entryOf(s.entries, id).doc, { ...s, entries: s.entries.select(e => e.id != id) })
  { state: released.state, out: released.out.append(ClearPreview({ id: id })) }
}
pure def canKeepForNote(s: DocumentGrants, doc: int): bool = holds(s.entries, doc) and not(s.noteKeeps.contains(doc))
pure def keepForNote(s: DocumentGrants, doc: int): DocumentGrants = { ...s, noteKeeps: s.noteKeeps.union(Set(doc)) }
pure def canDropNoteKeep(s: DocumentGrants, doc: int): bool = s.noteKeeps.contains(doc)
pure def dropNoteKeep(s: DocumentGrants, doc: int): GrantStep = giveBack(doc, { ...s, noteKeeps: s.noteKeeps.exclude(Set(doc)) })
pure def alwaysEveryGrantHasAHolder(s: DocumentGrants): bool = s.granted.forall(d => holds(s.entries, d) or s.noteKeeps.contains(d))
pure def stepReleaseOnlyAnUnheldGrant(before: DocumentGrants, via: str, after: DocumentGrants, out: List[GrantEffect]): bool =
  out.every(e => match e { | ReleaseGrant(r) => not(holds(after.entries, r.doc)) and not(after.noteKeeps.contains(r.doc)) and not(after.granted.contains(r.doc)) | _ => true })
pure def stepGrantEndsOnlyByReleaseOrRevocation(before: DocumentGrants, via: str, after: DocumentGrants, out: List[GrantEffect]): bool =
  via == "revoke" or before.granted.forall(d => after.granted.contains(d) or out.includes(ReleaseGrant({ doc: d })))
pure def sometimesNoteKeepsAForgottenDocument(s: DocumentGrants): bool = s.noteKeeps.exists(d => s.granted.contains(d) and not(holds(s.entries, d)))
```

### A retained selection resolves only while Android still holds its exact grant

A covering folder grant does not stand in for the exact grant. The shell
forgets a selection that no longer resolves and reports it unavailable,
never repairing the grant. A transient selection resolves from its
recorded document; the provider still checks access on every read.

```quint
pure def resolves(s: DocumentGrants, id: int): bool = {
  val e = entryOf(s.entries, id)
  hasEntry(s.entries, id) and (e.retention == Transient or s.granted.contains(e.doc))
}
pure def canRevoke(s: DocumentGrants, doc: int): bool = s.granted.contains(doc)
pure def revoke(s: DocumentGrants, doc: int): DocumentGrants = { ...s, granted: s.granted.exclude(Set(doc)) }
pure def sometimesRevokedSelectionNoLongerResolves(s: DocumentGrants): bool = s.entries.some(e => e.retention != Transient and not(resolves(s, e.id)))
```

### Only retained selections survive a restart, and restore resumes the newest one still granted

A restart reloads the saved registry: transient selections are gone, and a
grant only they held is given back. Restore walks retained selections
newest first, forgetting each one that no longer resolves; a provider
failure is reported instead of falling back to an older document.

```quint
pure def restart(s: DocumentGrants): GrantStep = {
  val kept = s.entries.select(e => e.retention != Transient)
  val orphaned = s.granted.filter(d => not(holds(kept, d)) and not(s.noteKeeps.contains(d)))
  { state: { ...s, entries: kept, granted: s.granted.exclude(orphaned) },
    out: s.entries.foldl(List(), (acc, e) => if (orphaned.contains(e.doc) and not(acc.includes(ReleaseGrant({ doc: e.doc })))) acc.append(ReleaseGrant({ doc: e.doc })) else acc) }
}
pure def restoredSelection(s: DocumentGrants): int = s.entries.foldl(0, (found, e) => if (e.retention != Transient and s.granted.contains(e.doc)) e.id else found)
pure def stepRestartKeepsOnlyRetained(before: DocumentGrants, via: str, after: DocumentGrants): bool =
  via == "restart" implies (after.entries.every(e => e.retention != Transient) and before.entries.every(e => e.retention == Transient or after.entries.includes(e)))
pure def sometimesRestorePassesOverNewerTransients(s: DocumentGrants): bool = {
  val restored = restoredSelection(s)
  restored > 0 and s.entries.some(e => e.id > restored)
}
```

## Story: Rename my selected file and ask me to reselect if access is lost

> As the owner, I want to rename a document I selected only when its
> provider and my grant allow it, and to be asked to select it again when
> the provider keeps the rename but not my access.

### A rename rebinds the same selection to the provider's returned document only while access allows

The shell admits a rename when the selection resolves, holds a retained
write grant, Android reports current write access and the provider
advertises rename; the name, trimmed, is not empty, `.` or `..`, has no
slash, backslash or control character and is at most 255 UTF-16 units. A
provider that refuses or returns no document changes nothing and is
`NothingWritten`; an error after the call is `NoReply`. Otherwise the
selection keeps its ID, takes the grant again on the returned document
(dropping to transient if Android refuses), and gives back the old
document's grant if nothing else holds it. If the returned document is not
granted, the selection is forgotten and the rename is reported committed
but not read back, which asks the owner to reselect.

```quint
type Reacquire = GrantTaken | GrantRefused
pure def canRename(s: DocumentGrants, id: int, renamedDoc: int): bool =
  renamedDoc > 0 and resolves(s, id) and entryOf(s.entries, id).retention == RetainedReadWrite
pure def rename(s: DocumentGrants, id: int, renamedDoc: int, reacquire: Reacquire): GrantStep = {
  val old = entryOf(s.entries, id)
  val granted = if (reacquire == GrantTaken) s.granted.union(Set(renamedDoc)) else s.granted
  val rebound = s.entries.listMap(e => if (e.id == id) { ...e, doc: renamedDoc, retention: if (reacquire == GrantTaken) e.retention else Transient } else e)
  val durable = granted.contains(renamedDoc)
  val released = giveBack(old.doc, { ...s, granted: granted, entries: if (durable) rebound else s.entries.select(e => e.id != id) })
  { state: released.state, out: released.out.append(ClearPreview({ id: id })).append(RenameReported({ id: id, reply: if (durable) CommittedAndReadBack else CommittedNotReadBack })) }
}
pure val renamedDocValues = Set(1, 2, 3)
pure def stepRenameIsConfirmedOnlyWhileGranted(before: DocumentGrants, via: str, after: DocumentGrants, out: List[GrantEffect]): bool =
  out.every(e => match e { | RenameReported(r) => (r.reply == CommittedAndReadBack and hasEntry(after.entries, r.id) and after.granted.contains(entryOf(after.entries, r.id).doc)) or (r.reply == CommittedNotReadBack and not(hasEntry(after.entries, r.id))) | _ => true })
pure def sometimesSelectionHeldWithoutItsOwnGrant(s: DocumentGrants): bool = s.entries.some(e => e.retention == Transient and s.granted.contains(e.doc))
```
