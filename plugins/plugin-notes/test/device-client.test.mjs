import assert from "node:assert/strict";
import test from "node:test";
import {
  DocumentNotesStore,
  NotesDocumentConflict,
} from "../src/client/notes-document-store.ts";
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

function documents(currentRaw = null, legacyRaw = null) {
  let saved = null;
  let revision = 0;
  const port = {
    initialize: async (create) => {
      if (saved === null)
        saved = {
          revision: String(++revision),
          raw: create(currentRaw, legacyRaw),
        };
      return structuredClone(saved);
    },
    read: async () => structuredClone(saved),
    compareExchange: async (expected, raw) => {
      if (JSON.stringify(expected) !== JSON.stringify(saved))
        throw new NotesDocumentConflict("Notes changed in another view");
      saved = { revision: String(++revision), raw };
      return structuredClone(saved);
    },
  };
  return port;
}
test("async document initialization preserves one collection and exact installed records", async () => {
  const legacy = JSON.stringify([note]),
    port = documents(null, legacy);
  const [a, b] = await Promise.all([
    DocumentNotesStore.open(port),
    DocumentNotesStore.open(port),
  ]);
  assert.equal(a.raw, b.raw);
  assert.deepEqual(a.list, [note]);
  const saved = await port.read();
  await a.replace(a.list);
  assert.deepEqual(
    await port.read(),
    saved,
    "unchanged draft does not advance authority",
  );
  assert.deepEqual(await a.target(note.id), await b.target(note.id));
});
test("simultaneous async editors admit one complete snapshot and preserve the losing draft", async () => {
  const port = documents(),
    a = await DocumentNotesStore.open(port, [note]),
    b = await DocumentNotesStore.open(port);
  const results = await Promise.allSettled([
    a.replace([{ ...note, body: "First" }]),
    b.replace([{ ...note, body: "Second" }]),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(JSON.parse((await port.read()).raw).records.length, 1);
  const loser = results[0].status === "rejected" ? a : b;
  assert.equal(loser.needsRecovery, true);
  assert.equal(
    loser.list[0].body,
    results[0].status === "rejected" ? "First" : "Second",
  );
  await assert.rejects(loser.target(note.id), NotesDocumentConflict);
});
test("lost async commit acknowledgement cannot replay a delete or lose its tombstone", async () => {
  const port = documents(),
    store = await DocumentNotesStore.open(port, [note]);
  const target = await store.target(note.id),
    exchange = port.compareExchange;
  port.compareExchange = async (...args) => {
    await exchange(...args);
    throw Error("Lost reply");
  };
  await assert.rejects(
    store.execute(
      { type: "notes_delete", target },
      "delete-once",
      new AbortController().signal,
      () => {},
    ),
    NotesCommitUncertain,
  );
  assert.equal(store.needsRecovery, true);
  const reopened = await DocumentNotesStore.open(port);
  assert.deepEqual(reopened.list, []);
  assert.deepEqual(JSON.parse(reopened.raw).deleted, [
    { id: note.id, revision: target.revision, operationId: "delete-once" },
  ]);
  assert.throws(() => store.replace([note]), NotesCommitUncertain);
});
test("queued optimistic drafts persist in order and targets wait for their final commit", async () => {
  const port = documents(),
    store = await DocumentNotesStore.open(port, [note]),
    exchange = port.compareExchange;
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  port.compareExchange = async (...args) => {
    port.compareExchange = exchange;
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return exchange(...args);
  };
  const first = store.replace([{ ...note, body: "First" }]);
  await ready;
  const second = store.replace([{ ...note, body: "Second" }]);
  let targetSettled = false;
  const target = store.target(note.id).then((value) => {
    targetSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(targetSettled, false);
  release();
  await Promise.all([first, second]);
  await target;
  assert.equal(JSON.parse((await port.read()).raw).records[0].body, "Second");
});
test("async read refuses a changed document even when its bytes return to the prior value", async () => {
  const port = documents(),
    store = await DocumentNotesStore.open(port, [note]),
    old = await port.read();
  await port.compareExchange(old, old.raw);
  await assert.rejects(store.assertCurrent(), NotesDocumentConflict);
  assert.equal(store.needsRecovery, true);
});
test("async operations stop before write when authorization changes during preparation", async () => {
  const port = documents(),
    store = await DocumentNotesStore.open(port, [note]),
    target = await store.target(note.id),
    before = await port.read();
  let checks = 0;
  await assert.rejects(
    store.execute(
      {
        type: "notes_update",
        target,
        fields: { title: "Changed", body: "Body" },
      },
      "edit",
      new AbortController().signal,
      () => {
        if (++checks > 2) throw Error("Retired owner");
      },
    ),
    /Retired owner/,
  );
  assert.deepEqual(await port.read(), before);
});
test("async readback failure faults the store and preserves the committed revision for reopening", async () => {
  const port = documents(),
    store = await DocumentNotesStore.open(port, [note]),
    exchange = port.compareExchange,
    read = port.read;
  port.compareExchange = async (...args) => {
    const saved = await exchange(...args);
    port.read = async () => {
      throw Error("Read unavailable");
    };
    return saved;
  };
  await assert.rejects(
    store.replace([{ ...note, body: "Saved" }]),
    NotesCommitUncertain,
  );
  assert.equal(store.needsRecovery, true);
  port.read = read;
  assert.equal((await DocumentNotesStore.open(port)).list[0].body, "Saved");
});
