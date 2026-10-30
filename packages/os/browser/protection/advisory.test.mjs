/** Advice refreshes without redrawing: a screen reader hears it once, and focus stays put. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  createProtectionAdvisory,
  renderProtectionAdvisory,
} from "./advisory.mjs";

/** Just enough DOM for the isolated-world renderer, counting every text and node change. */
class FakeNode {
  constructor(page, tag) {
    Object.assign(this, { page, tag, children: [], parent: null });
    this.attributes = new Map();
    this.listeners = new Map();
    this.text = "";
    this.disabled = false;
  }
  get textContent() {
    return this.text;
  }
  set textContent(value) {
    this.page.writes.push([this.tag, value]);
    this.text = String(value);
  }
  get isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node === this.page.root;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  attachShadow() {
    this.shadow = new FakeNode(this.page, "#shadow");
    this.shadow.parent = this;
    return this.shadow;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  prepend(node) {
    this.page.inserted++;
    node.parent = this;
    this.children.unshift(node);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  find(tag) {
    for (const child of this.children) {
      if (child.tag === tag) return child;
      const found = child.find(tag);
      if (found) return found;
    }
    return this.shadow?.find(tag);
  }
}

let page;
const saved = {};
beforeEach(() => {
  for (const name of ["document", "location", "CSSStyleSheet", "chrome"])
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  page = { writes: [], inserted: 0, messages: [], reply: { accepted: true } };
  page.root = new FakeNode(page, "html");
  Object.defineProperties(globalThis, {
    document: {
      configurable: true,
      value: {
        documentElement: page.root,
        createElement: (tag) => new FakeNode(page, tag),
      },
    },
    location: {
      configurable: true,
      value: { origin: "https://example.test", host: "example.test" },
    },
    CSSStyleSheet: {
      configurable: true,
      value: class {
        replaceSync() {}
      },
    },
    chrome: {
      configurable: true,
      value: {
        runtime: {
          sendMessage: async (message) => {
            page.messages.push(message);
            if (page.reply instanceof Error) throw page.reply;
            return page.reply;
          },
        },
      },
    },
  });
});
afterEach(() => {
  delete globalThis.__elizaProtectionAdvisory;
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

const copy = {
  region: "Website warning",
  marked: "Marked as not suspicious",
  notScanned: "This does not mean the website was scanned.",
  mark: "Mark as not suspicious",
  undo: "Undo",
  failed: "That choice could not be saved. The website is still open.",
};
const advice = (change = {}) => ({
  nonce: "nonce-1",
  origin: "https://example.test",
  copy,
  title: "This website wasn’t scanned",
  detail: "Protection lists are unavailable.",
  marked: false,
  canMark: true,
  ...change,
});
const bar = () => page.root.children[0];
const parts = () => ({
  title: bar().find("strong"),
  detail: bar().find("p"),
  button: bar().find("button"),
});
const click = (button) =>
  button.listeners.get("click")({ isTrusted: true, preventDefault() {} });

test("the same advice again keeps the bar, its focus target and its live region untouched", () => {
  renderProtectionAdvisory(advice());
  const host = bar();
  const { title, detail, button } = parts();
  assert.equal(title.textContent, "This website wasn’t scanned");
  assert.equal(
    detail.textContent,
    "example.test · Protection lists are unavailable.",
  );
  assert.equal(page.inserted, 1);
  page.writes.length = 0;
  for (let refresh = 2; refresh < 6; refresh++)
    renderProtectionAdvisory(advice({ nonce: `nonce-${refresh}` }));
  assert.equal(bar(), host, "The bar is not removed and recreated");
  assert.equal(page.root.children.length, 1);
  assert.equal(page.inserted, 1, "The bar is not moved");
  assert.deepEqual(page.writes, [], "No status text is rewritten");
  assert.equal(parts().button, button, "A focused button stays the same node");
});

test("only what changed is written: the account context alone announces nothing", () => {
  renderProtectionAdvisory(advice({ canMark: false }));
  const { button } = parts();
  assert.equal(button.disabled, true);
  page.writes.length = 0;
  renderProtectionAdvisory(advice({ canMark: true, nonce: "nonce-2" }));
  assert.equal(button.disabled, false);
  assert.deepEqual(page.writes, []);
  renderProtectionAdvisory(advice({ marked: true, nonce: "nonce-3" }));
  assert.deepEqual(page.writes, [
    ["strong", "Marked as not suspicious"],
    ["p", "example.test · This does not mean the website was scanned."],
    ["button", "Undo"],
  ]);
  page.writes.length = 0;
  renderProtectionAdvisory(
    advice({
      title: "This address may be pretending to be another website.",
      detail: "Similar spelling is a warning, not proof of fraud.",
      nonce: "nonce-4",
    }),
  );
  assert.deepEqual(
    page.writes.map(([tag]) => tag),
    ["strong", "p", "button"],
    "A changed verdict is announced",
  );
});

test("a click sends the latest display, and a failure stays explained across a same refresh", async () => {
  renderProtectionAdvisory(advice());
  renderProtectionAdvisory(advice({ nonce: "nonce-2" }));
  const { detail, button } = parts();
  page.reply = { accepted: false };
  await click(button);
  assert.deepEqual(page.messages, [
    { type: "protection-acknowledge", nonce: "nonce-2", marked: true },
  ]);
  assert.equal(detail.textContent, copy.failed);
  assert.equal(button.disabled, false);
  page.writes.length = 0;
  renderProtectionAdvisory(advice({ nonce: "nonce-3" }));
  assert.equal(detail.textContent, copy.failed);
  assert.deepEqual(page.writes, []);
  renderProtectionAdvisory(advice({ marked: true, nonce: "nonce-4" }));
  assert.equal(
    detail.textContent,
    "example.test · This does not mean the website was scanned.",
  );
  page.reply = { accepted: true };
  await click(button);
  assert.deepEqual(page.messages.at(-1), {
    type: "protection-acknowledge",
    nonce: "nonce-4",
    marked: false,
  });
});

test("a refresh while a choice is saving keeps the button disabled until it settles", async () => {
  renderProtectionAdvisory(advice());
  const { button } = parts();
  let settle;
  globalThis.chrome.runtime.sendMessage = () =>
    new Promise((resolve) => {
      settle = resolve;
    });
  const saving = click(button);
  assert.equal(button.disabled, true);
  renderProtectionAdvisory(advice({ marked: true, nonce: "nonce-2" }));
  assert.equal(button.disabled, true, "No second choice while one is saving");
  settle({ accepted: true });
  await saving;
  assert.equal(button.disabled, false);
});

test("advice for another origin is ignored, a removed bar returns and no advice removes it", () => {
  renderProtectionAdvisory(advice());
  const host = bar();
  renderProtectionAdvisory(advice({ origin: "https://other.test" }));
  assert.equal(bar(), host);
  host.remove();
  renderProtectionAdvisory(advice({ nonce: "nonce-2" }));
  assert.equal(bar(), host, "The page cannot hide the advice by removing it");
  renderProtectionAdvisory(null);
  assert.equal(page.root.children.length, 0);
  assert.equal(globalThis.__elizaProtectionAdvisory, undefined);
  renderProtectionAdvisory(advice({ nonce: "nonce-3" }));
  assert.notEqual(bar(), host, "Advice after removal is drawn fresh");
});

function fakeBrowser(url = "https://example.test/") {
  const listeners = {};
  const listen = (name) => ({
    addListener: (listener) => {
      listeners[name] = listener;
    },
  });
  const browser = {
    injections: [],
    listeners,
    runtime: {
      id: "extension",
      getURL: (path) => `chrome-extension://extension/${path}`,
      onMessage: listen("message"),
    },
    storage: {
      local: { get: async () => ({ protection: { status: "unavailable" } }) },
    },
    tabs: {
      query: async () => [{ id: 7, url }],
      get: async () => ({ url }),
      onRemoved: listen("removed"),
    },
    webNavigation: {
      getFrame: async () => ({ documentId: "document-7", url }),
      onCommitted: listen("committed"),
      onHistoryStateUpdated: listen("history"),
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        browser.injections.push(args[0]);
        func(...args);
        return [{ frameId: 0, documentId: "document-7" }];
      },
    },
  };
  return browser;
}

test("setting the same owner again changes no page, and an owner change redraws in place", async () => {
  const browser = fakeBrowser();
  const advisory = createProtectionAdvisory(browser);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.injections.length, 1, "Cold start draws current pages");
  assert.equal(parts().button.disabled, true);
  const host = bar();
  page.writes.length = 0;
  assert.deepEqual(await advisory.setOwner(null), {
    updated: 0,
    unavailable: 0,
  });
  assert.equal(browser.injections.length, 1, "An unchanged owner is a no-op");
  assert.deepEqual(await advisory.setOwner("account-a"), {
    updated: 1,
    unavailable: 0,
  });
  assert.equal(parts().button.disabled, false);
  assert.deepEqual(await advisory.setOwner("account-a"), {
    updated: 0,
    unavailable: 0,
  });
  assert.equal(browser.injections.length, 2);
  // A transport loss retires the owner and the next registration restores it.
  await advisory.setOwner(null);
  await advisory.setOwner("account-a");
  assert.equal(browser.injections.length, 4);
  assert.equal(bar(), host, "The bar is never recreated");
  assert.deepEqual(page.writes, [], "Nothing is announced again");
  await assert.rejects(
    advisory.setOwner("bad owner"),
    /Invalid advisory owner/,
  );
});

test("an acknowledgement survives a repeated owner and is still cleared by an owner change", async () => {
  const browser = fakeBrowser();
  const advisory = createProtectionAdvisory(browser);
  await advisory.setOwner("account-a");
  const shown = browser.injections.at(-1);
  const reply = await new Promise((respond) => {
    browser.listeners.message(
      { type: "protection-acknowledge", nonce: shown.nonce, marked: true },
      {
        id: "extension",
        frameId: 0,
        documentId: "document-7",
        url: "https://example.test/",
        tab: { id: 7 },
      },
      respond,
    );
  });
  assert.deepEqual(reply, { accepted: true });
  assert.equal(browser.injections.at(-1).marked, true);
  assert.equal(parts().title.textContent, "Marked as not suspicious");
  const count = browser.injections.length;
  await advisory.setOwner("account-a");
  assert.equal(browser.injections.length, count);
  assert.equal(parts().title.textContent, "Marked as not suspicious");
  await advisory.setOwner("account-b");
  assert.equal(browser.injections.at(-1).marked, false);
  assert.equal(parts().title.textContent, "This website wasn’t scanned");
});

test("the unavailable detail makes no claim about list age", () => {
  const browser = fakeBrowser();
  createProtectionAdvisory(browser);
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.equal(
      browser.injections[0].detail,
      "Protection lists are unavailable.",
    );
    assert.doesNotMatch(browser.injections[0].detail, /out of date|stale/i);
  });
});

test("with unscanned advice off, unavailable lists draw no bar and a lookalike still warns", async () => {
  const quiet = fakeBrowser();
  createProtectionAdvisory(quiet, { unscanned: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    quiet.injections,
    [null],
    "The page is told to show nothing",
  );
  assert.equal(page.root.children.length, 0);

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://paypa1.com", host: "paypa1.com" },
  });
  const lookalike = fakeBrowser("https://paypa1.com/");
  createProtectionAdvisory(lookalike, {
    unscanned: false,
    referenceDomains: ["paypal.com"],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    parts().title.textContent,
    "This address may be pretending to be another website.",
  );
  assert.throws(
    () => createProtectionAdvisory(fakeBrowser(), { unscanned: "no" }),
    /Invalid advisory policy/,
  );
});
