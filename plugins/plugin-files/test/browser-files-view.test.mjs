import assert from "node:assert/strict";
import test from "node:test";

// A zone behind UTC: a local day and a UTC day differ every evening.
process.env.TZ = "America/Los_Angeles";
const { installFilesBrowserAdapter } = await import(
  "../src/browser/files-browser-adapter.ts"
);
const { filterMatches, filterTime } = await import(
  "../src/browser/storage-model.ts"
);

const tick = () => new Promise((resolve) => setImmediate(resolve));
const file = (path, mimeType, modified = 0) => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  directory: false,
  mimeType,
  size: 1,
  modified,
});
/** A granted Files view over `storage` overrides, with every storage call recorded. */
function files(t, storage = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  const calls = [],
    toasts = [],
    accepted = [],
    forgotten = [],
    undos = [];
  const preview = "__native_selected_document";
  const view = {
    render: (state) =>
      state.open === preview ? { isPreview: true, pv: {} } : {},
  };
  const api = {
    set() {},
    toast: (text, options) => {
      toasts.push(text);
      if (options?.undo) undos.push(options.undo);
    },
    isActive: () => true,
  };
  const base = {
    storageState: async () => ({
      status: "ready",
      access: "granted",
      volumes: [{ id: "primary", name: "Internal storage", primary: true }],
    }),
    storageCategory: async () => ({ status: "ready", count: 0 }),
    storageTrashList: async () => ({ status: "ready", items: [] }),
    storageList: async () => ({ status: "ready", entries: [] }),
    storageWatch: async () => ({ status: "ready" }),
    storageUnwatch: async () => ({}),
    storageSelect: async ({ path }) => ({
      status: "selected",
      selectionId: path,
    }),
    addListener: async () => ({ remove: async () => {} }),
    ...storage,
  };
  const recorded = Object.fromEntries(
    Object.entries(base).map(([name, call]) => [
      name,
      (input) => {
        calls.push([name, input]);
        return call(input);
      },
    ]),
  );
  const runner = installFilesBrowserAdapter(
    view,
    async (_module, selected) => accepted.push(selected.selectionId),
    () => {},
    {
      storage: recorded,
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async (id) => forgotten.push(id),
    },
  );
  t.after(() => {
    view.onLeave();
    globalThis.document = previousDocument;
  });
  return {
    runner,
    calls,
    toasts,
    accepted,
    forgotten,
    undos,
    preview,
    leave: () => view.onLeave(),
    render: (state = {}) => view.render(state, api),
    named: (name) => calls.filter(([call]) => call === name),
  };
}

test("a filter date without a time is that day on the device", () => {
  const evening = new Date(2026, 10, 9, 20, 0).getTime();
  const day = { from: "2026-11-09", to: "2026-11-09" };
  assert.equal(filterTime("2026-11-09"), new Date(2026, 10, 9).getTime());
  assert.equal(
    filterTime("2026-11-09", true),
    new Date(2026, 10, 10).getTime() - 1,
  );
  assert.equal(
    filterMatches(day, file("a.pdf", "application/pdf", evening)),
    true,
  );
  assert.equal(
    filterMatches(
      day,
      file("b.pdf", "application/pdf", evening - 24 * 3600 * 1000),
    ),
    false,
  );
  assert.equal(
    filterTime("2026-11-09T00:00:00Z"),
    Date.UTC(2026, 10, 9),
    "a date with a time and zone stays that instant",
  );
});

test("a file with no Files preview opens in another app; a PDF opens in the preview", async (t) => {
  const entries = [
    file("Movies/clip.mp4", "video/mp4"),
    file("Download/lease.pdf", "application/pdf"),
  ];
  const view = files(t, {
    storageList: async () => ({ status: "ready", entries }),
    storageOpen: async () => ({ status: "opened" }),
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  const rows = () => view.render().fd.items;
  rows()
    .find((row) => row.name === "clip.mp4")
    .tap();
  await tick();
  assert.deepEqual(view.named("storageOpen"), [
    ["storageOpen", { path: "Movies/clip.mp4" }],
  ]);
  assert.deepEqual(view.accepted, []);
  rows()
    .find((row) => row.name === "lease.pdf")
    .tap();
  await tick();
  assert.deepEqual(view.accepted, ["Download/lease.pdf"]);
  const { pv } = view.render({ open: view.preview });
  assert.equal(pv.canOpenWith, true);
  pv.openWith();
  await tick();
  assert.deepEqual(view.named("storageOpen").at(-1), [
    "storageOpen",
    { path: "Download/lease.pdf" },
  ]);
});

test("a tap during a listing refresh still opens the file", async (t) => {
  const refresh = Promise.withResolvers();
  let lists = 0;
  const entries = [file("Download/lease.pdf", "application/pdf")];
  const view = files(t, {
    storageList: async () =>
      ++lists === 1 ? { status: "ready", entries } : refresh.promise,
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  globalThis.document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  assert.equal(lists, 2, "the refresh is in flight");
  const out = view.render();
  assert.equal(out.toolbar.ready, true, "the toolbar stays during a refresh");
  out.fd.items[0].tap();
  await tick();
  assert.deepEqual(view.accepted, ["Download/lease.pdf"]);
  refresh.resolve({ status: "ready", entries });
  await tick();
});

test("Sort and view on Browse do not leave Browse", async (t) => {
  const view = files(t);
  view.render();
  await tick();
  const { toolbar } = view.render();
  assert.equal(toolbar.canSort, false);
  toolbar.sort();
  toolbar.toggleView();
  await tick();
  assert.deepEqual(view.named("storageList"), []);
  assert.equal(view.render().top, true);
});

test("a complete selection is shared once and changes use bounded storage calls", async (t) => {
  const entries = Array.from({ length: 1200 }, (_, index) =>
    file(`Download/${index}.txt`, "text/plain"),
  );
  entries[1199] = { ...entries[1199], directory: true };
  const view = files(t, {
    storageList: async () => ({ status: "ready", entries }),
    storageShare: async () => ({ status: "opened" }),
    storageTrash: async ({ paths }) => ({
      status: "ready",
      outcomes: paths.map((path) => ({ path, status: "trashed", to: path })),
    }),
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  view.render().selAll();
  view.render().selShare();
  await tick();
  assert.equal(view.named("storageShare").length, 1);
  assert.equal(view.named("storageShare")[0][1].paths.length, 1200);
  assert.deepEqual(
    view.named("storageShare")[0][1].paths,
    entries.map((entry) => entry.path),
    "selected folders must not disappear from the share request",
  );
  assert.deepEqual(view.toasts, []);
  view.render().selDel();
  await tick();
  assert.deepEqual(
    view.named("storageTrash").map(([, input]) => input.paths.length),
    [500, 500, 200],
  );
  assert.equal(view.toasts.at(-1), "1200 items moved to Trash");
});

test("a listing that is only part of the folder says so, and so does the filter", async (t) => {
  const entries = [file("Documents/a.pdf", "application/pdf", 2)];
  const view = files(t, {
    storageCategory: async ({ countOnly }) =>
      countOnly
        ? { status: "ready", count: 5312 }
        : { status: "ready", entries, count: 5312, truncated: true },
    storageQuery: async () => ({ status: "ready", entries, truncated: true }),
  });
  view.render();
  await tick();
  view
    .render()
    .browse.cats.find((row) => row.id === "documents")
    .go();
  await tick();
  assert.equal(view.render().fd.note, "Showing the newest 1 item of 5312.");
  assert.deepEqual(
    await view.runner.run(
      { type: "files_filter", kind: "pdf" },
      new AbortController().signal,
    ),
    {
      status: "failed",
      summary:
        "Files could not complete this search. Showing 1 item from the scanned folders.",
    },
  );
  assert.match(view.render().chip.label, /1\+$/);
});

test("the agent opens a shown filter result by its position, without its name", async (t) => {
  const entries = [
    file("Download/new.pdf", "application/pdf", 2),
    file("Download/old.pdf", "application/pdf", 1),
  ];
  const view = files(t, {
    storageQuery: async () => ({ status: "ready", entries, truncated: false }),
  });
  view.render();
  await tick();
  const signal = new AbortController().signal;
  const open = (shown) =>
    view.runner.run({ type: "files_open", shown }, signal);
  assert.equal((await open(1)).status, "failed", "no filter is shown yet");
  const shown = await view.runner.run(
    { type: "files_filter", kind: "pdf" },
    signal,
  );
  assert.equal(shown.summary, "Showing 2 items in Files.");
  assert.deepEqual(await open(2), {
    status: "succeeded",
    summary: "Opened the file in Files.",
  });
  assert.deepEqual(view.accepted, ["Download/old.pdf"]);
  assert.equal((await open(3)).status, "failed");
});

test("empty and loading states carry text", async (t) => {
  const listing = Promise.withResolvers();
  const view = files(t, { storageList: async () => listing.promise });
  assert.equal(view.render().browse.loading, true);
  await tick();
  view.render().browse.allFiles();
  await tick();
  assert.equal(view.render().fd.loading, true);
  assert.equal(view.render().fd.empty, false);
  listing.resolve({ status: "ready", entries: [] });
  await tick();
  const { fd } = view.render();
  assert.equal(fd.loading, false);
  assert.equal(fd.empty, true);
  assert.equal(fd.emptyText, "This folder is empty");
});

test("a filter is restored after both short and long visits away", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const view = files(t, {
    storageQuery: async () => ({
      status: "ready",
      entries: [file("Download/lease.pdf", "application/pdf")],
      truncated: false,
    }),
  });
  view.render();
  await tick();
  await view.runner.run(
    { type: "files_filter", kind: "pdf" },
    new AbortController().signal,
  );
  for (const [minutes, kept] of [
    [1, true],
    [11, true],
  ]) {
    view.leave();
    t.mock.timers.tick(minutes * 60 * 1000);
    view.render();
    await tick();
    assert.equal(!!view.render().chip, kept);
  }
});

test("a shown position cannot switch to a new filter while access is pending", async (t) => {
  const access = Promise.withResolvers();
  let holdNext = false;
  const ready = { status: "ready", access: "granted" };
  const view = files(t, {
    storageState: () => {
      if (holdNext) {
        holdNext = false;
        return access.promise;
      }
      return Promise.resolve(ready);
    },
    storageQuery: async ({ text }) => ({
      status: "ready",
      entries: [file(`Download/${text}.pdf`, "application/pdf")],
      truncated: false,
    }),
  });
  view.render();
  await tick();
  const signal = new AbortController().signal;
  await view.runner.run({ type: "files_filter", text: "first" }, signal);
  holdNext = true;
  const opening = view.runner.run({ type: "files_open", shown: 1 }, signal);
  await view.runner.run({ type: "files_filter", text: "replacement" }, signal);
  access.resolve(ready);
  assert.equal((await opening).status, "failed");
  assert.deepEqual(view.named("storageSelect"), []);
  assert.deepEqual(view.accepted, []);
});

test("a late shown grant is released when the displayed filter is replaced", async (t) => {
  const selected = Promise.withResolvers();
  const view = files(t, {
    storageQuery: async ({ text }) => ({
      status: "ready",
      entries: [file(`Download/${text}.pdf`, "application/pdf")],
      truncated: false,
    }),
    storageSelect: () => selected.promise,
  });
  view.render();
  await tick();
  const signal = new AbortController().signal;
  await view.runner.run({ type: "files_filter", text: "first" }, signal);
  const opening = view.runner.run({ type: "files_open", shown: 1 }, signal);
  await tick();
  await view.runner.run({ type: "files_filter", text: "replacement" }, signal);
  selected.resolve({ status: "selected", selectionId: "first-grant" });
  assert.equal((await opening).status, "failed");
  assert.deepEqual(view.accepted, []);
  assert.deepEqual(view.forgotten, ["first-grant"]);
});

test("leaving Files stops later batch admissions and retains the committed outcome", async (t) => {
  const first = Promise.withResolvers();
  const entries = Array.from({ length: 1200 }, (_, i) =>
    file(`Download/${i}.txt`, "text/plain"),
  );
  const view = files(t, {
    storageList: async () => ({ status: "ready", entries }),
    storageTrash: ({ paths }) =>
      view.named("storageTrash").length === 1
        ? first.promise
        : Promise.resolve({
            status: "ready",
            outcomes: paths.map((path) => ({
              path,
              status: "trashed",
              to: path,
            })),
          }),
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  view.render().selAll();
  view.render().selDel();
  await tick();
  const paths = view.named("storageTrash")[0][1].paths;
  view.leave();
  first.resolve({
    status: "ready",
    outcomes: paths.map((path) => ({ path, status: "trashed", to: path })),
  });
  await tick();
  assert.equal(view.named("storageTrash").length, 1);
  assert.ok(view.toasts.some((text) => text.includes("500 of 1200")));
});

test("a later unknown trash batch retains confirmed Undo without retrying unknown effects", async (t) => {
  const entries = Array.from({ length: 1200 }, (_, i) =>
    file(`Download/${i}.txt`, "text/plain"),
  );
  const view = files(t, {
    storageList: async () => ({ status: "ready", entries }),
    storageTrash: async ({ paths }) => {
      if (view.named("storageTrash").length === 2)
        throw Error("Lost acknowledgement");
      return {
        status: "ready",
        outcomes: paths.map((path) => ({ path, status: "trashed", to: path })),
      };
    },
    storageRestore: async ({ ids }) => ({
      status: "ready",
      outcomes: ids.map((path) => ({ path, status: "restored" })),
    }),
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  view.render().selAll();
  view.render().selDel();
  await tick();
  assert.equal(view.named("storageTrash").length, 2);
  assert.match(view.toasts.at(-1), /500 of 1200.*could not be confirmed/);
  assert.equal(view.undos.length, 1);
  view.undos[0]();
  await tick();
  assert.deepEqual(
    view.named("storageRestore").map(([, input]) => input.ids),
    [view.named("storageTrash")[0][1].paths],
  );
});

test("an incomplete or failed empty search never claims no matching files", async (t) => {
  for (const result of [
    { status: "ready", entries: [], truncated: true },
    { status: "unavailable", message: "Storage failed" },
  ]) {
    const view = files(t, { storageQuery: async () => result });
    view.render();
    await tick();
    const outcome = await view.runner.run(
      { type: "files_filter", kind: "pdf" },
      new AbortController().signal,
    );
    assert.equal(outcome.status, "failed");
    assert.equal(view.render().filterEmpty, false);
    assert.match(view.render().filterNote, /incomplete|could not read/);
    view.leave();
  }
});

test("overlapping Undo operations keep the toolbar disabled until both settle", async (t) => {
  const restore = [Promise.withResolvers(), Promise.withResolvers()];
  let trashCount = 0;
  const view = files(t, {
    storageList: async () => ({
      status: "ready",
      entries: [file("Download/a.txt", "text/plain")],
    }),
    storageTrash: async ({ paths }) => ({
      status: "ready",
      outcomes: paths.map((path) => ({
        path,
        status: "trashed",
        to: `trash-${++trashCount}`,
      })),
    }),
    storageRestore: () =>
      restore[view.named("storageRestore").length - 1].promise,
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  for (let i = 0; i < 2; i++) {
    view.render().selAll();
    view.render().selDel();
    await tick();
  }
  assert.equal(view.undos.length, 2);
  view.undos[0]();
  view.undos[1]();
  await tick();
  assert.equal(view.render().toolbar.disabled, true);
  restore[0].resolve({
    status: "ready",
    outcomes: [{ path: "trash-1", status: "restored", to: "Download/a.txt" }],
  });
  await tick();
  assert.equal(view.render().toolbar.disabled, true);
  restore[1].resolve({
    status: "ready",
    outcomes: [{ path: "trash-2", status: "restored", to: "Download/a.txt" }],
  });
  await tick();
  assert.equal(view.render().toolbar.disabled, false);
  assert.equal(view.toasts.at(-1), "Restored 1 item");
});

test("external opening refuses a malformed grant and releases a retired fallback grant", async (t) => {
  const held = Promise.withResolvers();
  let delayed = false;
  const entries = [file("Movies/clip.mp4", "video/mp4")];
  const view = files(t, {
    storageList: async () => ({ status: "ready", entries }),
    storageOpen: async () => (delayed ? held.promise : { status: "selected" }),
  });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  view.render().fd.items[0].tap();
  await tick();
  assert.deepEqual(view.accepted, []);
  assert.equal(view.toasts.at(-1), "This file could not open.");
  delayed = true;
  view.render().fd.items[0].tap();
  await tick();
  view.leave();
  held.resolve({ status: "selected", selectionId: "late-external-fallback" });
  await tick();
  assert.deepEqual(view.accepted, []);
  assert.deepEqual(view.forgotten, ["late-external-fallback"]);
});

test("legacy query completeness is unknown for both zero and 500 returned rows", async (t) => {
  const observations = [];
  for (const count of [0, 500]) {
    const entries = Array.from({ length: count }, (_, i) =>
      file(`Download/${i}.pdf`, "application/pdf"),
    );
    const view = files(t, {
      storageQuery: async () => ({ status: "ready", entries }),
    });
    view.render();
    await tick();
    const signal = new AbortController().signal;
    const outcome = await view.runner.run(
      { type: "files_filter", kind: "pdf" },
      signal,
    );
    const empty = view.render().filterEmpty;
    const opening = count
      ? await view.runner.run({ type: "files_open", shown: count }, signal)
      : undefined;
    observations.push({
      count,
      status: outcome.status,
      empty,
      returnedRowsRemainAccessible: opening?.status,
    });
    view.leave();
  }
  const malformed = files(t, {
    storageQuery: async () => ({ status: "ready", truncated: false }),
  });
  malformed.render();
  await tick();
  const outcome = await malformed.runner.run(
    { type: "files_filter", kind: "pdf" },
    new AbortController().signal,
  );
  observations.push({
    count: "missing-entries",
    status: outcome.status,
    empty: malformed.render().filterEmpty,
  });
  assert.deepEqual(observations, [
    {
      count: 0,
      status: "failed",
      empty: false,
      returnedRowsRemainAccessible: undefined,
    },
    {
      count: 500,
      status: "failed",
      empty: false,
      returnedRowsRemainAccessible: "succeeded",
    },
    { count: "missing-entries", status: "failed", empty: false },
  ]);
});

test("a revoked folder listing is denied rather than empty", async (t) => {
  let result = { status: "ready", entries: [] };
  const view = files(t, { storageList: async () => result });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  assert.equal(
    view.render().fd.empty,
    true,
    "an admitted successful empty listing",
  );
  result = { status: "denied", access: "denied" };
  globalThis.document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  const denied = view.render();
  assert.equal(denied.browse.denied, true);
  assert.equal(denied.fd.loading, false);
  assert.equal(denied.fd.empty, false, "a refused listing is not empty");
});

test("an unavailable access response is not a permission denial or an empty folder", async (t) => {
  let state = { status: "ready", access: "granted" };
  const view = files(t, { storageState: async () => state });
  view.render();
  await tick();
  view.render().browse.allFiles();
  await tick();
  state = { status: "unavailable", message: "Files closed." };
  globalThis.document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  const out = view.render();
  assert.equal(out.browse.unavailable, true);
  assert.equal(out.browse.denied, false);
  assert.equal(out.fd.loading, false);
  assert.equal(out.fd.empty, false);
});

test("a failed folder or Trash read exposes its error until a successful retry", async (t) => {
  let failure = true;
  const view = files(t, {
    storageList: async () =>
      failure ? { status: "unavailable" } : { status: "ready", entries: [] },
    storageTrashList: async () =>
      failure ? { status: "unavailable" } : { status: "ready", items: [] },
  });
  view.render();
  await tick();
  const assertFailure = (out, error) => {
    assert.equal(out.fd.loading, false);
    assert.equal(out.fd.empty, false);
    assert.equal(out.nativeTreeStatus, error);
  };
  view.render().browse.allFiles();
  await tick();
  assertFailure(view.render(), "Files could not be read.");
  view.render().fd.close();
  await tick();
  view.render().browse.openTrash();
  await tick();
  assertFailure(view.render(), "Trash could not be read.");
  failure = false;
  globalThis.document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  assert.equal(view.render().fd.empty, true);
  assert.equal(view.render().nativeTreeStatus, "");
});

test("unreadable secondary Trash keeps the visible list incomplete until it is read", async (t) => {
  let readable = false;
  const view = files(t, {
    storageState: async () => ({
      status: "ready",
      access: "granted",
      volumes: [
        { id: "primary", name: "Internal storage", primary: true },
        { id: "secondary", name: "External storage", primary: false },
      ],
    }),
    storageTrashList: async (input) =>
      input?.volume && !readable
        ? { status: "unavailable" }
        : { status: "ready", items: [] },
  });
  view.render();
  await tick();
  view.render().browse.openTrash();
  await tick();
  const incomplete = view.render();
  assert.equal(incomplete.fd.loading, false);
  assert.equal(incomplete.fd.empty, false);
  assert.equal(
    incomplete.nativeTreeStatus,
    "Some Trash locations could not be read.",
  );
  readable = true;
  globalThis.document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  assert.equal(view.render().fd.empty, true);
  assert.equal(view.render().nativeTreeStatus, "");
});

test("Downloads lists folders beside files from the actual Download directory", async (t) => {
  const view = files(t, {
    storageCategory: async () => ({ status: "ready", count: 1, entries: [] }),
    storageList: async () => ({
      status: "ready",
      entries: [
        {
          path: "Download/Receipts",
          name: "Receipts",
          directory: true,
          modified: 0,
        },
        file("Download/receipt.pdf", "application/pdf"),
      ],
    }),
  });
  view.render();
  await tick();
  view
    .render()
    .browse.cats.find((category) => category.id === "downloads")
    .go();
  await tick();
  assert.deepEqual(
    view
      .render()
      .fd.items.map((item) => item.name)
      .sort(),
    ["Receipts", "receipt.pdf"],
  );
  assert.deepEqual(view.named("storageList").at(-1), [
    "storageList",
    { path: "Download" },
  ]);
});

test("an empty Downloads directory is readable and creates a folder in Downloads", async (t) => {
  let exists = false;
  const created = [];
  const view = files(t, {
    storageList: async ({ path }) =>
      path === "Download" && !exists
        ? { status: "missing" }
        : {
            status: "ready",
            entries: created
              .filter((entry) => entry.parent === path)
              .map((entry) => ({
                path: `${path}/${entry.name}`,
                name: entry.name,
                directory: true,
                modified: 0,
              })),
          },
    storageCreateFolder: async (entry) => {
      if (entry.parent === "") exists = true;
      created.push(entry);
      return { status: "ready" };
    },
  });
  view.render();
  await tick();
  view
    .render()
    .browse.cats.find((category) => category.id === "downloads")
    .go();
  await tick();
  assert.equal(view.render().fd.empty, true);
  assert.deepEqual(view.toasts, []);
  assert.equal(view.render().toolbar.canCreate, true);
  view.render().toolbar.newFolder();
  view.render().dlg.onValue({ target: { value: "Receipts" } });
  view.render().dlg.confirm();
  await tick();
  assert.deepEqual(created, [
    { parent: "", name: "Download" },
    { parent: "Download", name: "Receipts" },
  ]);
  assert.deepEqual(
    view.render().fd.items.map((item) => item.name),
    ["Receipts"],
  );
});

test("leaving Downloads during the parent read retires folder creation", async (t) => {
  const pending = Promise.withResolvers();
  let reads = 0;
  const view = files(t, {
    storageList: async ({ path }) => {
      if (path !== "Download") return { status: "ready", entries: [] };
      return ++reads === 1 ? { status: "missing" } : pending.promise;
    },
    storageCreateFolder: async () => ({ status: "ready" }),
  });
  view.render();
  await tick();
  view
    .render()
    .browse.cats.find((category) => category.id === "downloads")
    .go();
  await tick();
  view.render().toolbar.newFolder();
  view.render().dlg.onValue({ target: { value: "Receipts" } });
  view.render().dlg.confirm();
  await tick();
  view.leave();
  pending.resolve({ status: "missing" });
  await tick();
  assert.deepEqual(view.named("storageCreateFolder"), []);
});
