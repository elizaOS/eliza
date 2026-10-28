import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotesRecordingDeletionJournal,
  leasedDeletionRow,
  PERMANENT_DELETION_LEASE_MS,
} from "../src/client/notes-recording-deletion.ts";
import { createNotesRecordingEffects } from "../src/client/notes-recording-effects.ts";
import { NotesStore } from "../src/client/notes-store.ts";

const OP = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OP2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const voice = (id, audioId = `audio-${id}`) => ({
  id,
  kind: "voice",
  title: `Recording ${id}`,
  audio: { audioId, noteId: id },
});

/** Saved Notes, a journal slot and a recording store, all in memory. */
function world(records = [voice("v1"), voice("v2")]) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const notes = new NotesStore(
    { current: "saved", legacy: "legacy" },
    storage,
    records,
  );
  const state = {
    journal: null,
    now: 1_000_000,
    calls: [],
    failRemove: false,
    failEdit: false,
  };
  const audio = new Map(
    records
      .filter((note) => note.audio)
      .map((note) => [
        note.audio.audioId,
        { noteId: note.id, deletedAt: null, receipts: new Map(), gone: false },
      ]),
  );
  const own = (input) => {
    const entry = audio.get(input.audioId);
    if (!entry || entry.gone || entry.noteId !== input.noteId)
      throw Error("Recording not owned");
    return entry;
  };
  const recordings = {
    async describe({ audioId }) {
      const entry = audio.get(audioId);
      if (!entry || entry.gone) throw Error("Recording missing");
      return {
        audioId,
        noteId: entry.noteId,
        ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
      };
    },
    async remove(input) {
      state.calls.push(["remove", input.operationId]);
      if (state.failRemove) throw Error("Native remove failed");
      const entry = own(input);
      entry.deletedAt = state.now;
      entry.receipts.set(input.operationId, "removed");
    },
    async restore(input) {
      state.calls.push(["restore", input.operationId]);
      const entry = own(input);
      entry.deletedAt = null;
      entry.receipts.set(input.operationId, "restored");
    },
    async purge(input) {
      state.calls.push(["purge", input.operationId]);
      const entry = own(input);
      entry.gone = true;
      entry.receipts.set(input.operationId, "purged");
      return { ...input, status: "purged" };
    },
    async deletionStatus(input) {
      const entry = audio.get(input.audioId);
      return {
        ...input,
        status: entry?.receipts.get(input.operationId) ?? "unknown",
      };
    },
  };
  const journal = createNotesRecordingDeletionJournal({
    read: async () => structuredClone(state.journal),
    async edit(change) {
      const next = change(structuredClone(state.journal));
      if (state.failEdit) throw Error("Store busy");
      state.journal = structuredClone(next);
    },
    readSavedNotes: async () => values.get("saved"),
  });
  const effects = createNotesRecordingEffects({
    recordings,
    journal,
    savedNotes: async () => notes.list,
    now: () => state.now,
  });
  const reviewed = async (id, operationId = OP, extra = {}) => {
    const note = notes.list.find((row) => row.id === id);
    return {
      id: operationId,
      target: await notes.target(id),
      note,
      audioId: note.audio.audioId,
      ...extra,
    };
  };
  const commitDelete = (row) =>
    notes.execute(
      { type: "notes_delete", target: row.target },
      row.id,
      new AbortController().signal,
      () => {},
    );
  return {
    notes,
    state,
    audio,
    journal,
    effects,
    reviewed,
    commitDelete,
  };
}

test("an approved deletion trashes note and recording together under one operation", async () => {
  const w = world();
  const note = w.notes.list[0];
  const target = await w.notes.target("v1");
  const trash = [];
  const result = await w.effects.trashWithRecording({
    note,
    target,
    operationId: OP,
    async addTrashEntry(audio) {
      assert.deepEqual(await w.journal.pending(), {}, "Trash row first");
      trash.push(audio);
    },
    async commit() {
      assert.ok((await w.journal.pending())[OP], "recovery row before commit");
      return w.commitDelete({ id: OP, target });
    },
  });
  assert.equal(result.kind, "notes_delete");
  assert.deepEqual(trash, [{ audioId: "audio-v1" }]);
  assert.ok(w.audio.get("audio-v1").deletedAt, "recording in audio trash");
  assert.equal(w.audio.get("audio-v1").receipts.get(OP), "removed");
  assert.deepEqual(await w.journal.pending(), {}, "row retired");
});

test("a failed commit retires only a provably unchanged row; a later failure keeps it", async () => {
  const w = world();
  const target = await w.notes.target("v1");
  await assert.rejects(
    w.effects.trashWithRecording({
      note: w.notes.list[0],
      target,
      operationId: OP,
      addTrashEntry: async () => {},
      commit: async () => {
        throw Error("commit refused");
      },
    }),
    /commit refused/,
  );
  assert.deepEqual(await w.journal.pending(), {});
  assert.equal(w.audio.get("audio-v1").deletedAt, null);

  // The recording move fails after the tombstone committed: the deletion stands for review.
  w.state.failRemove = true;
  await w.effects.trashWithRecording({
    note: w.notes.list[0],
    target,
    operationId: OP2,
    addTrashEntry: async () => {},
    commit: () => w.commitDelete({ id: OP2, target }),
  });
  assert.deepEqual(Object.keys(await w.journal.pending()), [OP2]);
  assert.equal((await w.journal.pending())[OP2].audioRequested, true);
  assert.equal(w.audio.get("audio-v1").deletedAt, null);
});

test("a recording already gone or under review is never moved again", async () => {
  const w = world();
  const target = await w.notes.target("v1");
  w.audio.get("audio-v1").deletedAt = 5;
  const trash = [];
  let commits = 0;
  await w.effects.trashWithRecording({
    note: w.notes.list[0],
    target,
    operationId: OP,
    addTrashEntry: async (audio) => {
      trash.push(audio);
    },
    commit: async () => {
      commits++;
    },
  });
  assert.deepEqual(trash, [undefined], "only the note goes to Trash");
  assert.equal(commits, 1);
  assert.deepEqual(await w.journal.pending(), {});
  assert.deepEqual(w.state.calls, []);
  // A non-UUID operation id never owns a recording move.
  w.audio.get("audio-v1").deletedAt = null;
  await w.effects.trashWithRecording({
    note: w.notes.list[0],
    target,
    operationId: "agent-op",
    addTrashEntry: async (audio) => {
      trash.push(audio);
    },
    commit: async () => {},
  });
  assert.deepEqual(trash, [undefined, undefined]);
  // An unconfirmed deletion of the same note must be reviewed first.
  await w.journal.change(await w.reviewed("v1", OP2), true);
  await assert.rejects(
    w.effects.trashWithRecording({
      note: w.notes.list[0],
      target,
      operationId: OP,
      addTrashEntry: async () => assert.fail("no Trash row"),
      commit: async () => assert.fail("no commit"),
    }),
    /needs review first/,
  );
});

test("Trash purge erases only recordings no saved note or recovery row still holds", async () => {
  const w = world();
  const row = await w.reviewed("v1");
  const entry = {
    id: OP,
    note: row.note,
    target: row.target,
    audio: { audioId: row.audioId },
  };
  assert.equal(
    await w.effects.purgeTrashed({
      id: "t",
      note: { id: "t1", kind: "text", title: "" },
    }),
    true,
  );
  // The note is still saved: never erased.
  assert.equal(await w.effects.purgeTrashed(entry), false);
  await w.commitDelete(row);
  await w.journal.change(row, true);
  assert.equal(
    await w.effects.purgeTrashed(entry),
    false,
    "a recovery row covers it",
  );
  await w.journal.change(row, false);
  w.audio.get("audio-v1").noteId = "v1";
  assert.equal(await w.effects.purgeTrashed(entry), true);
  assert.equal(w.audio.get("audio-v1").gone, true);
  await assert.rejects(
    w.effects.purgeTrashed({ ...entry, target: undefined }),
    /no recording/,
  );
});

test("erase forever needs this operation's own removal and no saved reference", async () => {
  const w = world();
  const row = await w.reviewed("v1");
  await assert.rejects(
    w.effects.eraseForever(row),
    /Audio operation unconfirmed/,
  );
  await w.commitDelete(row);
  w.audio.get("audio-v1").deletedAt = 7;
  w.audio.get("audio-v1").receipts.set(OP, "removed");
  w.notes.replace([...w.notes.list, voice("v9", "audio-v1")]);
  await assert.rejects(
    w.effects.eraseForever(row),
    /references this recording/,
  );
  w.notes.replace(w.notes.list.filter((note) => note.id !== "v9"));
  await w.effects.eraseForever(row);
  assert.equal(w.audio.get("audio-v1").receipts.get(OP), "purged");
  w.state.calls.length = 0;
  await w.effects.eraseForever(row);
  assert.deepEqual(w.state.calls, [], "an erased recording is only confirmed");
});

test("an interrupted permanent deletion finishes or rolls back from readback only", async () => {
  // Tombstone committed, recording never moved: trash it under this operation, erase, retire.
  {
    const w = world();
    const row = await w.reviewed("v1", OP, { permanent: true });
    await w.journal.change(row, true);
    await w.commitDelete(row);
    assert.equal(
      await w.effects.settleInterrupted(row, async () =>
        assert.fail("no commit"),
      ),
      "trash-then-erase",
    );
    assert.equal(w.audio.get("audio-v1").gone, true);
    assert.deepEqual(await w.journal.pending(), {});
  }
  // Recording moved but the note never deleted: give the recording back.
  {
    const w = world();
    const row = await w.reviewed("v1", OP, { permanent: true });
    await w.journal.change(row, true);
    w.audio.get("audio-v1").deletedAt = 3;
    w.audio.get("audio-v1").receipts.set(OP, "removed");
    assert.equal(
      await w.effects.settleInterrupted(row, async () =>
        assert.fail("no commit"),
      ),
      "restore-recording",
    );
    assert.equal(w.audio.get("audio-v1").deletedAt, null);
    assert.deepEqual(await w.journal.pending(), {});
  }
  // Recording erased by this operation, reviewed note still saved: commit its tombstone.
  {
    const w = world();
    const row = await w.reviewed("v1", OP, { permanent: true });
    await w.journal.change(row, true);
    w.audio.get("audio-v1").deletedAt = 3;
    w.audio.get("audio-v1").receipts.set(OP, "purged");
    let committed = 0;
    assert.equal(
      await w.effects.settleInterrupted(row, async (settled) => {
        committed++;
        return w.commitDelete(settled);
      }),
      "delete-note",
    );
    assert.equal(committed, 1);
    assert.deepEqual(await w.journal.pending(), {});
  }
  // The note changed since review: nothing is touched and the row stays.
  {
    const w = world();
    const row = await w.reviewed("v1", OP, { permanent: true });
    await w.journal.change(row, true);
    w.notes.replace(
      w.notes.list.map((note) =>
        note.id === "v1" ? { ...note, title: "Edited" } : note,
      ),
    );
    assert.equal(
      await w.effects.settleInterrupted(row, async () =>
        assert.fail("no commit"),
      ),
      "review",
    );
    assert.deepEqual(w.state.calls, []);
    assert.deepEqual(Object.keys(await w.journal.pending()), [OP]);
  }
});

test("a status pass settles only unclaimed rows and retires confirmed ones", async () => {
  const w = world();
  const permanent = await w.reviewed("v1", OP, { permanent: true });
  await w.journal.change(permanent, true);
  await w.commitDelete(permanent);
  const options = (startedHere, claimed) => ({
    startedHere,
    claimedElsewhere: async () => claimed,
    commitDeletion: async () => assert.fail("no commit"),
  });
  assert.equal(
    await w.effects.reconcile(permanent, options(false, true)),
    false,
  );
  assert.deepEqual(w.state.calls, [], "another live view's row is left alone");
  // Started here: the pass only confirms; the recording has not moved yet.
  assert.equal(
    await w.effects.reconcile(permanent, options(true, false)),
    false,
  );
  assert.equal(
    await w.effects.reconcile(permanent, options(false, false)),
    true,
  );
  assert.equal(w.audio.get("audio-v1").gone, true);

  // A Trash deletion whose recording moved: its receipt is confirmed and the row retired.
  const trashed = await w.reviewed("v2", OP2);
  await w.journal.change(trashed, true);
  await w.commitDelete(trashed);
  w.audio.get("audio-v2").deletedAt = 9;
  await assert.rejects(
    w.effects.reconcile(trashed, options(true, false)),
    /Audio operation unconfirmed/,
    "a move without this operation's receipt stays under review",
  );
  w.audio.get("audio-v2").receipts.set(OP2, "removed");
  assert.equal(await w.effects.reconcile(trashed, options(true, false)), true);
  assert.deepEqual(await w.journal.pending(), {});
});

test("rows under review stay leased and a failed renewal waits for the next pass", async () => {
  const w = world();
  const row = await w.reviewed("v1");
  await w.journal.change(row, true);
  await w.effects.renewLeases();
  assert.deepEqual((await w.journal.pending())[OP].lease, {
    until: w.state.now + PERMANENT_DELETION_LEASE_MS,
  });
  const leased = (await w.journal.pending())[OP];
  w.state.now += PERMANENT_DELETION_LEASE_MS / 4;
  await w.effects.renewLeases();
  assert.deepEqual((await w.journal.pending())[OP], leased, "not yet due");
  w.state.now += PERMANENT_DELETION_LEASE_MS / 2;
  w.state.failEdit = true;
  await w.effects.renewLeases();
  assert.deepEqual((await w.journal.pending())[OP], leased, "kept as it was");
  w.state.failEdit = false;
  await w.effects.renewLeases();
  assert.deepEqual(
    (await w.journal.pending())[OP],
    leasedDeletionRow(row, w.state.now),
  );
});
