import assert from "node:assert/strict";
import test from "node:test";
import { createNotesTrashActions } from "../src/client/notes-trash-actions.ts";
import {
  createNotesTrashPolicy,
  isNotesTrashFull,
  NotesTrashFull,
} from "../src/client/notes-trash-policy.ts";

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 27, 12);
const note = (id, extra = {}) => ({ id, kind: "text", title: id, ...extra });

function world({ notes = [note("a"), note("b")], maxEntries = 10 } = {}) {
  const policy = createNotesTrashPolicy({
    retentionMs: 3 * DAY,
    maxEntries,
    maxBytes: 1024 * 1024,
    kinds: ["text", "voice"],
    recordingKind: "voice",
  });
  const state = {
    saved: structuredClone(notes),
    stored: structuredClone(notes),
    visible: structuredClone(notes),
    trash: { version: 1, entries: [] },
    now: t0,
    ready: true,
    commitOk: true,
    locked: 0,
    purged: [],
    purgeOk: true,
    commits: [],
    ids: 0,
  };
  const collection = {
    ready: () => state.ready,
    stored: () => structuredClone(state.stored),
    visible: () => structuredClone(state.visible),
    async commit(list, reason) {
      state.commits.push(reason);
      if (!state.commitOk) return false;
      state.saved = structuredClone(list);
      state.stored = structuredClone(list);
      state.visible = structuredClone(list);
      return true;
    },
  };
  const actions = createNotesTrashActions({
    policy,
    read: async () => structuredClone(state.trash),
    async edit(update) {
      assert.ok(state.locked > 0, "Trash edits happen under the lock");
      state.trash = update(structuredClone(state.trash));
      return state.trash;
    },
    savedNotes: async () => structuredClone(state.saved),
    async withLock(work) {
      state.locked++;
      try {
        return await work();
      } finally {
        state.locked--;
      }
    },
    async purge(entry) {
      state.purged.push(entry.id);
      return !entry.audio || state.purgeOk;
    },
    ownsContent: (n) => !!n.audio,
    now: () => state.now,
    operationId: () => `op-${++state.ids}`,
  });
  return { state, collection, actions, policy };
}

test("moving to Trash is write-ahead and removes only the confirmed note", async () => {
  const { state, collection, actions } = world();
  const outcome = await actions.moveToTrash(
    collection,
    note("a"),
    0,
    async () => ({
      noteId: "a",
      revision: "r1",
      sourceId: "s",
    }),
  );
  assert.equal(outcome.status, "moved");
  assert.deepEqual(
    state.saved.map((n) => n.id),
    ["b"],
  );
  assert.deepEqual(state.commits, ["remove"]);
  assert.deepEqual(state.trash.entries[0], {
    id: "op-1",
    note: note("a"),
    target: { noteId: "a", revision: "r1", sourceId: "s" },
    index: 0,
    deletedAt: t0,
  });
});

test("a stale view or a Trash change deletes nothing", async () => {
  const first = world();
  first.state.saved[0] = note("a", { body: "newer elsewhere" });
  assert.deepEqual(
    await first.actions.moveToTrash(first.collection, note("a"), 0),
    { status: "changed" },
  );
  assert.equal(first.state.trash.entries.length, 0);
  assert.equal(first.state.commits.length, 0);
  const second = world();
  second.state.stored[0] = note("a", { body: "unsaved" });
  assert.deepEqual(
    await second.actions.moveToTrash(second.collection, note("a"), 0),
    { status: "failed" },
  );
  const third = world();
  third.state.ready = false;
  assert.deepEqual(
    await third.actions.moveToTrash(third.collection, note("a"), 0),
    { status: "unavailable" },
  );
});

test("a full Trash refuses a restorable copy without touching the note", async () => {
  const { state, collection, actions } = world({ maxEntries: 1 });
  assert.equal(
    (await actions.moveToTrash(collection, note("a"), 0)).status,
    "moved",
  );
  assert.deepEqual(await actions.moveToTrash(collection, note("b"), 0), {
    status: "full",
  });
  assert.deepEqual(
    state.saved.map((n) => n.id),
    ["b"],
  );
  assert.equal(isNotesTrashFull(new NotesTrashFull()), true);
  assert.equal(isNotesTrashFull({ code: "storage-full" }), true);
  assert.equal(isNotesTrashFull(Error("Notes Trash is full")), false);
});

test("restore reinserts the exact copy once and never replaces a saved note", async () => {
  const { state, collection, actions } = world();
  await actions.moveToTrash(collection, note("a"), 0);
  assert.equal(await actions.restore(collection, "op-1"), "restored");
  assert.deepEqual(
    state.saved.map((n) => n.id),
    ["a", "b"],
  );
  assert.equal(state.trash.entries.length, 0);
  assert.equal(await actions.restore(collection, "op-1"), "gone");
  // A deletion that never committed leaves a stale row: restore just removes it.
  await actions.moveToTrash(collection, note("a"), 0);
  state.saved = [note("a"), note("b")];
  state.stored = structuredClone(state.saved);
  assert.equal(await actions.restore(collection, "op-2"), "live");
  assert.equal(state.trash.entries.length, 0);
});

test("restore respects retention, recordings and unconfirmed commits", async () => {
  const { state, collection, actions } = world({
    notes: [note("v", { kind: "voice", audio: { audioId: "rec" } }), note("b")],
  });
  await actions.moveToTrash(collection, state.saved[0], 0);
  state.trash.entries[0].audio = { audioId: "rec" };
  assert.equal(await actions.restore(collection, "op-1"), "owned-content");
  delete state.trash.entries[0].audio;
  state.commitOk = false;
  assert.equal(await actions.restore(collection, "op-1"), "unconfirmed");
  assert.equal(state.trash.entries.length, 1, "the row stays until restored");
  state.now = t0 + 3 * DAY;
  assert.equal(await actions.restore(collection, "op-1"), "expired");
});

test("erase purges owned content first and keeps what could not be erased", async () => {
  const { state, collection, actions } = world({
    notes: [
      note("v", { kind: "voice", audio: { audioId: "rec" } }),
      note("a"),
      note("b"),
    ],
  });
  await actions.moveToTrash(collection, state.saved[0], 0);
  state.trash.entries[0].audio = { audioId: "rec" };
  await actions.moveToTrash(collection, note("a"), 0);
  state.purgeOk = false;
  assert.deepEqual(await actions.erase("all"), {
    status: "settled",
    erased: 1,
    failed: 1,
  });
  assert.deepEqual(
    state.trash.entries.map((entry) => entry.id),
    ["op-1"],
  );
  state.purgeOk = true;
  assert.deepEqual(await actions.erase("op-1"), {
    status: "settled",
    erased: 1,
    failed: 0,
  });
  assert.deepEqual(await actions.erase("op-1"), {
    status: "settled",
    erased: 0,
    failed: 0,
  });
});

test("delete forever applies only to the exact refused note", async () => {
  const { state, collection, actions } = world({
    notes: [note("a"), note("v", { kind: "voice", audio: { audioId: "r" } })],
  });
  const snapshot = JSON.stringify(note("a"));
  assert.equal(
    await actions.deleteForever(
      collection,
      "a",
      JSON.stringify(note("a", { body: "older" })),
    ),
    "changed",
  );
  assert.equal(
    await actions.deleteForever(
      collection,
      "v",
      JSON.stringify(state.stored[1]),
    ),
    "owned-content",
  );
  state.saved[0] = note("a", { body: "edited elsewhere" });
  assert.equal(
    await actions.deleteForever(collection, "a", snapshot),
    "changed",
  );
  state.saved[0] = note("a");
  state.trash = {
    version: 1,
    entries: [{ id: "stale", note: note("a"), index: 0, deletedAt: t0 }],
  };
  assert.equal(
    await actions.deleteForever(collection, "a", snapshot),
    "deleted",
  );
  assert.deepEqual(
    state.saved.map((n) => n.id),
    ["v"],
  );
  assert.equal(state.trash.entries.length, 0, "no stale row offers it again");
  state.ready = false;
  assert.equal(
    await actions.deleteForever(collection, "v", "{}"),
    "unavailable",
  );
});
