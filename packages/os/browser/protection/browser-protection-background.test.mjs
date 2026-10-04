import assert from "node:assert/strict";
import { test } from "node:test";

test("engine failure records unavailable and websites/embedded pages cannot request exceptions", async () => {
  const previousChrome = globalThis.chrome,
    previousFetch = globalThis.fetch;
  let messageListener,
    written,
    exceptions = 0,
    requests = 0;
  const event = { addListener: () => {} };
  globalThis.fetch = async () => {
    requests++;
    throw Error("No network in test");
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async (value) => {
          written = value;
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => {
        throw Error("Engine unavailable");
      },
      updateSessionRules: async () => {
        exceptions++;
      },
    },
    runtime: {
      id: "a".repeat(32),
      getURL: (file) => "chrome-extension://" + "a".repeat(32) + "/" + file,
      onInstalled: event,
      onStartup: event,
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    alarms: { create: () => {}, onAlarm: event },
    webNavigation: { onCommitted: event },
    tabs: { onRemoved: event },
  };
  try {
    await import("./background.mjs?engine-failure");
    for (let i = 0; i < 20 && !written; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.protection.status, "unavailable");
    assert.equal(requests, 0);
    const url = chrome.runtime.getURL("warning.html") + "#https://bad.example/";
    for (const sender of [
      {
        id: chrome.runtime.id,
        frameId: 0,
        url: "https://bad.example/",
        tab: { id: 2 },
      },
      { id: chrome.runtime.id, frameId: 1, url, tab: { id: 2 } },
      { id: "b".repeat(32), frameId: 0, url, tab: { id: 2 } },
    ])
      assert.equal(
        messageListener({ type: "open-temporarily" }, sender, () => {}),
        undefined,
      );
    assert.equal(exceptions, 0);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("clock rollback refreshes rules and failed navigation revokes its exception", async () => {
  const previousChrome = globalThis.chrome,
    previousFetch = globalThis.fetch;
  let listener,
    written,
    requests = 0;
  const changes = [];
  const event = { addListener: () => {} };
  globalThis.fetch = async () => {
    requests++;
    throw Error("Offline");
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          protection: {
            updatedAt: Date.now() + 86400000,
            publishedAt: Date.now(),
            ruleCount: 1,
            status: "current",
          },
        }),
        set: async (v) => {
          written = v;
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [{ id: 10000 }],
      updateSessionRules: async (v) => changes.push(v),
    },
    runtime: {
      id: "a".repeat(32),
      getURL: (f) => "chrome-extension://" + "a".repeat(32) + "/" + f,
      onInstalled: event,
      onStartup: event,
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
    alarms: { create: async () => {}, onAlarm: event },
    webNavigation: { onCommitted: event },
    tabs: {
      onRemoved: event,
      update: async () => {
        throw Error("Tab closed");
      },
    },
  };
  try {
    await import("./background.mjs?clock-and-navigation");
    for (let i = 0; i < 20 && !written; i++)
      await new Promise((r) => setImmediate(r));
    assert.ok(
      requests > 0,
      "future download timestamp cannot suppress refresh",
    );
    assert.equal(written.protection.status, "unavailable");
    const reply = await new Promise((resolve) =>
      listener(
        { type: "open-temporarily" },
        {
          id: chrome.runtime.id,
          frameId: 0,
          url: chrome.runtime.getURL("warning.html") + "#https://bad.example/",
          tab: { id: 4 },
        },
        resolve,
      ),
    );
    assert.equal(reply.ok, false);
    assert.equal(changes.length, 2);
    assert.ok(changes[0].addRules);
    assert.deepEqual(changes[1], { removeRuleIds: [1] });
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("an exception alarm from a previous consumer worker still revokes the allow rule", async () => {
  const previousChrome = globalThis.chrome;
  let onAlarm;
  const removed = [];
  const event = { addListener() {} };
  globalThis.chrome = {
    runtime: { onInstalled: event, onStartup: event, onMessage: event },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: {
      getDynamicRules: async () => {
        throw Error("offline upgrade");
      },
      updateSessionRules: async (value) => removed.push(value),
    },
    alarms: {
      create() {},
      onAlarm: {
        addListener: (fn) => {
          onAlarm = fn;
        },
      },
    },
    webNavigation: { onCommitted: event },
  };
  try {
    await import("./background.mjs?legacy-alarm");
    onAlarm({ name: "senior-protection-exception" });
    assert.deepEqual(removed, [{ removeRuleIds: [1] }]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.chrome = previousChrome;
  }
});
