import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

test("Hive consent alone does no network work; each click runs at most one job", async () => {
  const source = await readFile(new URL("./hive.js", import.meta.url), "utf8");
  const elements = new Map();
  const requests = [];
  const storage = new Map();

  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        checked: false,
        disabled: false,
        value: "25",
        textContent: "",
        handlers: {},
        addEventListener(name, callback) { this.handlers[name] = callback; }
      });
    }
    return elements.get(id);
  }

  class MockWorker {
    addEventListener() {}
    terminate() {}
    postMessage() {
      queueMicrotask(() => this.onmessage({ data: { jobId: "job", cash: 0.1, n: 5 } }));
    }
  }

  const document = {
    readyState: "complete",
    hidden: false,
    getElementById: element,
    querySelector: () => ({ value: "human-check" }),
    addEventListener() {}
  };
  const context = {
    document,
    crypto: webcrypto,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    navigator: { getBattery: async () => ({ charging: true, addEventListener() {} }) },
    window: {
      VALHALLA_SITE: { HIVE_ENABLED: true, HIVE_URL: "https://hive.example" },
      addEventListener() {},
      dispatchEvent() {}
    },
    CustomEvent: class {},
    Worker: MockWorker,
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/hive/join")) {
        return { ok: true, json: async () => ({ nodeId: "node-1" }) };
      }
      if (String(url).endsWith("/hive/next")) {
        return {
          ok: true,
          json: async () => ({
            id: "job",
            simulated: true,
            series: [1, 2],
            params: {}
          })
        };
      }
      return { ok: true, json: async () => ({ ok: true, points: 1 }) };
    },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    String,
    JSON,
    Array,
    Object,
    Promise,
    Error
  };

  vm.runInNewContext(source, context);

  const consent = element("hiveOpt");
  consent.checked = true;
  consent.handlers.change();
  assert.equal(requests.length, 0, "consent must not contact the Hive service");

  async function clickAndWait() {
    const completed = requests.filter((url) => url.endsWith("/hive/result")).length;
    element("hiveRun").handlers.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (requests.filter((url) => url.endsWith("/hive/result")).length > completed) break;
    }
  }

  await clickAndWait();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.filter((url) => url.endsWith("/hive/next")).length, 1);
  assert.equal(requests.filter((url) => url.endsWith("/hive/result")).length, 1);

  await clickAndWait();
  assert.equal(requests.filter((url) => url.endsWith("/hive/next")).length, 2);
  assert.equal(requests.filter((url) => url.endsWith("/hive/result")).length, 2);
});
