import assert from "node:assert/strict";
import test from "node:test";
import { maintainNotesTrash } from "../src/client/notes-trash-maintenance.ts";
import { createNotesTrashPolicy } from "../src/client/notes-trash-policy.ts";

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 7, 12);
const policy = createNotesTrashPolicy({
  retentionMs: 3 * DAY,
  maxEntries: 100,
  maxBytes: 1024 * 1024,
  kinds: ["text", "voice"],
  recordingKind: "voice",
});
function host(entries, live = [], purge = async () => true) {
  let doc = { version: 1, entries },
    locks = 0,
    edits = 0;
  const calls = [];
  return {
    policy,
    calls,
    get doc() {
      return doc;
    },
    get locks() {
      return locks;
    },
    get edits() {
      return edits;
    },
    read: async () => structuredClone(doc),
    edit: async (update) => {
      edits++;
      doc = update(structuredClone(doc));
    },
    liveNoteIds: async () => new Set(live),
    withLock: async (work) => {
      locks++;
      return work();
    },
    purge: async (entry) => {
      calls.push(entry.id);
      return purge(entry);
    },
  };
}
const row = (id, noteId, deletedAt, extra = {}) => ({
  id,
  note: { id: noteId, kind: "text", title: noteId },
  index: 0,
  deletedAt,
  ...extra,
});

test("an idle pass takes no lock and writes nothing", async () => {
  const h = host([row("op-1", "a", t0)]);
  assert.deepEqual(await maintainNotesTrash(h, t0 + DAY), {
    removed: [],
    retained: [],
  });
  assert.equal(h.locks, 0);
  assert.equal(h.edits, 0);
});

test("stale rows go without purging; expired rows purge before removal; failures are retained", async () => {
  const voice = {
    id: "op-3",
    note: {
      id: "c",
      kind: "voice",
      title: "c",
      audio: { audioId: "rec" },
    },
    audio: { audioId: "rec" },
    index: 0,
    deletedAt: t0,
  };
  const h = host(
    [
      row("op-1", "a", t0),
      row("op-2", "b", t0),
      voice,
      row("op-4", "d", t0 + 2 * DAY),
    ],
    ["a"],
    async (entry) => {
      if (entry.id === "op-3") throw Error("recording busy");
      return true;
    },
  );
  const result = await maintainNotesTrash(h, t0 + 3 * DAY);
  assert.deepEqual(result, { removed: ["op-1", "op-2"], retained: ["op-3"] });
  assert.deepEqual(h.calls, ["op-2", "op-3"]);
  assert.deepEqual(
    h.doc.entries.map((e) => e.id),
    ["op-3", "op-4"],
  );
  // Repeating with the same clock only retries the retained purge.
  const again = await maintainNotesTrash(h, t0 + 3 * DAY);
  assert.deepEqual(again, { removed: [], retained: ["op-3"] });
  assert.equal(h.edits, 1);
});
