import assert from "node:assert/strict";
import test from "node:test";
import { validateFilesOperation } from "../src/browser/files-agent-contract.ts";
import { installFilesBrowserAdapter } from "../src/browser/files-browser-adapter.ts";
import { filterMatches } from "../src/browser/storage-model.ts";

const file = (name) => ({
  name,
  path: `Download/${name}`,
  directory: false,
  mimeType: "application/pdf",
  size: 1,
  modified: 0,
});
const matching = (text, names) =>
  names.filter((name) => filterMatches({ text }, file(name)));

test("the agent's files_filter narrows a browser volume by a Cyrillic name", async (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = previousDocument;
  });
  const ready = { status: "ready", access: "granted" };
  // BrowserStorageVolume.query lists every file of a complete walk and leaves
  // the text to filterMatches.
  const everyFile = ["Договор аренды.pdf", "notes.pdf", "photo.pdf"].map(file);
  const view = { render: () => ({}) };
  const api = { set() {}, toast() {}, isActive: () => true };
  const runner = installFilesBrowserAdapter(
    view,
    async () => {},
    () => {},
    {
      storage: {
        storageState: async () => ready,
        storageCategory: async () => ({ status: "ready", count: 0 }),
        storageTrashList: async () => ({ status: "ready", items: [] }),
        storageWatch: async () => {},
        storageQuery: async () => ({
          status: "ready",
          entries: everyFile,
          truncated: false,
        }),
        addListener: async () => ({ remove: async () => {} }),
      },
      createInlineModal: () => ({ ref() {} }),
      menuFocus: () => null,
      forgetSelected: async () => {},
    },
  );
  view.render({}, api);

  const result = await runner.run(
    validateFilesOperation({ type: "files_filter", text: "договор" }),
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    status: "succeeded",
    summary: "Showing 1 item in Files.",
  });
  assert.deepEqual(
    view.render({}, api).filterRows.map((row) => row.name),
    ["Договор аренды.pdf"],
  );
});

for (const [script, text, names, expected] of [
  [
    "Cyrillic",
    "договор",
    ["Договор аренды.pdf", "notes.pdf"],
    ["Договор аренды.pdf"],
  ],
  ["Greek", "σύμβαση", ["Σύμβαση.pdf", "notes.pdf"], ["Σύμβαση.pdf"]],
  ["Devanagari", "अनुबंध", ["किराया अनुबंध.pdf", "notes.pdf"], ["किराया अनुबंध.pdf"]],
  [
    "Chinese",
    "合同",
    ["合同 2024.pdf", "租赁合同.pdf", "发票.pdf", "notes.pdf"],
    ["合同 2024.pdf", "租赁合同.pdf"],
  ],
  ["Japanese", "契約", ["賃貸契約書.pdf", "請求書.pdf"], ["賃貸契約書.pdf"]],
  ["Korean", "계약서", ["임대계약서.pdf", "영수증.pdf"], ["임대계약서.pdf"]],
])
  test(`a ${script} filter keeps only the names that have its words`, () => {
    assert.deepEqual(matching(text, names), expected);
  });

test("a Latin filter still matches whole words by prefix", () => {
  assert.deepEqual(
    matching("lease", ["Lease 2024.pdf", "sublease.pdf", "photo.pdf"]),
    ["Lease 2024.pdf"],
  );
  assert.deepEqual(matching("resume", ["Résumé.pdf", "notes.pdf"]), [
    "Résumé.pdf",
  ]);
});
