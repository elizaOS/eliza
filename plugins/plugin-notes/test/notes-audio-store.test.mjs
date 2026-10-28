// Device-local voice-note recordings: ownership, two-phase deletion receipts and expiry.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotesAudioStore,
  NOTES_AUDIO_RETENTION_MS,
  notesAudioMetadata,
} from "../src/client/notes-audio-store.ts";

/** Minimal in-memory IndexedDB: one keyPath store, staged writes committed on completion. */
function memoryIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const open = (name) => {
    const request = {};
    later(() => {
      let db = databases.get(name);
      const fresh = !db;
      if (fresh) {
        db = { stores: new Map(), keyPaths: new Map() };
        databases.set(name, db);
      }
      const handle = {
        createObjectStore(store, { keyPath }) {
          db.stores.set(store, new Map());
          db.keyPaths.set(store, keyPath);
        },
        transaction(store) {
          const staged = new Map(
            [...db.stores.get(store)].map(([k, v]) => [k, { ...v }]),
          );
          const keyPath = db.keyPaths.get(store);
          let pending = 0;
          let done = false;
          const tx = {
            error: null,
            abort() {
              if (done) return;
              done = true;
              later(() => tx.onabort?.());
            },
            objectStore: () => objectStore,
          };
          const settle = () =>
            later(() => {
              if (done || pending) return;
              done = true;
              db.stores.set(store, staged);
              tx.oncomplete?.();
            });
          const run = (work) => {
            const req = {};
            pending++;
            later(() => {
              if (done) return;
              req.result = work();
              pending--;
              req.onsuccess?.();
              settle();
            });
            return req;
          };
          const objectStore = {
            get: (key) =>
              run(() => (staged.has(key) ? { ...staged.get(key) } : undefined)),
            put: (value) => run(() => staged.set(value[keyPath], { ...value })),
            add: (value) =>
              run(() => {
                if (staged.has(value[keyPath])) throw Error("ConstraintError");
                staged.set(value[keyPath], { ...value });
              }),
            openCursor() {
              const keys = [...staged.keys()];
              let index = 0;
              const req = {};
              const step = () =>
                run(() => {
                  const key = keys[index++];
                  req.result =
                    key === undefined
                      ? null
                      : {
                          value: { ...staged.get(key) },
                          update: (value) => staged.set(key, { ...value }),
                          delete: () => staged.delete(key),
                          continue: () => {
                            step().onsuccess = () => req.onsuccess?.();
                          },
                        };
                  return req.result;
                });
              step().onsuccess = () => req.onsuccess?.();
              return req;
            },
          };
          return tx;
        },
      };
      request.result = handle;
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  };
  return { open };
}

const clip = () => ({
  blob: new Blob([new Uint8Array([0, 255, 128, 1])], { type: "audio/wav" }),
  durationMs: 1000,
});
const op = () => crypto.randomUUID();
const store = (now = () => 1_000) =>
  createNotesAudioStore({
    databaseName: "test.audio",
    indexedDB: memoryIndexedDB(),
    now,
  });

test("a host must name the database", () => {
  assert.throws(() => createNotesAudioStore({}), /database name/);
});

test("recordings keep their bytes and transcript, and metadata never carries the payload", async () => {
  const audio = store();
  const metadata = await audio.retainAudio("a1", "n1", "First", clip());
  assert.ok(!("blob" in metadata) && !("bytes" in metadata));
  await audio.retainAudio("a1", "n1", "Edited");
  const row = await audio.audioRecord("a1");
  assert.deepEqual(
    [...new Uint8Array(await row.blob.arrayBuffer())],
    [0, 255, 128, 1],
  );
  assert.equal(row.blob.type, "audio/wav");
  assert.equal(row.transcript, "Edited");
  assert.ok(!("blob" in notesAudioMetadata(row)));
});

test("a recording belongs to one note and needs a clip first", async () => {
  const audio = store();
  await assert.rejects(
    audio.retainAudio("a1", "n1", "Text"),
    /Record a clip first/,
  );
  await audio.retainAudio("a1", "n1", "Text", clip());
  await assert.rejects(audio.retainAudio("a1", "n2", "Text"), /not available/);
  await assert.rejects(audio.retainAudio("", "n1", "Text", clip()), /identity/);
  await assert.rejects(
    audio.retainAudio("a2", "n1", "x".repeat(64_001), clip()),
    /too long/,
  );
});

test("deletion is owned by one operation, idempotent and restorable", async () => {
  const audio = store();
  await audio.retainAudio("a1", "n1", "Text", clip());
  const first = op();
  await assert.rejects(
    audio.changeAudioDeleted("a1", "n1", true, "bad"),
    /operation/,
  );
  assert.equal(
    (await audio.changeAudioDeleted("a1", "n1", true, first)).status,
    "removed",
  );
  assert.equal(
    (await audio.changeAudioDeleted("a1", "n1", true, first)).status,
    "removed",
  );
  await assert.rejects(audio.audioRecord("a1"), /Restore this recording/);
  await assert.rejects(
    audio.changeAudioDeleted("a1", "n1", false, op()),
    /Another deletion/,
  );
  await assert.rejects(
    audio.changeAudioDeleted("a1", "n2", false, first),
    /another note/,
  );
  assert.equal(
    (await audio.changeAudioDeleted("a1", "n1", false, first)).status,
    "restored",
  );
  assert.equal(
    (await audio.audioDeletionStatus("a1", "n1", first)).status,
    "restored",
  );
  assert.equal((await audio.audioRecord("a1")).transcript, "Text");
});

test("purge erases only a recording this operation trashed, and is idempotent", async () => {
  const audio = store();
  await audio.retainAudio("a1", "n1", "Secret", clip());
  const deletion = op();
  await assert.rejects(
    audio.purgeAudio("a1", "n1", deletion),
    /not in this deletion/,
  );
  await audio.changeAudioDeleted("a1", "n1", true, deletion);
  assert.equal((await audio.purgeAudio("a1", "n1", deletion)).status, "purged");
  assert.equal((await audio.purgeAudio("a1", "n1", deletion)).status, "purged");
  const row = await audio.audioRecord("a1", true);
  assert.equal(row.transcript, "");
  assert.equal(row.blob.size, 0);
  await assert.rejects(
    audio.changeAudioDeleted("a1", "n1", false, deletion),
    /expired/,
  );
});

test("trashed recordings expire after the retention window", async () => {
  let clock = 1_000;
  const audio = store(() => clock);
  await audio.retainAudio("a1", "n1", "Old", clip());
  const deletion = op();
  await audio.changeAudioDeleted("a1", "n1", true, deletion);
  clock += NOTES_AUDIO_RETENTION_MS + 1;
  await assert.rejects(
    audio.changeAudioDeleted("a1", "n1", false, deletion),
    /expired/,
  );
  assert.deepEqual(await audio.migrateAudio(), {
    state: "complete",
    failedRecords: 0,
  });
  const row = await audio.audioRecord("a1", true);
  assert.equal(row.expired, true);
  assert.equal(row.transcript, "");
});

test("a saved recording keeps its clip; a different clip is refused, not dropped", async () => {
  const audio = store();
  await audio.retainAudio("a1", "n1", "First", clip());
  // The same capture saved again only updates the transcript.
  await audio.retainAudio("a1", "n1", "Again", clip());
  await assert.rejects(
    audio.retainAudio("a1", "n1", "Other", {
      blob: new Blob([new Uint8Array([9, 9, 9, 9])], { type: "audio/wav" }),
      durationMs: 1000,
    }),
    /already has a different clip/,
  );
  await assert.rejects(
    audio.retainAudio("a1", "n1", "Other", { ...clip(), durationMs: 2000 }),
    /already has a different clip/,
  );
  const row = await audio.audioRecord("a1");
  assert.equal(row.transcript, "Again");
  assert.deepEqual(
    [...new Uint8Array(await row.blob.arrayBuffer())],
    [0, 255, 128, 1],
  );
});

test("expiry leaves a recording a recovery row still covers", async () => {
  let clock = 1_000;
  const audio = store(() => clock);
  await audio.retainAudio("a1", "n1", "Covered", clip());
  await audio.retainAudio("a2", "n2", "Orphaned", clip());
  const covered = op();
  await audio.changeAudioDeleted("a1", "n1", true, covered);
  await audio.changeAudioDeleted("a2", "n2", true, op());
  clock += NOTES_AUDIO_RETENTION_MS + 1;
  assert.deepEqual(await audio.migrateAudio({ keep: [covered] }), {
    state: "complete",
    failedRecords: 0,
  });
  const kept = await audio.audioRecord("a1", true);
  assert.equal(kept.expired, undefined);
  assert.equal(kept.transcript, "Covered");
  assert.equal((await audio.audioRecord("a2", true)).expired, true);
  // Its deletion's owner still purges it.
  assert.equal((await audio.purgeAudio("a1", "n1", covered)).status, "purged");
});
