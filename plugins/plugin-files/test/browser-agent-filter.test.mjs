import assert from "node:assert/strict";
import test from "node:test";
import { installFilesBrowserAdapter } from "../src/browser/files-browser-adapter.ts";

test("a read-only filter retains its results during Files activation", async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = previousDocument;
  });

  let visible = false;
  const view = { render: () => ({}) };
  const api = {
    set() {},
    toast() {},
    isActive: () => visible,
    open() {
      visible = true;
      view.render({}, api);
    },
  };
  const ready = { status: "ready", access: "granted" };
  const stateReads = [Promise.withResolvers(), Promise.withResolvers()];
  const reloadStarted = Promise.withResolvers();
  const watched = Promise.withResolvers();
  const queryStarted = Promise.withResolvers();
  const query = Promise.withResolvers();
  const selected = [];
  let reads = 0;
  let queries = 0;
  const runner = installFilesBrowserAdapter(
    view,
    async (_module, file) => selected.push(file.selectionId),
    () => {},
    {
      storage: {
        storageState() {
          if (++reads === 2) reloadStarted.resolve();
          return stateReads[reads - 1].promise;
        },
        storageCategory: async () => ({ status: "ready", count: 0 }),
        storageList: async () => ({ status: "ready", entries: [] }),
        storageTrashList: async () => ({ status: "ready", items: [] }),
        storageWatch: async () => watched.resolve(),
        storageQuery() {
          if (++queries > 1) return Promise.resolve({ status: "ready" });
          queryStarted.resolve();
          return query.promise;
        },
        storageSelect: async ({ path }) => ({
          status: "selected",
          selectionId: path,
        }),
        addListener: async () => ({ remove: async () => {} }),
      },
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async () => {},
    },
  );
  view.render({}, api);

  const result = runner.run(
    { type: "files_filter", text: "statement" },
    new AbortController().signal,
  );
  await reloadStarted.promise;
  stateReads[0].resolve(ready);
  assert.equal(
    await Promise.race([queryStarted.promise.then(() => "query"), result]),
    "query",
  );

  stateReads[1].resolve(ready);
  await watched.promise;
  assert.equal(queries, 1, "reload must leave the explicit query in flight");

  query.resolve({
    status: "ready",
    entries: [
      {
        name: "bank statement.pdf",
        path: "bank statement.pdf",
        directory: false,
        mimeType: "application/pdf",
        size: 1,
        modified: 0,
      },
    ],
  });
  assert.deepEqual(await result, {
    status: "succeeded",
    summary: "Showing 1 item in Files.",
  });
  const rows = view.render({}, api).filterRows;
  assert.equal(rows.length, 1);
  rows[0].tap();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected, ["bank statement.pdf"]);
});

for (const [legacy, label] of [
  [true, "Allow storage access"],
  [false, "Allow all files access"],
  [undefined, "Allow all files access"],
]) {
  test(`storage permission label follows native legacy=${legacy}`, async (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = new EventTarget();
    t.after(() => {
      globalThis.document = previousDocument;
    });
    const view = { render: () => ({}) };
    const api = { set() {}, toast() {}, isActive: () => true };
    installFilesBrowserAdapter(
      view,
      async () => {},
      () => {},
      {
        storage: {
          storageState: async () => ({
            status: "ready",
            access: "denied",
            legacy,
          }),
          storageUnwatch: async () => {},
          addListener: async () => ({ remove: async () => {} }),
        },
        createInlineModal: () => ({ ref() {} }),
        menuFocus: () => null,
        forgetSelected: async () => {},
      },
    );
    view.render({}, api);
    await new Promise((resolve) => setImmediate(resolve));
    const denied = view.render({}, api).browse;
    assert.equal(denied.denied, true);
    assert.equal(denied.deniedLabel, label);
    view.onLeave();
  });
}

test("a denied folder read updates the permission label without a second state read", async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = previousDocument;
  });
  const view = { render: () => ({}) };
  const api = { set() {}, toast() {}, isActive: () => true };
  installFilesBrowserAdapter(
    view,
    async () => {},
    () => {},
    {
      storage: {
        storageState: async () => ({
          status: "ready",
          access: "granted",
          legacy: false,
          volumes: [{ id: "primary", name: "Internal storage", primary: true }],
        }),
        storageCategory: async () => ({ status: "ready", count: 0 }),
        storageTrashList: async () => ({ status: "ready", items: [] }),
        storageWatch: async () => ({}),
        storageUnwatch: async () => {},
        storageList: async () => ({
          status: "denied",
          access: "denied",
          legacy: true,
        }),
        addListener: async () => ({ remove: async () => {} }),
      },
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async () => {},
    },
  );
  view.render({}, api);
  await new Promise((resolve) => setImmediate(resolve));
  view.render({}, api).browse.allFiles();
  await new Promise((resolve) => setImmediate(resolve));
  const denied = view.render({}, api).browse;
  assert.equal(denied.denied, true);
  assert.equal(denied.deniedLabel, "Allow storage access");
  view.onLeave();
});

async function trashFixture(t) {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  const state = {};
  const calls = [];
  const rows = new Map([
    [
      undefined,
      [
        {
          id: "same-id",
          name: "Local.txt",
          origin: "",
          size: 4,
          mimeType: "text/plain",
          deletedAt: Date.now(),
        },
      ],
    ],
    [
      "external",
      [
        {
          id: "same-id",
          name: "External.txt",
          origin: "",
          size: 4,
          mimeType: "text/plain",
          deletedAt: Date.now(),
        },
      ],
    ],
  ]);
  const view = { render: () => ({}) };
  const api = {
    get: () => state,
    set: (patch) => Object.assign(state, patch),
    toast() {},
    isActive: () => true,
  };
  const apply = (action, input) => {
    calls.push({ action, ...input });
    rows.set(
      input.volume,
      rows.get(input.volume).filter((row) => !input.ids.includes(row.id)),
    );
    return {
      status: "ready",
      outcomes: input.ids.map((id) => ({ path: id, status: "restored" })),
    };
  };
  installFilesBrowserAdapter(
    view,
    async () => {},
    () => {},
    {
      storage: {
        storageState: async () => ({
          status: "ready",
          access: "granted",
          volumes: [
            { id: "primary", name: "Storage", primary: true },
            { id: "external", name: "External", primary: false },
          ],
        }),
        storageList: async () => ({ status: "ready", entries: [] }),
        storageCategory: async () => ({ status: "ready", count: 0 }),
        storageTrashList: async ({ volume } = {}) => ({
          status: "ready",
          items: rows.get(volume),
        }),
        storageRestore: async (input) => apply("restore", input),
        storageEmptyTrash: async (input) => apply("delete", input),
        storageWatch: async () => ({ status: "ready" }),
        storageUnwatch: async () => ({}),
        addListener: async () => ({ remove: async () => {} }),
      },
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async () => {},
    },
  );
  const render = () => view.render(state, api);
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };
  t.after(() => {
    view.onLeave();
    globalThis.document = previousDocument;
  });
  render();
  await settle();
  render().browse.openTrash();
  await settle();
  return { render, settle, calls, rows, document: globalThis.document };
}

test("deleted Files selection restores the selected volume even when trash IDs match", async (t) => {
  const f = await trashFixture(t);
  assert.equal(f.render().fd.name, "Recently deleted");
  assert.deepEqual(
    f.render().fd.menuRows.map((row) => row.id),
    ["select"],
  );
  assert.notEqual(f.render().fd.items[0].id, f.render().fd.items[1].id);
  f.render().fd.menuRows[0].go();
  f.render()
    .fd.items.find((row) => row.name === "External.txt")
    .tap();
  assert.equal(f.render().selCount, "1 selected");
  f.render().selRestore();
  await f.settle();
  assert.deepEqual(f.calls, [
    { action: "restore", ids: ["same-id"], volume: "external" },
  ]);
  assert.equal(f.rows.get(undefined).length, 1);
  assert.equal(f.render().isSel, false);
});

test("deleted Files cancellation has no effect and confirmation keeps its reviewed selection", async (t) => {
  const f = await trashFixture(t);
  f.render().fd.menuRows[0].go();
  f.render()
    .fd.items.find((row) => row.name === "Local.txt")
    .tap();
  f.render().selDel();
  assert.equal(f.render().dlg.title, "Delete permanently?");
  assert.equal(f.calls.length, 0);
  f.render().dlg.cancel();
  assert.equal(f.calls.length, 0);
  f.render().selDel();
  f.rows.get(undefined).push({
    id: "later",
    name: "Later.txt",
    origin: "",
    size: 1,
    mimeType: "text/plain",
    deletedAt: Date.now(),
  });
  f.render().dlg.confirm();
  await f.settle();
  assert.deepEqual(f.calls, [
    { action: "delete", ids: ["same-id"], confirmed: true },
  ]);
  assert.equal(f.rows.get(undefined)[0].id, "later");
  assert.equal(f.rows.get("external").length, 1);
});

test("refresh keeps only deleted Files that remain in the current listing selected", async (t) => {
  const f = await trashFixture(t);
  f.render().fd.menuRows[0].go();
  f.render().selAll();
  f.rows.set("external", []);
  f.document.dispatchEvent(new Event("visibilitychange"));
  await f.settle();
  assert.equal(f.render().selCount, "1 selected");
  f.render().selRestore();
  await f.settle();
  assert.deepEqual(f.calls, [{ action: "restore", ids: ["same-id"] }]);
});
