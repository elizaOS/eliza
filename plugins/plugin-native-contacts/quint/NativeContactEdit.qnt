// One owner edit of one contact through ContactsEditor: read at a version, then one batch.
// The contact may be linked from two raw contacts. Its notes may be one editable value or not
// (several note rows, or a note with other control characters).
module NativeContactEdit {
  type State = { phase: str, version: int, readVersion: int, linked: bool, notesEditable: bool,
    readRefused: bool, notesOffered: bool, draftNotes: bool, rename: bool, newNameSimpler: bool,
    writes: int, notesWritten: bool, notesEditableAtWrite: bool, superPrimary: bool,
    renameShown: bool, result: str }
  var s: State

  // ContactsEditor.get: unrepresentable notes are omitted; the rest of the contact stays editable.
  pure def readRefuses(notesEditable: bool): bool = false
  // ContactsEditor.save: a draft that supplies notes needs the one editable note value.
  pure def notesWritable(draftNotes: bool, notesEditable: bool): bool = not(draftNotes) or notesEditable
  // ContactsEditor.save: the edited name row of a linked contact becomes super-primary.
  pure def markSuperPrimary(linked: bool): bool = linked
  // AbstractContactAggregator.processDisplayNameCandidate between two structured names of writable
  // accounts: a super-primary name wins, otherwise the more complex one.
  pure def shown(linked: bool, superPrimary: bool, newNameSimpler: bool): bool =
    not(linked) or superPrimary or not(newNameSimpler)

  action initWith(linked: bool, notesEditable: bool): bool = s' = { phase: "idle", version: 0, readVersion: 0,
    linked: linked, notesEditable: notesEditable, readRefused: false, notesOffered: false,
    draftNotes: false, rename: false, newNameSimpler: false, writes: 0, notesWritten: false,
    notesEditableAtWrite: false, superPrimary: false, renameShown: false, result: "none" }
  action init = {
    nondet linked = Set(true, false).oneOf()
    nondet notesEditable = Set(true, false).oneOf()
    initWith(linked, notesEditable)
  }
  action readWith(refuses: bool): bool = all { s.phase == "idle",
    s' = { ...s, phase: if (refuses) "done" else "read", readVersion: s.version, readRefused: refuses,
      notesOffered: s.notesEditable, result: if (refuses) "incomplete" else s.result } }
  action read = readWith(readRefuses(s.notesEditable))
  // The renderer may still supply notes that get omitted; the host must refuse that save.
  action draft(withNotes: bool, rename: bool, simpler: bool): bool = all { s.phase == "read",
    s' = { ...s, phase: "drafted", draftNotes: withNotes, rename: rename, newNameSimpler: rename and simpler } }
  // Another writer, a sync adapter or the aggregator changes the contact before the batch commits.
  action otherWriter = {
    nondet notesEditable = Set(true, false).oneOf()
    all { s.phase != "done", s.version < 2, s' = { ...s, version: s.version + 1, notesEditable: notesEditable } }
  }
  action stale = all { s.phase == "drafted", s.version != s.readVersion,
    s' = { ...s, phase: "done", result: "stale" } }
  action refuseNotes = all { s.phase == "drafted", s.version == s.readVersion,
    not(notesWritable(s.draftNotes, s.notesEditable)),
    s' = { ...s, phase: "done", result: "failed" } }
  // The version asserts commit the whole batch, or none of it.
  action commitWith(checkNotes: bool, superPrimary: bool, replyLost: bool): bool = all { s.phase == "drafted",
    s.version == s.readVersion, if (checkNotes) notesWritable(s.draftNotes, s.notesEditable) else true,
    val marked = s.rename and superPrimary
    s' = { ...s, phase: "done", version: s.version + 1, writes: 1, notesWritten: s.draftNotes,
      notesEditableAtWrite: s.notesEditable, superPrimary: marked,
      renameShown: not(s.rename) or shown(s.linked, marked, s.newNameSimpler),
      result: if (replyLost) "unknown" else "saved" } }
  action commit(replyLost: bool): bool = commitWith(true, markSuperPrimary(s.linked), replyLost)
  action anyDraft = {
    nondet withNotes = Set(true, false).oneOf()
    nondet rename = Set(true, false).oneOf()
    nondet simpler = Set(true, false).oneOf()
    draft(withNotes, rename, simpler)
  }
  action progress = any { read, anyDraft, stale, refuseNotes, commit(false), commit(true) }
  action step = any { progress, otherWriter, s' = s }

  val TypeOK = Set("idle", "read", "drafted", "done").contains(s.phase)
    and Set("none", "incomplete", "saved", "stale", "failed", "unknown").contains(s.result)
    and s.version >= 0 and s.version <= 3 and s.writes >= 0 and s.writes <= 1
  val NotesNeverBlockTheContact = not(s.readRefused)
  val NotesNeverFlattened = s.notesWritten implies s.notesEditableAtWrite
  val RefusalsWriteNothing = Set("stale", "failed", "incomplete").contains(s.result) implies s.writes == 0
  val SavedRenameIsShown = s.result == "saved" implies s.renameShown
  temporal FairEditSettles = progress.weakFair(s) implies (s.phase != "done").leadsTo(s.phase == "done")

  run phoneEditWithUnavailableNotesTest = initWith(true, false).then(read).then(draft(false, false, false))
    .then(commit(false)).expect(s.result == "saved" and not(s.notesOffered) and not(s.notesWritten))
  run suppliedNotesAreRefusedTest = initWith(true, false).then(read).then(draft(true, false, false))
    .then(refuseNotes).expect(s.result == "failed" and s.writes == 0)
  run linkedSimplerRenameIsShownTest = initWith(true, true).then(read).then(draft(false, true, true))
    .then(commit(false)).expect(s.result == "saved" and s.superPrimary and s.renameShown)
  run changedContactIsStaleTest = initWith(false, true).then(read).then(otherWriter).then(draft(true, true, false))
    .then(stale).expect(s.result == "stale" and s.writes == 0)
  run lostReplyIsUnknownTest = initWith(false, true).then(read).then(draft(true, false, false))
    .then(commit(true)).expect(s.result == "unknown" and s.writes == 1)

  // Witnesses: each removes one production guard and breaks the invariant that guard protects.
  run wholeContactRefusalWitness = initWith(false, false).then(readWith(not(s.notesEditable)))
    .expect(not(NotesNeverBlockTheContact))
  run flattenedNotesWitness = initWith(true, false).then(read).then(draft(true, false, false))
    .then(commitWith(false, true, false)).expect(not(NotesNeverFlattened))
  run unmarkedRenameWitness = initWith(true, true).then(read).then(draft(false, true, true))
    .then(commitWith(true, false, false)).expect(not(SavedRenameIsShown))
}
