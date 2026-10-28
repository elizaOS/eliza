import { installBrowserProtection } from "../protection/extension.mjs";

const feeds = [
  {
    id: "phishing",
    url: "https://phish.co.za/latest/phishing-domains-ACTIVE.txt",
  },
  { id: "threats", url: "https://example.test/feed" },
];

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
      getURL: (file) => `chrome-extension://${"a".repeat(32)}/${file}`,
      onInstalled: event,
      onStartup: event,
      onMessage: {
        addListener: (fn) => {
          messageListener = fn;
        },
      },
    },
    alarms: { create: () => {}, onAlarm: event },
    webNavigation: { onCommitted: event, onErrorOccurred: event },
    tabs: { onRemoved: event },
  };
  try {
    installBrowserProtection({
      chrome: globalThis.chrome,
      fetchImpl: globalThis.fetch,
      feeds,
    });
    for (let i = 0; i < 20 && !written; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.protection.status, "unavailable");
    assert.equal(requests, 0);
    const url = `${chrome.runtime.getURL("warning.html")}#https://bad.example/`;
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
      getURL: (f) => `chrome-extension://${"a".repeat(32)}/${f}`,
      onInstalled: event,
      onStartup: event,
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
    alarms: { create: async () => {}, onAlarm: event },
    webNavigation: { onCommitted: event, onErrorOccurred: event },
    tabs: {
      onRemoved: event,
      update: async () => {
        throw Error("Tab closed");
      },
    },
  };
  try {
    installBrowserProtection({
      chrome: globalThis.chrome,
      fetchImpl: globalThis.fetch,
      feeds,
    });
    for (let i = 0; i < 20 && !written; i++)
      await new Promise((r) => setImmediate(r));
    assert.ok(
      requests > 0,
      "future download timestamp cannot suppress refresh",
    );
    // The refresh failed, but the saved rules are still installed: they count.
    assert.equal(written.protection.status, "current");
    const reply = await new Promise((resolve) =>
      listener(
        { type: "open-temporarily" },
        {
          id: chrome.runtime.id,
          frameId: 0,
          url: `${chrome.runtime.getURL("warning.html")}#https://bad.example/`,
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

test("a refused warning redirect opens the same warning, and nothing else", async () => {
  const previousChrome = globalThis.chrome,
    previousFetch = globalThis.fetch;
  let onError;
  const updates = [];
  const event = { addListener: () => {} };
  const id = "a".repeat(32);
  globalThis.fetch = async () => {
    throw Error("Offline");
  };
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateSessionRules: async () => {},
    },
    runtime: {
      id,
      getURL: (f) => `chrome-extension://${id}/${f}`,
      onInstalled: event,
      onStartup: event,
      onMessage: event,
    },
    alarms: { create: async () => {}, onAlarm: event },
    webNavigation: {
      onCommitted: event,
      onErrorOccurred: {
        addListener: (fn) => {
          onError = fn;
        },
      },
    },
    tabs: {
      onRemoved: event,
      update: async (tabId, props) => {
        updates.push([tabId, props]);
      },
    },
  };
  try {
    installBrowserProtection({
      chrome: globalThis.chrome,
      fetchImpl: globalThis.fetch,
      feeds,
    });
    const warning = `chrome-extension://${id}/warning.html#https://bad.example/start`;
    const blocked = "net::ERR_BLOCKED_BY_CLIENT";
    for (const details of [
      { tabId: 3, frameId: 1, error: blocked, url: warning },
      { tabId: 3, frameId: 0, error: "net::ERR_ABORTED", url: warning },
      { tabId: 3, frameId: 0, error: blocked, url: "https://bad.example/" },
      {
        tabId: 3,
        frameId: 0,
        error: blocked,
        url: `chrome-extension://${"b".repeat(32)}/warning.html#https://bad.example/`,
      },
      {
        tabId: 3,
        frameId: 0,
        error: blocked,
        url: `chrome-extension://${id}/other.html#https://bad.example/`,
      },
      { tabId: -1, frameId: 0, error: blocked, url: warning },
    ])
      onError(details);
    assert.deepEqual(updates, []);
    onError({ tabId: 7, frameId: 0, error: blocked, url: warning });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(updates, [[7, { url: warning }]]);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
