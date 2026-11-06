import assert from "node:assert/strict";
import test from "node:test";
import { createEffectWatch } from "./effect-watch.mjs";

const origin = "https://bank.example";
function fixture() {
  const listeners = {};
  const event = (name) => ({
    addListener: (listener) => {
      listeners[name] = listener;
    },
  });
  const api = {
    webRequest: { onBeforeRequest: event("request") },
    webNavigation: {
      onCreatedNavigationTarget: event("window"),
      onCommitted: event("committed"),
    },
    tabs: { onRemoved: event("removed") },
  };
  const watch = createEffectWatch(api);
  const policy = { origin, guidanceScope: "1", expiresAt: Date.now() + 60000 };
  return {
    watch,
    policy,
    listeners,
    request: (details) =>
      listeners.request({
        tabId: 1,
        frameId: 0,
        method: "GET",
        type: "xmlhttprequest",
        timeStamp: Date.now(),
        ...details,
      }),
  };
}

test("after a task effect, each kind of request the page sets off is seen at its start", () => {
  const cases = [
    // A cross-site payment from a child frame.
    [
      {
        url: "https://pay.other.example/charge",
        method: "POST",
        frameId: 3,
        type: "xmlhttprequest",
      },
      "request",
    ],
    // A same-site POST from a frame, before any response.
    [{ url: `${origin}/api/pay`, method: "POST", frameId: 2 }, "request"],
    // A cross-site image beacon.
    [
      { url: "https://track.other.example/p.gif?amount=84", type: "image" },
      "request",
    ],
    // A same-site WebSocket.
    [{ url: "wss://bank.example/socket", type: "websocket" }, "request"],
    // A ping or beacon.
    [{ url: `${origin}/log`, method: "POST", type: "ping" }, "request"],
    // A cross-site sub-frame load.
    [
      { url: "https://other.example/frame", type: "sub_frame", frameId: 4 },
      "request",
    ],
    // A request long after the old 30 second window.
    [
      { url: `${origin}/late`, method: "PUT", timeStamp: Date.now() + 45000 },
      "request",
    ],
    // A same-site GET of the page's own site, also from a sibling host.
    [{ url: `${origin}/api/balance` }, null],
    [{ url: "https://api.bank.example/rates", type: "image" }, null],
  ];
  for (const [details, expected] of cases) {
    const f = fixture();
    f.watch.arm(1, f.policy);
    f.request(details);
    assert.equal(f.watch.read(1, "1", undefined), expected, details.url);
  }
});

test("a service worker's request counts against the tab watching its site", () => {
  const f = fixture();
  f.watch.arm(1, f.policy);
  f.request({
    tabId: -1,
    initiator: origin,
    url: `${origin}/sw/pay`,
    method: "POST",
  });
  assert.equal(f.watch.read(1, "1"), "request");
  const other = fixture();
  other.watch.arm(1, other.policy);
  other.request({
    tabId: -1,
    initiator: "https://elsewhere.example",
    url: "https://elsewhere.example/x",
    method: "POST",
  });
  assert.equal(other.watch.read(1, "1"), null);
});

test("a window the page opens is a violation", () => {
  const f = fixture();
  f.watch.arm(1, f.policy);
  f.listeners.window({
    sourceTabId: 1,
    tabId: 9,
    url: "https://other.example/",
    timeStamp: Date.now(),
  });
  assert.equal(f.watch.read(1, "1"), "window");
});

test("her own requests, a consented commit and requests outside the watch are not violations", () => {
  const f = fixture();
  const before = Date.now() - 1;
  f.watch.arm(1, f.policy);
  const at = Date.now() + 5000;
  // Before the effect, after the binding, and after a new document.
  f.request({ url: `${origin}/early`, method: "POST", timeStamp: before });
  f.request({
    url: `${origin}/expired`,
    method: "POST",
    timeStamp: f.policy.expiresAt,
  });
  // Within 1.5 s of her press, and after her activated control.
  f.request({
    url: "https://pay.other.example/a",
    method: "POST",
    timeStamp: at + 1000,
  });
  f.request({
    url: "https://pay.other.example/b",
    method: "POST",
    timeStamp: at + 9000,
  });
  // The commit she said yes to, once.
  f.request({ url: `${origin}/pay?x=1`, method: "POST", timeStamp: at - 4000 });
  const handoff = {
    presses: [at],
    activatedAt: at + 8000,
    consentedUrls: [`${origin}/pay`],
  };
  assert.equal(f.watch.read(1, "1", handoff), null);
  // A second request to the consented address is not consented.
  f.request({ url: `${origin}/pay`, method: "POST", timeStamp: at - 3000 });
  assert.equal(
    f.watch.read(1, "1", { ...handoff, consentedUrls: [] }),
    "request",
  );
  // Another binding's snapshot sees nothing of this one.
  assert.equal(f.watch.read(1, "2", handoff), null);
  const closed = fixture();
  closed.watch.arm(1, closed.policy);
  closed.listeners.committed({ tabId: 1, frameId: 0, timeStamp: Date.now() });
  closed.request({
    url: "https://ads.other.example/",
    timeStamp: Date.now() + 10,
  });
  assert.equal(closed.watch.read(1, "1"), null);
});

test("a violation stays for the binding, and a refused effect restores the earlier watch", () => {
  const f = fixture();
  f.watch.arm(1, f.policy);
  f.request({ url: "https://other.example/x", method: "POST" });
  assert.equal(f.watch.read(1, "1"), "request");
  const cancel = f.watch.arm(1, f.policy);
  assert.equal(f.watch.read(1, "1"), "request");
  cancel();
  assert.equal(f.watch.read(1, "1"), "request");
  // A new binding starts clean.
  f.watch.arm(1, { ...f.policy, guidanceScope: "2" });
  assert.equal(f.watch.read(1, "2"), null);
});
