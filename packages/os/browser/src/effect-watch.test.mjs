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
    // A cross-site fetch read after a click.
    [{ url: "https://track.other.example/p?amount=84" }, "request"],
    // A same-site WebSocket.
    [{ url: "wss://bank.example/socket", type: "websocket" }, "request"],
    // A ping or beacon to the page's own site.
    [{ url: `${origin}/log`, method: "POST", type: "ping" }, "request"],
    // A cross-site WebSocket and POST within the window after the effect.
    [{ url: "wss://chat.other.example/", type: "websocket" }, "request"],
    [
      {
        url: "https://pay.other.example/charge",
        method: "POST",
        timeStamp: Date.now() + 20000,
      },
      "request",
    ],
    // A cross-site sub-frame load.
    [
      { url: "https://other.example/frame", type: "sub_frame", frameId: 4 },
      "request",
    ],
    // A request to the page's own site long after the old 30 second window.
    [
      { url: `${origin}/late`, method: "PUT", timeStamp: Date.now() + 45000 },
      "request",
    ],
    // A top-level POST to another site, at any time.
    [
      {
        url: "https://pay.other.example/done",
        method: "POST",
        type: "main_frame",
        timeStamp: Date.now() + 45000,
      },
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

test("a real site's own third-party traffic is not the effect's doing", () => {
  // An analytics beacon, CDN loads and an ad pixel right after a click, and
  // cross-site traffic long after it: what every real bill or bank page
  // sends, and none of it the click's commit.
  const traffic = [
    {
      url: "https://www.google-analytics.com/g/collect?v=2",
      method: "POST",
      type: "ping",
    },
    { url: "https://cdn.jsdelivr.net/npm/x/logo.png", type: "image" },
    { url: "https://cdn.other.example/app.js", type: "script" },
    { url: "https://fonts.gstatic.com/s/a.woff2", type: "font" },
    { url: "https://cdn.other.example/a.css", type: "stylesheet" },
    { url: "https://px.ads.other.example/p.gif?ev=click", type: "image" },
    {
      url: "https://csp.other.example/report",
      method: "POST",
      type: "csp_report",
    },
    {
      url: "https://api.segment.example/v1/t",
      method: "POST",
      timeStamp: Date.now() + 40000,
    },
    {
      url: "https://ads.other.example/frame",
      type: "sub_frame",
      frameId: 5,
      timeStamp: Date.now() + 40000,
    },
    {
      url: "wss://chat.other.example/",
      type: "websocket",
      timeStamp: Date.now() + 40000,
    },
  ];
  for (const subaction of ["click", "scroll"]) {
    const f = fixture();
    f.watch.arm(1, { ...f.policy, expiresAt: Date.now() + 3600000 }, subaction);
    for (const details of traffic) f.request(details);
    assert.equal(f.watch.read(1, "1"), null, subaction);
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
  // Another tab of the same site may have sent it: hers, not the task's.
  const shared = fixture();
  shared.listeners.committed({
    tabId: 1,
    frameId: 0,
    url: `${origin}/bill`,
    timeStamp: Date.now() - 10,
  });
  shared.listeners.committed({
    tabId: 2,
    frameId: 0,
    url: `${origin}/home`,
    timeStamp: Date.now() - 10,
  });
  shared.watch.arm(1, shared.policy);
  shared.request({
    tabId: -1,
    initiator: origin,
    url: `${origin}/sw/pay`,
    method: "POST",
  });
  assert.equal(shared.watch.read(1, "1"), null);
  // Once that tab is gone, it counts again.
  shared.listeners.removed(2);
  shared.request({
    tabId: -1,
    initiator: origin,
    url: `${origin}/sw/pay`,
    method: "POST",
  });
  assert.equal(shared.watch.read(1, "1"), "request");
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
  // After a click a cross-site fetch read is one; an image is not.
  const click = fixture();
  click.watch.arm(1, click.policy, "click");
  click.request({ url: "https://cdn.other.example/a.png", type: "image" });
  assert.equal(click.watch.read(1, "1"), null);
  click.request({ url: "https://suggest.other.example/q?x=1" });
  assert.equal(click.watch.read(1, "1"), "request");
});

test("what an earlier effect set off is judged when the next effect's result arrives", () => {
  const f = fixture();
  f.watch.arm(1, f.policy, "click");
  f.request({ url: "https://other.example/x", method: "POST" });
  f.watch.arm(1, f.policy, "click");
  assert.equal(f.watch.read(1, "1"), "request");
  // Also when that result never arrives (an uncertain outcome).
  const lost = fixture();
  lost.watch.arm(1, lost.policy, "click");
  lost.request({ url: "https://other.example/x", method: "POST" });
  lost.watch.arm(1, lost.policy, "fill");
  lost.watch.arm(1, lost.policy, "fill");
  assert.equal(lost.watch.read(1, "1"), "request");
});

test("her press after the last read, before the next effect, is still hers", () => {
  const t = Date.now();
  // Task click, a clean read, then she presses Pay and the page POSTs; the
  // agent fills next with no read in between. The fill's result carries the
  // earlier page watch's presses.
  const f = fixture();
  f.watch.arm(1, f.policy, "click");
  assert.equal(f.watch.read(1, "1", { presses: [] }), null);
  f.request({ url: `${origin}/pay`, method: "POST", timeStamp: t + 3100 });
  f.watch.arm(1, f.policy, "fill");
  f.watch.report(
    1,
    "1",
    { presses: [] },
    { scope: "1", presses: [t + 3000], activatedAt: null },
  );
  assert.equal(f.watch.read(1, "1", { presses: [] }), null);
  // Her press reaches the earlier effect alone: it never excuses the next
  // effect's own requests, also not through her activated control.
  const next = fixture();
  next.watch.arm(1, next.policy, "click");
  next.watch.arm(1, next.policy, "fill");
  next.request({ url: `${origin}/pay`, method: "POST", timeStamp: t + 5000 });
  next.watch.report(
    1,
    "1",
    { presses: [] },
    { scope: "1", presses: [t + 4900], activatedAt: t + 4900 },
  );
  assert.equal(next.watch.read(1, "1", { presses: [] }), "request");
  // Another binding's page watch excuses nothing here.
  const other = fixture();
  other.watch.arm(1, other.policy, "click");
  other.request({ url: `${origin}/pay`, method: "POST", timeStamp: t + 3100 });
  other.watch.arm(1, other.policy, "fill");
  other.watch.report(
    1,
    "1",
    { presses: [] },
    { scope: "2", presses: [t + 3000] },
  );
  assert.equal(other.watch.read(1, "1"), "request");
  // A refused next effect leaves the earlier watch unjudged, so the next
  // read still takes her press into account.
  const refused = fixture();
  refused.watch.arm(1, refused.policy, "click");
  refused.request({
    url: `${origin}/pay`,
    method: "POST",
    timeStamp: t + 3100,
  });
  refused.watch.arm(1, refused.policy, "fill")();
  assert.equal(refused.watch.read(1, "1", { presses: [t + 3000] }), null);
});

test("a host navigation the browser refused leaves the watch open; a commit does not", () => {
  const f = fixture();
  f.watch.arm(1, f.policy, "click");
  const reopen = f.watch.close(1, Date.now(), { host: true });
  reopen();
  f.request({
    url: `${origin}/pay`,
    method: "POST",
    timeStamp: Date.now() + 5,
  });
  assert.equal(f.watch.read(1, "1"), "request");
  const committed = fixture();
  committed.watch.arm(1, committed.policy, "click");
  const reopenCommitted = committed.watch.close(1, Date.now(), {
    host: true,
  });
  committed.listeners.committed({
    tabId: 1,
    frameId: 0,
    url: `${origin}/next`,
    timeStamp: Date.now(),
  });
  reopenCommitted();
  committed.request({
    url: `${origin}/pay`,
    method: "POST",
    timeStamp: Date.now() + 5,
  });
  assert.equal(committed.watch.read(1, "1"), null);
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
  const previous = { scope: "1", presses: [0] };
  const clicked = {
    dispatched: true,
    watchHandoff: handoff,
    previousWatchHandoff: previous,
  };
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
    ["report", 1, "1", handoff, previous],
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
  const plain = {
    dispatched: true,
    watchHandoff: handoff,
    previousWatchHandoff: previous,
  };
  applyEffectWatch(undefined, { id: "1", subaction: "click" }, plain);
  assert.deepEqual(plain, { dispatched: true });
});
