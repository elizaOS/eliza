import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("warning remains usable when storage and the worker are unavailable", async () => {
  const elements = new Map();
  let focused;
  const document = {
    querySelector: (selector) => {
      if (!elements.has(selector))
        elements.set(selector, {
          disabled: false,
          focus: () => {
            focused = selector;
          },
        });
      return elements.get(selector);
    },
  };
  const window = {};
  window.top = window;
  window.self = window;
  const source = await readFile(
    new URL("./warning.mjs", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({
    document,
    window,
    URL,
    Date,
    location: { hash: "#https://blocked.example/" },
    history: { length: 1 },
    chrome: {
      storage: {
        local: {
          get: async () => {
            throw Error("Storage unavailable");
          },
        },
      },
      runtime: {
        sendMessage: async () => {
          throw Error("Worker unavailable");
        },
      },
    },
  });
  await vm.runInContext(`(async()=>{${source}})()`, context);
  assert.match(elements.get("#status").textContent, /updates are unavailable/);
  elements.get("#ask").onclick();
  assert.equal(focused, "#cancel");
  await elements.get("#confirm").onclick();
  assert.match(elements.get("#status").textContent, /could not be opened/);
  assert.equal(focused, "#back");
  assert.equal(elements.get("#confirm").disabled, false);
});
