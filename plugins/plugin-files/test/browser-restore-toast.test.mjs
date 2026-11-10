import assert from "node:assert/strict";
import test from "node:test";
import { installFilesBrowserAdapter } from "../src/browser/files-browser-adapter.ts";
import { BrowserStorageVolume } from "../src/browser/storage-volume.ts";

/** In-memory library with the contract BrowserStorageVolume wraps (see files.ts). */
function memoryLibrary() {
  let n = 0;
  const rows = new Map();
  const revision = () => `r${++n}`;
  const children = (id) => [...rows.values()].filter((r) => r.parentId === id);
  const mutate = ({ id, expectedRevision }, change) => {
    const row = rows.get(id);
    if (!row || row.revision !== expectedRevision)
      throw new Error("This file changed.");
    const next = change({ ...row });
    if (
      children(next.parentId).some((e) => e.id !== id && e.name === next.name)
    )
      throw new Error("Choose a different name.");
    rows.set(id, { ...next, revision: revision(), modifiedAt: 1_700_000_000 });
  };
  const library = {
    add(parentId, name, directory = false) {
      const id = `id${++n}`;
      rows.set(id, {
        id,
        parentId,
        name,
        directory,
        mimeType: directory ? "" : "application/pdf",
        size: directory ? 0 : 10,
        revision: revision(),
        modifiedAt: 1_700_000_000,
      });
      return id;
    },
    async list({ id }) {
      const folder =
        id && id !== "root" ? rows.get(id) : { id: "root", directory: true };
      if (!folder?.directory) throw new Error("Choose a folder.");
      return { folder, entries: children(folder.id).map((r) => ({ ...r })) };
    },
    async createFolder({ id, name }) {
      if (children(id).some((e) => e.name === name))
        throw new Error("Choose a different name.");
      library.add(id, name, true);
    },
    async rename(input) {
      mutate(input, (r) => ({ ...r, name: input.name }));
    },
    async move(input) {
      mutate(input, (r) => ({ ...r, parentId: input.destinationId }));
    },
    async place(input) {
      mutate(input, (r) => ({
        ...r,
        parentId: input.destinationId,
        name: input.name,
      }));
    },
    async delete({ id }) {
      rows.delete(id);
    },
    async usage() {
      return { bytes: 0, files: rows.size };
    },
  };
  return library;
}

function memoryStore() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

const METHODS = [
  "storageState",
  "storageRequestAccess",
  "storageList",
  "storageCategory",
  "storageQuery",
  "storageReviewedIdentities",
  "storageTransfer",
  "storageRename",
  "storageCreateFolder",
  "storageTrash",
  "storageTrashList",
  "storageRestore",
  "storageEmptyTrash",
  "storageShare",
  "storageSelect",
  "storageWatch",
  "storageUnwatch",
];

/** The browser host's storage port: every storage* call goes to the volume. */
function portOver(volume) {
  const port = Object.fromEntries(
    METHODS.map((method) => [
      method,
      (input = {}) => volume.run(method, input),
    ]),
  );
  port.addListener = async () => ({ remove: async () => {} });
  return port;
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

/** A Files screen over a Download folder that holds lease.pdf. */
function filesScreen(t, trashKey) {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  globalThis.HTMLElement ??= class {};
  t.after(() => {
    globalThis.document = previousDocument;
  });
  const library = memoryLibrary();
  const download = library.add("root", "Download", true);
  library.add(download, "lease.pdf");
  const volume = new BrowserStorageVolume(
    library,
    { trashFolder: ".trash", trashKey },
    () => {},
    Date.now,
    memoryStore(),
  );
  const toasts = [];
  const view = { render: () => ({}) };
  const api = {
    set() {},
    toast: (text, options) => toasts.push({ text, options }),
    isActive: () => true,
  };
  installFilesBrowserAdapter(
    view,
    async () => {},
    () => {},
    {
      storage: portOver(volume),
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async () => {},
    },
  );
  const screen = () => view.render({}, api);
  const names = async () =>
    (await volume.list("Download")).entries.map((e) => e.name).sort();
  return { library, download, volume, toasts, screen, names };
}

async function restoreFromTrashView(screen) {
  screen();
  await settle();
  screen().browse.openTrash();
  await settle();
  screen()
    .fd.items.find((item) => item.name === "lease.pdf")
    .tap({});
  screen().dlg.restore();
  await settle();
}

test("Undo after Move to Trash does not report a rename", async (t) => {
  const { toasts, screen, names } = filesScreen(t, "restore-toast-undo");
  screen();
  await settle();
  screen().browse.allFiles();
  await settle();
  screen()
    .fd.items.find((item) => item.name === "Download")
    .tap();
  await settle();
  screen()
    .fd.menuRows.find((row) => row.id === "select")
    .go();
  screen()
    .fd.items.find((item) => item.name === "lease.pdf")
    .tap();
  screen().selDel();
  await settle();
  const trashed = toasts.at(-1);
  assert.equal(trashed.text, "1 item moved to Trash");

  trashed.options.undo();
  await settle();

  assert.deepEqual(await names(), ["lease.pdf"]);
  assert.equal(toasts.at(-1).text, "Restored 1 item");
});

test("Restore from the Trash view does not report a rename", async (t) => {
  const { volume, toasts, screen, names } = filesScreen(
    t,
    "restore-toast-view",
  );
  await volume.trash(["Download/lease.pdf"]);

  await restoreFromTrashView(screen);

  assert.deepEqual(await names(), ["lease.pdf"]);
  assert.equal(toasts.at(-1).text, "Restored 1 item");
});

test("a restore that has to pick a free name still reports the rename", async (t) => {
  const { library, download, volume, toasts, screen, names } = filesScreen(
    t,
    "restore-toast-taken",
  );
  await volume.trash(["Download/lease.pdf"]);
  library.add(download, "lease.pdf");

  await restoreFromTrashView(screen);

  assert.deepEqual(await names(), ["lease (1).pdf", "lease.pdf"]);
  assert.equal(toasts.at(-1).text, "Restored 1 item · 1 renamed");
});
