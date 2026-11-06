import assert from "node:assert/strict";
import test from "node:test";
import { applyEffectWatch, createEffectWatch } from "./effect-watch.mjs";

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
  f.watch.arm(1, { ...f.policy, commitGrant: { grantId: "g" } });
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

const grant = (requestTarget) => ({
  grantId: "g",
  selector: "#go",
  expiresAt: Date.now() + 30000,
  ...(requestTarget ? { requestTarget } : {}),
});

test("a granted commit is excused at its start, from the grant or the click result", () => {
  // The grant names its request: excused before the page sees it complete,
  // also by a snapshot taken while it is in flight. Once only.
  const fetch = fixture();
  fetch.watch.arm(
    1,
    {
      ...fetch.policy,
      commitGrant: grant({ path: "/api/pay", method: "POST" }),
    },
    "click",
  );
  fetch.request({ url: `${origin}/api/pay`, method: "POST", requestId: "1" });
  assert.equal(
    fetch.watch.read(1, "1", { presses: [], consentedUrls: [] }),
    null,
  );
  fetch.request({ url: `${origin}/api/pay`, method: "POST", requestId: "2" });
  assert.equal(fetch.watch.read(1, "1"), "request");
  // Another method is not the granted request.
  const method = fixture();
  method.watch.arm(
    1,
    {
      ...method.policy,
      commitGrant: grant({ path: "/api/pay", method: "POST" }),
    },
    "click",
  );
  method.request({ url: `${origin}/api/pay`, method: "DELETE" });
  assert.equal(method.watch.read(1, "1"), "request");
  // A granted form POST that loads a page: the click result names the
  // commit, and the new document's snapshot, with no handoff, is clean. A
  // 307 hop of the same request is the same commit.
  const form = fixture();
  form.watch.arm(1, { ...form.policy, commitGrant: grant() }, "click");
  for (const hop of [`${origin}/done`, `${origin}/done2`])
    form.request({
      url: hop,
      method: "POST",
      type: "main_frame",
      requestId: "9",
    });
  form.watch.report(1, "1", {
    presses: [],
    activatedAt: null,
    consentedUrls: [`${origin}/done`],
    expected: { url: `${origin}/done`, method: "POST", exact: true },
  });
  form.listeners.committed({ tabId: 1, frameId: 0, timeStamp: Date.now() });
  assert.equal(form.watch.read(1, "1", undefined), null);
  // Without a grant, what the page reports excuses nothing.
  const forged = fixture();
  forged.watch.arm(1, forged.policy, "click");
  forged.request({ url: `${origin}/done`, method: "POST", type: "main_frame" });
  assert.equal(
    forged.watch.read(1, "1", {
      consentedUrls: [`${origin}/done`],
      expected: { url: `${origin}/done`, method: "POST", exact: true },
    }),
    "request",
  );
});

test("a top-level GET is the navigation gate's; a main-frame POST is the watch's", () => {
  // A link to another site, and a same-site link that redirects off-site.
  const link = fixture();
  link.watch.arm(1, link.policy, "click");
  link.request({ url: "https://other.example/child", type: "main_frame" });
  link.request({ url: `${origin}/hop`, type: "main_frame", requestId: "4" });
  link.request({
    url: "https://sso.other.example/",
    type: "main_frame",
    requestId: "4",
  });
  assert.equal(link.watch.read(1, "1"), null);
  const post = fixture();
  post.watch.arm(1, post.policy, "click");
  post.request({ url: `${origin}/done`, method: "POST", type: "main_frame" });
  assert.equal(post.watch.read(1, "1"), "request");
});

test("after a fill, select or scroll, a cross-site read is not a violation but a write is", () => {
  for (const subaction of ["fill", "select", "scroll"]) {
    const read = fixture();
    read.watch.arm(1, read.policy, subaction);
    read.request({ url: "https://cdn.other.example/a.png", type: "image" });
    read.request({ url: "https://suggest.other.example/q?x=1" });
    assert.equal(read.watch.read(1, "1"), null, subaction);
    for (const details of [
      { url: "https://pay.other.example/charge", method: "POST" },
      { url: "wss://bank.example/socket", type: "websocket" },
    ]) {
      const write = fixture();
      write.watch.arm(1, write.policy, subaction);
      write.request(details);
      assert.equal(write.watch.read(1, "1"), "request", subaction);
    }
  }
  // After a click the cross-site read is one.
  const click = fixture();
  click.watch.arm(1, click.policy, "click");
  click.request({ url: "https://cdn.other.example/a.png", type: "image" });
  assert.equal(click.watch.read(1, "1"), "request");
});

test("what an earlier effect set off is judged when the next effect arms", () => {
  const f = fixture();
  f.watch.arm(1, f.policy, "click");
  f.request({ url: "https://other.example/x", method: "POST" });
  f.watch.arm(1, f.policy, "click");
  assert.equal(f.watch.read(1, "1"), "request");
});

test("a task effect's result only reports its handoff; a snapshot's main frame is judged", () => {
  const calls = [];
  const effects = {
    report: (...args) => calls.push(["report", ...args]),
    read: (...args) => {
      calls.push(["read", ...args]);
      return "request";
    },
  };
  const taskPolicy = { guidanceScope: "1" };
  const handoff = { presses: [1], consentedUrls: [] };
  const clicked = { dispatched: true, watchHandoff: handoff };
  applyEffectWatch(
    effects,
    { id: "1", subaction: "click", taskPolicy },
    clicked,
  );
  assert.deepEqual(clicked, { dispatched: true });
  const snapshot = {
    frames: [
      { frameId: 0, watchHandoff: handoff },
      { frameId: 2, watchHandoff: handoff },
    ],
  };
  applyEffectWatch(
    effects,
    { id: "1", subaction: "snapshot", taskPolicy },
    snapshot,
  );
  assert.deepEqual(calls, [
    ["report", 1, "1", handoff],
    ["read", 1, "1", handoff],
  ]);
  assert.deepEqual(snapshot.frames, [
    {
      frameId: 0,
      effectViolation: "request",
      effectWatch: { frames: "all", unseen: ["webrtc"] },
    },
    { frameId: 2 },
  ]);
  // No task: the handoff is still taken out, and nothing is judged.
  const plain = { dispatched: true, watchHandoff: handoff };
  applyEffectWatch(undefined, { id: "1", subaction: "click" }, plain);
  assert.deepEqual(plain, { dispatched: true });
});
