import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotesDeletionClaims,
  createNotesDeletionLock,
  createNotesRecordingDeletionJournal,
  deletionLeaseDue,
  leasedDeletionRow,
  PERMANENT_DELETION_LEASE_MS,
  planInterruptedPermanentDeletion,
  sameDeletionRow,
} from "../src/client/notes-recording-deletion.ts";
import { NotesStore } from "../src/client/notes-store.ts";

const voice = (id, audioId = `audio-${id}`) => ({
  id,
  kind: "voice",
  title: `Recording ${id}`,
  audio: { audioId, noteId: id },
  lines: [{ s: "me", t: "Call the landlord", at: 1 }],
});

/** A saved Notes collection in memory, with the shared envelope and hashes. */
function collection(records) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = new NotesStore(
    { current: "saved", legacy: "legacy" },
    storage,
    records,
  );
  return { store, raw: () => values.get("saved") };
}

/** Journal ports over an in-memory compare-and-exchange slot. */
function journalWorld(saved) {
  const state = { journal: null, edits: 0, conflict: false, lost: false };
  const journal = createNotesRecordingDeletionJournal({
    read: async () => structuredClone(state.journal),
    async edit(change) {
      const before = structuredClone(state.journal);
      const next = change(before);
      if (state.conflict) throw Error("Recording deletion changed");
      state.edits++;
      if (!state.lost) state.journal = structuredClone(next);
    },
    readSavedNotes: async () => saved.raw(),
  });
  return { state, journal };
}

async function reviewedRow(saved, id, extra = {}) {
  const note = saved.store.list.find((row) => row.id === id);
  return {
    id: `op-${id}`,
    target: await saved.store.target(id),
    note,
    audioId: note.audio.audioId,
    ...extra,
  };
}

test("an interrupted permanent deletion is finished or rolled back only on exact ownership", () => {
  const live = { ownedByNote: true, inAudioTrash: false };
  const trashed = { ownedByNote: true, inAudioTrash: true };
  const at = (note, recording, receipt, referencedElsewhere = false) =>
    planInterruptedPermanentDeletion({
      note,
      recording,
      receipt,
      referencedElsewhere,
    });
  // Death after the tombstone commit, before the recording moved: finish both steps.
  assert.equal(at("deleted", live, "unknown"), "trash-then-erase");
  // Death after the move to the audio trash, before the erase.
  assert.equal(at("deleted", trashed, "removed"), "erase");
  // Death after the erase, before the recovery row was retired.
  assert.equal(at("deleted", trashed, "purged"), "retire");
  // Death before the tombstone commit: nothing happened, so only the row goes.
  assert.equal(at("original", live, "unknown"), "retire");
  assert.equal(at("original", live, "restored"), "retire");
  // Recording moved but the note never deleted: give the recording back.
  assert.equal(at("original", trashed, "removed"), "restore-recording");
  // Recording erased under this operation and the reviewed note still saved: finish the note.
  assert.equal(at("original", trashed, "purged"), "delete-note");
  // A note that changed is never touched.
  for (const recording of [live, trashed, null])
    for (const receipt of ["unknown", "removed", "restored", "purged", null])
      for (const elsewhere of [false, true])
        assert.equal(at("changed", recording, receipt, elsewhere), "review");
  // Unreadable or foreign recordings and unreadable receipts are never touched.
  for (const note of ["deleted", "original"])
    for (const receipt of ["unknown", "removed", "restored", "purged"]) {
      assert.equal(at(note, null, receipt), "review");
      for (const inAudioTrash of [false, true])
        assert.equal(
          planInterruptedPermanentDeletion({
            note,
            recording: { ownedByNote: false, inAudioTrash },
            receipt,
            referencedElsewhere: false,
          }),
          "review",
        );
    }
  for (const note of ["deleted", "original"])
    for (const recording of [live, trashed])
      assert.equal(at(note, recording, null), "review");
  // A recording another saved note references is never erased.
  for (const recording of [live, trashed])
    for (const receipt of ["unknown", "removed", "restored", "purged"])
      assert.equal(at("deleted", recording, receipt, true), "review");
  // Another deletion's audio trash, a started restore or disagreeing receipts stay under review.
  assert.equal(at("deleted", trashed, "unknown"), "review");
  assert.equal(at("deleted", live, "restored"), "review");
  assert.equal(at("deleted", trashed, "restored"), "review");
  assert.equal(at("deleted", live, "removed"), "review");
  assert.equal(at("original", trashed, "unknown"), "review");
  assert.equal(at("original", trashed, "restored"), "review");
  assert.equal(at("original", live, "removed"), "review");
  // Only two plans erase a recording, and both require this operation's committed tombstone.
  for (const note of ["deleted", "original", "changed"])
    for (const recording of [live, trashed])
      for (const receipt of ["unknown", "removed", "restored", "purged"]) {
        const step = at(note, recording, receipt);
        if (step === "erase" || step === "trash-then-erase")
          assert.equal(note, "deleted");
        if (step === "delete-note") assert.equal(receipt, "purged");
      }
});

test("a lease runs from now, is renewed once half has run out and never changes the deletion", () => {
  const row = { id: "a", permanent: true };
  const now = 1_000_000;
  assert.equal(PERMANENT_DELETION_LEASE_MS, 20 * 60 * 1000);
  const leased = leasedDeletionRow(row, now);
  assert.deepEqual(leased, {
    id: "a",
    permanent: true,
    lease: { until: now + PERMANENT_DELETION_LEASE_MS },
  });
  assert.equal(deletionLeaseDue(leased, now), false);
  assert.equal(
    deletionLeaseDue(leased, now + PERMANENT_DELETION_LEASE_MS / 2 + 1),
    true,
  );
  assert.equal(deletionLeaseDue(row, now), true, "an unleased row is due");
  assert.equal(
    deletionLeaseDue({ ...row, lease: { until: "soon" } }, now),
    true,
  );
  assert.equal(sameDeletionRow(leased, row), true);
  assert.equal(
    sameDeletionRow(leased, { ...row, audioRequested: true }),
    false,
  );
});

test("the journal binds each row to its exact reviewed revision and confirms every change", async () => {
  const saved = collection([voice("v1"), voice("v2")]);
  const { state, journal } = journalWorld(saved);
  const row = await reviewedRow(saved, "v1");
  assert.deepEqual(await journal.pending(), {});
  await journal.change(row, true);
  assert.deepEqual(await journal.pending(), { [row.id]: row });
  // One unconfirmed deletion per note.
  await assert.rejects(
    journal.change({ ...row, id: "op-other" }, true),
    /Recording deletion changed/,
  );
  // Replacing requires the exact stored row; a lease renewal is a replacement.
  const dispatched = leasedDeletionRow({ ...row, audioRequested: true }, 5);
  await assert.rejects(
    journal.change({ ...row, permanent: true }, false, dispatched),
    /Recording deletion changed/,
  );
  await journal.change(row, false, dispatched);
  assert.deepEqual((await journal.pending())[row.id], dispatched);
  await journal.change(dispatched, false);
  assert.deepEqual(await journal.pending(), {});
  // A write the store did not keep is reported, never assumed.
  state.lost = true;
  await assert.rejects(
    journal.change(row, true),
    /Recording deletion persistence unconfirmed/,
  );
  state.lost = false;
  // A store that refuses the exchange leaves the journal untouched.
  state.conflict = true;
  await assert.rejects(journal.change(row, true), /Recording deletion changed/);
  assert.deepEqual(await journal.pending(), {});
});

test("malformed or rebound rows are refused instead of guessed", async () => {
  const saved = collection([
    voice("v1"),
    { id: "t1", kind: "text", title: "Text" },
  ]);
  const { state, journal } = journalWorld(saved);
  const row = await reviewedRow(saved, "v1");
  const refused = async (value) => {
    state.journal = value;
    await assert.rejects(journal.pending(), /Invalid|changed/);
  };
  await refused([row]);
  await refused({ other: row });
  await refused({ [row.id]: { ...row, audioId: "audio-other" } });
  await refused({ [row.id]: { ...row, audioRequested: false } });
  await refused({ [row.id]: { ...row, permanent: "yes" } });
  await refused({ [row.id]: { ...row, note: { ...row.note, kind: "text" } } });
  await refused({
    [row.id]: {
      ...row,
      note: { ...row.note, audio: { audioId: row.audioId, noteId: "v2" } },
    },
  });
  await refused({ "bad id": { ...row, id: "bad id" } });
  // The row's note must be the reviewed revision, not a later edit.
  await refused({
    [row.id]: { ...row, note: { ...row.note, title: "Edited elsewhere" } },
  });
  const many = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`op-${index}`, row]),
  );
  await refused(many);
  state.journal = null;
  assert.deepEqual(await journal.pending(), {});
  // A host may bound the journal more tightly and name another recording kind.
  const tight = createNotesRecordingDeletionJournal(
    {
      read: async () => ({ [row.id]: row }),
      edit: async () => {},
      readSavedNotes: async () => saved.raw(),
    },
    { maxRows: 0 },
  );
  await assert.rejects(
    tight.pending(),
    /Invalid recording deletion recovery store/,
  );
  const memo = createNotesRecordingDeletionJournal(
    {
      read: async () => ({ [row.id]: row }),
      edit: async () => {},
      readSavedNotes: async () => saved.raw(),
    },
    { recordingKind: "memo" },
  );
  await assert.rejects(memo.pending(), /Invalid recording deletion binding/);
});

test("note state comes from authoritative storage and names only this operation's tombstone", async () => {
  const saved = collection([voice("v1"), voice("v2")]);
  const { journal } = journalWorld(saved);
  const row = await reviewedRow(saved, "v1");
  assert.equal(await journal.noteState(row), "original");
  // This operation's own tombstone of the reviewed revision.
  await saved.store.execute(
    { type: "notes_delete", target: row.target },
    row.id,
    new AbortController().signal,
    () => {},
  );
  assert.equal(await journal.noteState(row), "deleted");
  assert.equal(await journal.noteState({ ...row, id: "op-other" }), "changed");

  // Edited after review.
  const edited = collection([voice("v1")]);
  const editedJournal = journalWorld(edited).journal;
  const reviewed = await reviewedRow(edited, "v1");
  edited.store.replace([{ ...reviewed.note, title: "Renamed" }]);
  assert.equal(await editedJournal.noteState(reviewed), "changed");

  // Another saved note now owns the recording.
  const moved = collection([voice("v1")]);
  const movedJournal = journalWorld(moved).journal;
  const original = await reviewedRow(moved, "v1");
  moved.store.replace([voice("v9", original.audioId)]);
  assert.equal(await movedJournal.noteState(original), "changed");

  // A reset collection never matches the reviewed source.
  const reset = collection([]);
  const resetJournal = createNotesRecordingDeletionJournal({
    read: async () => null,
    edit: async () => {},
    readSavedNotes: async () => reset.raw(),
  });
  assert.equal(await resetJournal.noteState(original), "changed");
  const unreadable = createNotesRecordingDeletionJournal({
    read: async () => null,
    edit: async () => {},
    readSavedNotes: async () => null,
  });
  await assert.rejects(
    unreadable.noteState(original),
    /Notes readback unavailable/,
  );
});

test("the deletion lock is exclusive and refuses work without Web Locks", async () => {
  const requests = [];
  const locks = {
    async request(name, options, callback) {
      requests.push([name, options]);
      return callback({ name });
    },
  };
  const withLock = createNotesDeletionLock(
    "product.notes-effects.v1",
    () => locks,
  );
  assert.equal(await withLock(async () => 7), 7);
  const signal = new AbortController().signal;
  await withLock(async () => 0, signal);
  assert.deepEqual(requests, [
    ["product.notes-effects.v1", { mode: "exclusive" }],
    ["product.notes-effects.v1", { mode: "exclusive", signal }],
  ]);
  const missing = createNotesDeletionLock("x", () => undefined);
  let ran = false;
  await assert.rejects(
    missing(async () => {
      ran = true;
    }),
    /requires Web Locks/,
  );
  assert.equal(ran, false);
});

test("claims hold a shared lock per started row and see only other views' claims", async () => {
  const held = new Set();
  const releases = [];
  const locks = {
    request(name, options, callback) {
      assert.equal(options.mode, "shared");
      held.add(name);
      return callback({ name }).then(() => {
        held.delete(name);
        releases.push(name);
      });
    },
    async query() {
      return { held: [...held].map((name) => ({ name })), pending: [] };
    },
  };
  const mine = createNotesDeletionClaims("product.claim:", () => locks);
  const other = createNotesDeletionClaims("product.claim:", () => locks);
  mine.claim("op-1");
  mine.claim("op-1");
  assert.deepEqual([...held], ["product.claim:op-1"]);
  assert.equal(await mine.claimedElsewhere("op-1"), false, "own claim");
  assert.equal(await other.claimedElsewhere("op-1"), true);
  assert.equal(await other.claimedElsewhere("op-2"), false);
  mine.release("op-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(releases, ["product.claim:op-1"]);
  assert.equal(await other.claimedElsewhere("op-1"), false);
  // Without Web Locks nothing is claimed and nothing is reported as claimed.
  const none = createNotesDeletionClaims("p:", () => undefined);
  none.claim("op-3");
  assert.equal(await none.claimedElsewhere("op-3"), false);
});
