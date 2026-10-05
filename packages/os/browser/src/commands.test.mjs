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
  assert.equal(result.frames[0].documentId, "main-document");
  assert.equal(result.frames[1].documentId, "child-document");
  assert.deepEqual(
    result.frames.map((frame) => frame.text),
    ["all text", "all text"],
  );
});

test("opening a background tab fails before an effect when no regular window exists", async () => {
  let created = false;
  const api = {
    windows: {
      getAll: async () => [{ id: 7, type: "custom-tab", focused: true }],
    },
    tabs: {
      create: async () => {
        created = true;
      },
    },
  };
  await assert.rejects(
    executeCommand(api, { subaction: "open", url: "https://example.test/" }),
    (error) =>
      error.kind === "UNAVAILABLE" &&
      /Open Chromium from your launcher once/.test(error.message),
  );
  assert.equal(created, false);
});

test("new background tabs bind to a regular window even when a Custom Tab is focused", async () => {
  let creation;
  const api = {
    windows: {
      getAll: async () => [
        { id: 7, type: "custom-tab", focused: true },
        { id: 9, type: "normal", focused: false },
      ],
    },
    tabs: {
      create: async (options) => {
        creation = options;
        return { id: 42 };
      },
    },
  };
  const result = await executeCommand(api, {
    subaction: "open",
    url: "https://example.test/",
  });
  assert.deepEqual(creation, {
    url: "https://example.test/",
    active: false,
    windowId: 9,
  });
  assert.equal(result.completed, false);
  assert.equal(result.requiresReadback, true);
});

for (const subaction of [
  "navigate",
  "click",
  "fill",
  "scroll",
  "close",
  "back",
  "forward",
  "reload",
  "snapshot",
]) {
  test(`a context ending during tab lookup prevents ${subaction} dispatch`, async () => {
    let current = true;
    let effects = 0;
    const noEffect = async () => {
      effects++;
      return [];
    };
    const api = {
      tabs: {
        get: async () => {
          current = false;
          return { url: "https://example.test/", status: "complete" };
        },
        update: noEffect,
        remove: noEffect,
        goBack: noEffect,
        goForward: noEffect,
        reload: noEffect,
      },
      webNavigation: { getAllFrames: noEffect },
      scripting: { executeScript: noEffect },
    };
    await assert.rejects(
      executeCommand(
        api,
        {
          subaction,
          id: "42",
          selector: "12345678-1234-1234-1234-123456789012:0:1",
          url: "https://example.test/next",
          text: "value",
        },
        undefined,
        () => current,
      ),
      (error) => error.kind === "STALE_REF",
    );
    assert.equal(effects, 0);
  });
}

test("a context ending during window lookup cannot open a new tab", async () => {
  let current = true;
  let created = false;
  const api = {
    windows: {
      getAll: async () => {
        current = false;
        return [{ id: 1, type: "normal" }];
      },
    },
    tabs: {
      create: async () => {
        created = true;
      },
    },
  };
  await assert.rejects(
    executeCommand(
      api,
      { subaction: "open", url: "https://example.test/" },
      undefined,
      () => current,
    ),
    (error) => error.kind === "STALE_REF",
  );
  assert.equal(created, false);
});

test("a context ending after effect dispatch reports an uncertain outcome", async () => {
  let current = true;
  let effects = 0;
  const api = {
    tabs: {
      get: async () => ({ url: "https://example.test/" }),
      update: async () => {
        effects++;
        current = false;
      },
    },
  };
  await assert.rejects(
    executeCommand(
      api,
      { subaction: "navigate", id: "42", url: "https://example.test/next" },
      undefined,
      () => current,
    ),
    (error) => error.kind === "UNCERTAIN_OUTCOME",
  );
  assert.equal(effects, 1);
});
