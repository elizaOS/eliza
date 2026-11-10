import assert from "node:assert/strict";
import test from "node:test";
import { BrowserStorageVolume } from "../src/browser/storage-volume.ts";

const KEY = ".browser-files-trash";

/** A root with one file, plus the host library the volume drives. */
function harness(journal) {
  const rows = new Map([["root", []]]);
  const add = (parentId, row) =>
    rows.set(parentId, [...(rows.get(parentId) ?? []), row]);
  add("root", {
    id: "r-b",
    parentId: "root",
    name: "b.pdf",
    mimeType: "application/pdf",
    directory: false,
    size: 3,
    revision: "1",
  });
  let seq = 0;
  const library = {
    async list({ id }) {
      return {
        folder: { id: id ?? "root", name: "", directory: true },
        entries: rows.get(id ?? "root") ?? [],
      };
    },
    async createFolder({ id, name }) {
      const folder = {
        id: `f-${++seq}`,
        parentId: id,
        name,
        mimeType: "",
        directory: true,
        size: 0,
        revision: "1",
      };
      add(id, folder);
      rows.set(folder.id, []);
      return { folder };
    },
    async place({ id, destinationId, name }) {
      const row = (rows.get("root") ?? []).find((entry) => entry.id === id);
      rows.set(
        "root",
        (rows.get("root") ?? []).filter((entry) => entry.id !== id),
      );
      add(destinationId, { ...row, parentId: destinationId, name });
    },
    async delete() {},
  };
  const store = new Map(journal === undefined ? [] : [[KEY, journal]]);
  const volume = new BrowserStorageVolume(
    library,
    { trashFolder: ".trash", trashKey: KEY },
    () => {},
    () => 1000,
    {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
  );
  return { volume, store, rows };
}

const origin = {
  name: "a.pdf",
  origin: "",
  deletedAt: 1,
  directory: false,
  mimeType: "application/pdf",
  size: 3,
};

test("an unreadable trash record rejects a trash and keeps the file in place", async () => {
  const written = JSON.stringify({ old1: origin });
  const { volume, store, rows } = harness(written.slice(0, 40));
  await assert.rejects(
    volume.trash(["b.pdf"]),
    /trash record could not be read/,
  );
  assert.equal(store.get(KEY), written.slice(0, 40));
  assert.ok(rows.get("root").some((row) => row.name === "b.pdf"));
});

test("an unreadable trash record rejects the trash listing", async () => {
  const { volume } = harness("[1,2]");
  await assert.rejects(volume.trashList(), /trash record could not be read/);
});

test("an absent trash record starts empty", async () => {
  const { volume, store } = harness(undefined);
  const result = await volume.trash(["b.pdf"]);
  assert.equal(result.outcomes[0].status, "trashed");
  assert.equal(Object.keys(JSON.parse(store.get(KEY))).length, 1);
});

test("a readable trash record keeps the origins of earlier items", async () => {
  const { volume, store } = harness(JSON.stringify({ old1: origin }));
  const result = await volume.trash(["b.pdf"]);
  assert.equal(result.outcomes[0].status, "trashed");
  assert.deepEqual(JSON.parse(store.get(KEY)).old1, origin);
});
