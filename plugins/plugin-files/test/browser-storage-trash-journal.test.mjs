import assert from "node:assert/strict";
import test from "node:test";

const { BrowserStorageVolume } = await import(
  "../src/browser/storage-volume.ts"
);

const TRASH_KEY = "files-test-trash";

/** The one localStorage key the trash journal lives in, in memory. */
function memoryStore() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    size: () => values.size,
  };
}

/** Just enough of the file library for trash and trash-list to walk folders. */
function fakeLibrary() {
  const rows = new Map([["root", { id: "root", parentId: "", name: "" }]]);
  const put = (row) => {
    const next = {
      directory: false,
      size: 4,
      mimeType: "text/plain",
      revision: "r1",
      ...row,
    };
    rows.set(next.id, next);
    return next;
  };
  return {
    put,
    file: (name) => put({ id: `file-${name}`, parentId: "root", name }),
    async list({ id = "root" } = {}) {
      const folder = rows.get(id);
      if (!folder) throw Error("No such folder");
      return {
        folder,
        entries: [...rows.values()].filter((row) => row.parentId === id),
      };
    },
    async createFolder({ id, name }) {
      put({ id: `folder-${name}`, parentId: id, name, directory: true });
    },
    async move({ id, destinationId }) {
      const row = rows.get(id);
      if (!row) throw Error("No such row");
      rows.set(id, { ...row, parentId: destinationId, revision: "r2" });
    },
    async place({ id, destinationId, name }) {
      await this.move({ id, destinationId });
      rows.set(id, { ...rows.get(id), name });
    },
  };
}

const volumeOver = (library, store) =>
  new BrowserStorageVolume(
    library,
    { trashFolder: ".trash", trashKey: TRASH_KEY },
    () => {},
    () => 1_700_000_000_000,
    store,
  );

/** A journal that cannot be read is a failure, not an empty trash. */
test("an unreadable trash journal fails the listing instead of emptying it", async () => {
  const library = fakeLibrary();
  library.file("notes.txt");
  const store = memoryStore();
  const volume = volumeOver(library, store);

  assert.equal(
    (await volume.run("storageTrash", { paths: ["notes.txt"] })).status,
    "ready",
  );
  // Torn write or quota-truncated value: the journal is there but unparsable.
  store.setItem(TRASH_KEY, "{not json");

  const listed = await volume.run("storageTrashList", {});
  assert.notEqual(
    listed.status,
    "ready",
    `trash list answered ${JSON.stringify(listed)} instead of a failure`,
  );
  assert.equal(store.getItem(TRASH_KEY), "{not json");
});

/** Trashing must not overwrite the records of what is already trashed. */
test("trashing with an unreadable journal refuses instead of overwriting it", async () => {
  const library = fakeLibrary();
  library.file("first.txt");
  library.file("second.txt");
  const store = memoryStore();
  const volume = volumeOver(library, store);

  await volume.run("storageTrash", { paths: ["first.txt"] });
  store.setItem(TRASH_KEY, "{not json");

  const trashed = await volume.run("storageTrash", { paths: ["second.txt"] });
  assert.notEqual(trashed.status, "ready");
  assert.equal(store.getItem(TRASH_KEY), "{not json");
});

/** "Never trashed anything" stays a legitimate empty trash. */
test("a volume with no journal yet still lists an empty trash", async () => {
  const store = memoryStore();
  const listed = await volumeOver(fakeLibrary(), store).run(
    "storageTrashList",
    {},
  );
  assert.equal(listed.status, "ready");
  assert.deepEqual(listed.items, []);
});
