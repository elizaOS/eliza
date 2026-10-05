import assert from "node:assert/strict";
import test from "node:test";
import { AsyncNotesStore } from "../src/client/notes-async-store.ts";
import { SecureNotesStore } from "../src/client/notes-secure-store.ts";
import { NotesCommitUncertain, NotesStore } from "../src/client/notes-store.ts";

const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};
const config = {
  current: "host.notes.v2",
  legacy: "host.notes.v1",
  daily: "host.daily",
  secureSlot: "host.encrypted",
};
const note = { id: "note", kind: "text", title: "Keep", body: "Exact content" };
test("host-configured notes migrate without destroying legacy bytes and fence stale editors", async () => {
  const storage = memory(),
    legacy = JSON.stringify([note]);
  storage.setItem(config.legacy, legacy);
  const first = new NotesStore(config, storage),
    second = new NotesStore(config, storage);
  const other = new NotesStore(
    { ...config, current: "other.v2", legacy: "other.v1" },
    storage,
  );
  assert.deepEqual(other.list, []);
  assert.equal(storage.getItem(config.legacy), legacy);
  const target = await first.target(note.id);
  first.replace([{ ...note, body: "New body" }]);
  assert.throws(() => second.replace([note]), /changed in another view/);
  await assert.rejects(
    first.execute(
      { type: "notes_read_selected", target },
      "read",
      new AbortController().signal,
      () => {},
    ),
    /revision changed/,
  );
  assert.equal(first.list[0].body, "New body");
});
test("encrypted migration retains originals when acknowledgement is lost and recovers by readback", async () => {
  const storage = memory(),
    legacy = JSON.stringify([note]);
  storage.setItem(config.legacy, legacy);
  let saved = null,
    lose = true;
  const slots = [];
  const vault = {
    read: async (key) => {
      slots.push(key);
      return structuredClone(saved);
    },
    compareExchange: async (key, expected, value) => {
      slots.push(key);
      assert.deepEqual(saved, expected);
      saved = structuredClone(value);
      if (lose) {
        lose = false;
        throw Error("lost response");
      }
      return { status: "saved" };
    },
  };
  await assert.rejects(
    SecureNotesStore.open(config, vault, storage),
    NotesCommitUncertain,
  );
  assert.equal(storage.getItem(config.legacy), legacy);
  const restored = await SecureNotesStore.open(config, vault, storage);
  assert.deepEqual(restored.list, [note]);
  assert.equal(storage.getItem(config.legacy), null);
  assert.equal(
    slots.every((slot) => slot === config.secureSlot),
    true,
  );
  await restored.replace([{ ...note, body: "Saved once" }]);
  assert.equal(
    (await SecureNotesStore.open(config, vault, storage)).list[0].body,
    "Saved once",
  );
});
test("encrypted compare-exchange rejection faults the editor without overwriting another writer", async () => {
  let saved = null,
    reject = false;
  const storage = memory();
  const vault = {
    read: async () => structuredClone(saved),
    compareExchange: async (_key, expected, value) => {
      if (reject) return { status: "conflict" };
      assert.deepEqual(saved, expected);
      saved = structuredClone(value);
      return { status: "saved" };
    },
  };
  const notes = await SecureNotesStore.open(config, vault, storage, [note]);
  reject = true;
  await assert.rejects(
    notes.replace([{ ...note, body: "Unsaved" }]),
    /another view/,
  );
  assert.equal(notes.needsRecovery, true);
  assert.equal(JSON.parse(saved.currentRaw).records[0].body, "Exact content");
  await assert.rejects(notes.target(note.id), /another view/);
});

test("a delayed current-state read cannot race the same editor's delete and undo", async () => {
  let saved = null,
    pauseRead = false,
    releaseRead,
    readStarted;
  let writes = 0;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  const vault = {
    read: async () => {
      const snapshot = structuredClone(saved);
      if (pauseRead) {
        pauseRead = false;
        readStarted();
        await new Promise((resolve) => {
          releaseRead = resolve;
        });
      }
      return snapshot;
    },
    compareExchange: async (_key, expected, next) => {
      assert.deepEqual(saved, expected);
      saved = structuredClone(next);
      writes++;
      return { status: "saved" };
    },
  };
  const notes = await SecureNotesStore.open(config, vault, memory(), [note]);
  pauseRead = true;
  const read = notes.assertCurrent();
  await started;
  const before = writes;
  const deletion = notes.replace([]);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(
      writes,
      before,
      "commit waits for the in-flight consistency read",
    );
  } finally {
    releaseRead();
    await Promise.allSettled([read, deletion]);
  }
  await Promise.all([read, deletion]);
  await notes.replace([note]);
  assert.equal(notes.needsRecovery, false);
  assert.deepEqual(
    (await SecureNotesStore.open(config, vault, memory())).list,
    [note],
  );
});

test("a genuine external change during a consistency read still fences queued edits", async () => {
  let saved = null,
    pauseRead = false,
    releaseRead,
    readStarted;
  let writes = 0;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  const vault = {
    read: async () => {
      if (pauseRead) {
        pauseRead = false;
        readStarted();
        await new Promise((resolve) => {
          releaseRead = resolve;
        });
      }
      return structuredClone(saved);
    },
    compareExchange: async (_key, expected, next) => {
      if (JSON.stringify(saved) !== JSON.stringify(expected))
        return { status: "conflict" };
      saved = structuredClone(next);
      writes++;
      return { status: "saved" };
    },
  };
  const notes = await SecureNotesStore.open(config, vault, memory(), [note]);
  pauseRead = true;
  const read = notes.assertCurrent();
  await started;
  const external = { ...note, body: "Another editor's exact content" };
  saved.currentRaw = JSON.stringify({
    ...JSON.parse(saved.currentRaw),
    records: [external],
  });
  const before = writes;
  const edit = notes.replace([]);
  const rejected = Promise.all([
    assert.rejects(read, /changed in another view/),
    assert.rejects(edit, /changed in another view/),
  ]);
  releaseRead();
  await rejected;
  assert.equal(notes.needsRecovery, true);
  assert.equal(writes, before);
  assert.deepEqual(JSON.parse(saved.currentRaw).records, [external]);
});
test("a host update to other daily fields after an interrupted migration does not lock Notes", async () => {
  const storage = memory();
  const dailyNote = {
    id: "daily",
    kind: "text",
    title: "Today",
    body: "Daily",
  };
  storage.setItem(
    config.daily,
    JSON.stringify({ notes: [dailyNote], receipts: ["r1"] }),
  );
  let saved = null,
    lose = true;
  const vault = {
    read: async () => structuredClone(saved),
    compareExchange: async (_key, expected, value) => {
      assert.deepEqual(saved, expected);
      saved = structuredClone(value);
      if (lose) {
        lose = false;
        throw Error("lost response");
      }
      return { status: "saved" };
    },
  };
  // The encrypted write lands but its acknowledgement is lost: open stops
  // before cleanup and the plaintext daily notes are still there.
  await assert.rejects(
    SecureNotesStore.open(config, vault, storage),
    NotesCommitUncertain,
  );
  // Meanwhile the host updates another field of its daily record.
  storage.setItem(
    config.daily,
    JSON.stringify({ notes: [dailyNote], receipts: ["r1", "r2"] }),
  );
  await SecureNotesStore.open(config, vault, storage);
  // The migrated notes are cleared; the host's other fields are kept.
  assert.deepEqual(JSON.parse(storage.getItem(config.daily)), {
    notes: [],
    receipts: ["r1", "r2"],
  });
  // A daily record whose notes changed since migration is still refused.
  storage.setItem(
    config.daily,
    JSON.stringify({ notes: [{ ...dailyNote, body: "Edited" }], receipts: [] }),
  );
  await assert.rejects(
    SecureNotesStore.open(config, vault, storage),
    /Legacy Notes changed during migration/,
  );
});

function documentFixture() {
  const initial = new NotesStore(config, memory(), [note]);
  let saved = { revision: 1, raw: initial.raw },
    writes = 0;
  const persistence = {
    read: async () => structuredClone(saved),
    raw: (value) => value.raw,
    compareExchange: async (expected, raw, signal) => {
      signal?.throwIfAborted();
      if (JSON.stringify(saved) !== JSON.stringify(expected)) return null;
      saved = { revision: saved.revision + 1, raw };
      writes++;
      return structuredClone(saved);
    },
  };
  return {
    persistence,
    read: () => structuredClone(saved),
    writes: () => writes,
    revise: () => {
      saved = { ...saved, revision: saved.revision + 1 };
    },
  };
}
test("asynchronous Notes fence competing editors without losing the committed snapshot", async () => {
  const f = documentFixture(),
    a = await AsyncNotesStore.load(config, f.persistence),
    b = await AsyncNotesStore.load(config, f.persistence);
  const results = await Promise.allSettled([
    a.replace([{ ...note, body: "A" }]),
    b.replace([{ ...note, body: "B" }]),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(f.writes(), 1);
  assert.equal(b.needsRecovery, true);
  assert.equal(
    b.list[0].body,
    "B",
    "uncommitted editor text remains recoverable",
  );
  const reopened = await AsyncNotesStore.load(config, f.persistence);
  assert.equal(reopened.list[0].body, "A");
  assert.deepEqual(await reopened.target(note.id), await a.target(note.id));
});
test("queued Notes saves settle before a target can authorize a read", async () => {
  const f = documentFixture(),
    store = await AsyncNotesStore.load(config, f.persistence);
  const first = store.replace([{ ...note, body: "First" }]),
    second = store.replace([{ ...note, body: "Second" }]);
  const target = await store.target(note.id);
  await Promise.all([first, second]);
  assert.equal(f.writes(), 2);
  const result = await store.execute(
    { type: "notes_read_selected", target },
    "read",
    new AbortController().signal,
    () => {},
  );
  assert.equal(result.fields.body, "Second");
});
test("Notes deletion retains exact operation tombstones and collection identity", async () => {
  const f = documentFixture(),
    store = await AsyncNotesStore.load(config, f.persistence),
    target = await store.target(note.id);
  const result = await store.execute(
    { type: "notes_delete", target },
    "delete-operation",
    new AbortController().signal,
    () => {},
  );
  const envelope = JSON.parse(f.read().raw);
  assert.equal(result.sourceId, target.sourceId);
  assert.equal(envelope.collectionId, target.sourceId);
  assert.deepEqual(envelope.records, []);
  assert.deepEqual(envelope.deleted, [
    { id: note.id, revision: target.revision, operationId: "delete-operation" },
  ]);
});
test("a lost CAS response faults Notes without replaying its committed edit", async () => {
  const f = documentFixture(),
    write = f.persistence.compareExchange;
  f.persistence.compareExchange = async (...args) => {
    await write(...args);
    throw Error("Lost response");
  };
  const store = await AsyncNotesStore.load(config, f.persistence);
  await assert.rejects(
    store.replace([{ ...note, body: "Saved once" }]),
    NotesCommitUncertain,
  );
  assert.equal(store.needsRecovery, true);
  assert.throws(() => store.replace([note]), NotesCommitUncertain);
  assert.equal(f.writes(), 1);
  assert.equal(
    (await AsyncNotesStore.load(config, f.persistence)).list[0].body,
    "Saved once",
  );
});
for (const mode of ["cancel", "retire"])
  test(`Notes recheck ${mode} after preparing an edit and before CAS`, async () => {
    const f = documentFixture(),
      store = await AsyncNotesStore.load(config, f.persistence),
      before = store.raw,
      target = await store.target(note.id),
      controller = new AbortController();
    await assert.rejects(
      store.execute(
        {
          type: "notes_update",
          target,
          fields: { title: "New", body: "Edited" },
        },
        "edit",
        controller.signal,
        () => {
          if (store.raw !== before) {
            if (mode === "cancel") controller.abort();
            else throw Error("Owner retired");
          }
        },
      ),
    );
    assert.equal(f.writes(), 0);
    assert.equal(f.read().raw, before);
    assert.equal(store.needsRecovery, true);
  });
test("unchanged bytes at another document revision still invalidate a Notes editor", async () => {
  const f = documentFixture(),
    store = await AsyncNotesStore.load(config, f.persistence);
  f.revise();
  await assert.rejects(store.assertCurrent(), /changed in another view/);
  assert.throws(() => store.replace([note]), /changed in another view/);
  assert.equal(f.writes(), 0);
});
test("a mismatched acknowledgement cannot claim the proposed Notes edit was saved", async () => {
  const f = documentFixture();
  f.persistence.compareExchange = async () => f.read();
  const store = await AsyncNotesStore.load(config, f.persistence);
  await assert.rejects(
    store.replace([{ ...note, body: "Not saved" }]),
    NotesCommitUncertain,
  );
  assert.equal(store.needsRecovery, true);
  assert.equal(JSON.parse(f.read().raw).records[0].body, note.body);
});
test("loading a missing document does not invent Notes or migrate host data", async () => {
  const f = documentFixture();
  f.persistence.read = async () => null;
  await assert.rejects(
    AsyncNotesStore.load(config, f.persistence),
    /Notes document is missing/,
  );
  assert.equal(f.writes(), 0);
});
