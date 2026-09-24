import assert from "node:assert/strict";
import test from "node:test";
import { executeCommand } from "./commands.mjs";

function browser(before, after, reads) {
  let inventories = 0;
  return {
    tabs: {
      get: async () => ({ url: "https://example.test/", status: "complete" }),
    },
    webNavigation: {
      getAllFrames: async () => (inventories++ === 0 ? before : after),
    },
    scripting: { executeScript: async () => reads },
  };
}

const main = { frameId: 0, documentId: "main-document" };
const child = { frameId: 2, documentId: "child-document" };
const read = (frame) => ({
  ...frame,
  result: { complete: true, text: "all text", elements: [] },
});
const command = { subaction: "snapshot", id: "42" };

test("rejects an inaccessible frame even when scripting silently returns the main frame", async () => {
  await assert.rejects(
    executeCommand(
      browser([main, child], [main, child], [read(main)]),
      command,
    ),
    /no partial snapshot/,
  );
});
test("rejects a document replacement during snapshot", async () => {
  await assert.rejects(
    executeCommand(
      browser([main], [{ ...main, documentId: "replaced" }], [read(main)]),
      command,
    ),
    /no partial snapshot/,
  );
});
test("returns every frame when both inventories and script documents agree", async () => {
  const result = await executeCommand(
    browser([main, child], [child, main], [read(main), read(child)]),
    command,
  );
  assert.equal(result.frames.length, 2);
  assert.deepEqual(
    result.frames.map((frame) => frame.text),
    ["all text", "all text"],
  );
});
