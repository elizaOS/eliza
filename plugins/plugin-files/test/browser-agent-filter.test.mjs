import assert from "node:assert/strict";
import test from "node:test";
import { installFilesBrowserAdapter } from "../src/browser/files-browser-adapter.ts";

test("a cold file open waits for Files to render and survives its first reload", async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = previousDocument;
  });
  const view = { render: () => ({}) };
  let active = false;
  const api = { isActive: () => active, set() {}, toast() {} };
  const reload = Promise.withResolvers();
  const select = Promise.withResolvers();
  const committed = Promise.withResolvers();
  const accepted = [];
  const forgotten = [];
  const ready = { status: "ready", access: "granted" };
  let reads = 0;
  const runner = installFilesBrowserAdapter(
    view,
    async (_module, file) => accepted.push(file.selectionId),
    () => {},
    {
      storage: {
        storageState: async () => (++reads === 1 ? reload.promise : ready),
        storageCategory: async () => ({ status: "ready", count: 0 }),
        storageTrashList: async () => ({ status: "ready", items: [] }),
        storageWatch: async () => ({ status: "ready" }),
        storageUnwatch: async () => ({}),
        storageSelect: async () => select.promise,
        addListener: async () => ({ remove: async () => {} }),
      },
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async (id) => forgotten.push(id),
    },
  );
  const open = async () => {
    await committed.promise;
    active = true;
    view.render({}, api);
    return true;
  };
  const op = { type: "files_open", path: "Download/statement.pdf" };
  const outcome = runner.run(op, new AbortController().signal, open);
  assert.equal(reads, 0, "do not read storage before the committed view");
  committed.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, "agent admission has an independent storage read");
  select.resolve({ status: "selected", selectionId: "statement" });
  assert.equal((await outcome).status, "succeeded");
  assert.deepEqual(accepted, ["statement"]);
  assert.deepEqual(forgotten, []);
  reload.resolve(ready);
  await new Promise((resolve) => setImmediate(resolve));
  view.onLeave();
});

for (const phase of ["selection", "preview"])
  test(`an agent file open retired during ${phase} cannot report a current preview`, async (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = new EventTarget();
    t.after(() => {
      globalThis.document = previousDocument;
    });
    const view = { render: () => ({}) };
    const selection = Promise.withResolvers();
    const selecting = Promise.withResolvers();
    const preview = Promise.withResolvers();
    const previewStarted = Promise.withResolvers();
    const accepted = [];
    const forgotten = [];
    const runner = installFilesBrowserAdapter(
      view,
      async (_module, file) => {
        accepted.push(file.selectionId);
        previewStarted.resolve();
        await preview.promise;
      },
      () => {},
      {
        storage: {
          storageState: async () => ({ status: "ready", access: "granted" }),
          storageCategory: async () => ({ status: "ready", count: 0 }),
          storageTrashList: async () => ({ status: "ready", items: [] }),
          storageWatch: async () => ({ status: "ready" }),
          storageUnwatch: async () => ({}),
          storageSelect: async () => {
            selecting.resolve();
            return selection.promise;
          },
          addListener: async () => ({ remove: async () => {} }),
        },
        createInlineModal: () => ({ ref() {} }),
        menuFocus: () => null,
        forgetSelected: async (id) => forgotten.push(id),
      },
    );
    view.render({}, { isActive: () => true, set() {}, toast() {} });
    await new Promise((resolve) => setImmediate(resolve));
    const controller = new AbortController();
    const outcome = runner.run(
      { type: "files_open", path: "Download/statement.pdf" },
      controller.signal,
    );
    await selecting.promise;
    if (phase === "selection") controller.abort();
    selection.resolve({ status: "selected", selectionId: "late-statement" });
    if (phase === "preview") {
      await previewStarted.promise;
      controller.abort();
      preview.resolve();
    }
    assert.equal((await outcome).status, "failed");
    assert.deepEqual(accepted, phase === "preview" ? ["late-statement"] : []);
    // Once accepted, the host owns preview cleanup and the shared runner does not release twice.
    assert.deepEqual(
      forgotten,
      phase === "selection" ? ["late-statement"] : [],
    );
    view.onLeave();
  });

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
        storageTrashList: async () => ({ status: "ready", items: [] }),
        storageWatch: async () => watched.resolve(),
        storageQuery() {
          if (++queries > 1)
            return Promise.resolve({
              status: "ready",
              entries: [],
              truncated: false,
            });
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
    truncated: false,
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
