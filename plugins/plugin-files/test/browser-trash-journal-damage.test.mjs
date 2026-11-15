/**
 * A Trash journal that cannot be parsed is damage, not an empty Trash.
 *
 * `records()` answers `{}` for an absent journal, an unparseable one and one
 * whose top level is not an object. `trashList()` then reports an empty Trash
 * and, at the end of the listing, writes that `{}` back — so one glance at
 * Trash destroys every restore origin the journal held. The adapter already
 * renders `status: "failed"` as "Trash could not be read."; it just never sees
 * a failure today.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserStorageVolume } from "../src/browser/storage-volume.ts";

const KEY = "files.trash";
const NAMESPACE = { trashFolder: ".trash", trashKey: KEY };
const CORRUPT = '{"trash-1":{"name":"a.pdf","origin":"Docs","deletedAt":';

function memoryStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

/** No Trash folder: only the journal decides what Trash knows about. */
const library = { list: async () => ({ folder: {}, entries: [] }) };

function volume(store) {
  return new BrowserStorageVolume(
    library,
    NAMESPACE,
    () => {},
    () => 1_700_000_000_000,
    store,
  );
}

test("an unreadable trash journal fails the listing and is left untouched", async () => {
  const store = memoryStore({ [KEY]: CORRUPT });
  await assert.rejects(volume(store).trashList(), /trash journal/i);
  assert.equal(
    store.values.get(KEY),
    CORRUPT,
    "a failed listing must not rewrite the damaged journal",
  );
});

test("the storage surface reports unreadable trash instead of ready-with-no-items", async () => {
  const store = memoryStore({ [KEY]: CORRUPT });
  const result = await volume(store).run("storageTrashList", {});
  assert.equal(result.status, "failed");
});

test("an absent journal still reads as an empty Trash", async () => {
  const store = memoryStore();
  assert.deepEqual(await volume(store).trashList(), { items: [] });
});
