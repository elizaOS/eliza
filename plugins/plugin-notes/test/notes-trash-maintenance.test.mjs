import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotesStore } from "../src/client/notes-store.ts";
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

test("persisted deletion, restart, restore and expiry preserve live recordings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notes-trash-lifecycle-"));
  const notesFile = join(directory, "notes.json");
  const trashFile = join(directory, "trash.json");
  const audioFile = join(directory, "recording.wav");
  writeFileSync(notesFile, "{}");
  writeFileSync(trashFile, JSON.stringify(policy.empty()));
  const storage = {
    getItem: (key) => JSON.parse(readFileSync(notesFile, "utf8"))[key] ?? null,
    setItem: (key, value) =>
      writeFileSync(
        notesFile,
        JSON.stringify({
          ...JSON.parse(readFileSync(notesFile, "utf8")),
          [key]: value,
        }),
      ),
  };
  const open = () =>
    new NotesStore({ current: "notes", legacy: "legacy" }, storage);
  const read = async () =>
    policy.validate(JSON.parse(readFileSync(trashFile, "utf8")));
  let tail = Promise.resolve();
  const withLock = (work) => {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
  const edit = async (update) =>
    writeFileSync(trashFile, JSON.stringify(update(await read())));
  const voice = {
    id: "voice",
    kind: "voice",
    title: "Saved recording",
    audio: { audioId: "recording" },
  };
  const trash = async (id, at) =>
    withLock(async () => {
      const store = open();
      const entry = {
        id,
        note: store.list[0],
        index: 0,
        deletedAt: at,
        audio: { audioId: "recording" },
      };
      await edit((doc) => policy.add(doc, entry));
      store.replace([]);
    });
  const maintenance = {
    policy,
    read,
    edit,
    withLock,
    liveNoteIds: async () => new Set(open().list.map((note) => note.id)),
    purge: async () => {
      if (existsSync(audioFile)) unlinkSync(audioFile);
      return true;
    },
  };
  try {
    writeFileSync(audioFile, "retained recording bytes");
    open().replace([voice]);
    await trash("first-deletion", t0);
    assert.equal(open().list.length, 0);
    assert.deepEqual(await maintainNotesTrash(maintenance, t0 + DAY), {
      removed: [],
      retained: [],
    });
    assert.equal(readFileSync(audioFile, "utf8"), "retained recording bytes");
    // A restore can commit before a crash removes the Trash row. A fresh store sees it.
    await withLock(async () =>
      open().replace(policy.restore(open().list, (await read()).entries[0])),
    );
    assert.deepEqual(await maintainNotesTrash(maintenance, t0 + 3 * DAY), {
      removed: ["first-deletion"],
      retained: [],
    });
    assert.equal(open().list[0].id, "voice");
    assert.equal(existsSync(audioFile), true);
    await trash("second-deletion", t0 + 4 * DAY);
    // The recording is gone but committing removal of its row fails. Retry from disk.
    await assert.rejects(
      maintainNotesTrash(
        {
          ...maintenance,
          edit: async () => {
            throw Error("Interrupted commit");
          },
        },
        t0 + 7 * DAY,
      ),
      /Interrupted commit/,
    );
    assert.equal(existsSync(audioFile), false);
    assert.equal((await read()).entries[0].id, "second-deletion");
    assert.deepEqual(await maintainNotesTrash(maintenance, t0 + 7 * DAY), {
      removed: ["second-deletion"],
      retained: [],
    });
    assert.equal((await read()).entries.length, 0);
    assert.equal(open().list.length, 0);
    // A later host version lowers both limits below the already saved document.
    const prior = policy.add(
      policy.add(policy.empty(), row("old-1", "a", t0)),
      row("old-2", "b", t0),
    );
    writeFileSync(trashFile, JSON.stringify(prior));
    const narrower = createNotesTrashPolicy({
      retentionMs: DAY,
      maxEntries: 1,
      maxBytes: 32,
      kinds: ["text"],
    });
    assert.equal(narrower.sorted(await read()).length, 2);
    assert.equal(narrower.remove(await read(), ["old-1"]).entries.length, 1);
    assert.throws(() => narrower.add(prior, row("new", "c", t0)), /full/);
    assert.deepEqual(
      await maintainNotesTrash({ ...maintenance, policy: narrower }, t0 + DAY),
      { removed: ["old-2", "old-1"], retained: [] },
    );
    assert.equal((await read()).entries.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
