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
    forgotten = [];
  const preview = "__native_selected_document";
  const view = {
    render: (state) =>
      state.open === preview ? { isPreview: true, pv: {} } : {},
  };
  const api = {
    set() {},
    toast: (text) => toasts.push(text),
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

test("a selection larger than one storage call is changed in parts and shared up to the limit", async (t) => {
  const entries = Array.from({ length: 1200 }, (_, index) =>
    file(`Download/${index}.txt`, "text/plain"),
  );
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
  assert.deepEqual(view.named("storageShare"), []);
  assert.deepEqual(view.toasts, ["Select up to 100 files to share."]);
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
      status: "succeeded",
      summary: "Showing the first 1 item in Files. More files match.",
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
    storageQuery: async () => ({ status: "ready", entries }),
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

test("a filter left for more than ten minutes is cleared on return", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const view = files(t, {
    storageQuery: async () => ({
      status: "ready",
      entries: [file("Download/lease.pdf", "application/pdf")],
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
    [11, false],
  ]) {
    view.leave();
    t.mock.timers.tick(minutes * 60 * 1000);
    view.render();
    await tick();
    assert.equal(!!view.render().chip, kept);
  }
});
