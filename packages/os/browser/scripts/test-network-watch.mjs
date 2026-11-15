/**
 * Real Chromium webRequest test of the network effect watch, in a minimal
 * unpacked extension that loads the shipped effect-watch.mjs and
 * page-command.mjs. Local loopback sites only; does not qualify the native
 * transport, the owned Chromium component or Android.
 */
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const received = [];
const page = (body) =>
  `<!doctype html><p>Account</p><button id="go" type="button">Show details</button>${body}`;
const late = process.argv.includes("--skip-late") ? 0 : 31000;
const pages = {
  // A top-level control that asks a child frame to send the request.
  "/frame-cross": page(
    `<iframe id="f" src="http://other.test:PORT/child"></iframe><script>go.onclick=()=>f.contentWindow.postMessage("pay","*")</script>`,
  ),
  "/frame-same": page(
    `<iframe id="f" src="/child"></iframe><script>go.onclick=()=>f.contentWindow.postMessage("pay","*")</script>`,
  ),
  "/child": `<script>onmessage=()=>fetch("/api/pay",{method:"POST"})</script>`,
  "/image": page(
    `<script>go.onclick=()=>{new Image().src="http://other.test:PORT/p.gif?amount=84"}</script>`,
  ),
  "/socket": page(
    `<script>go.onclick=()=>{try{new WebSocket("ws://bank.test:PORT/socket")}catch{}}</script>`,
  ),
  // After the old 30 second window: the site's own poll (a read), then a
  // write.
  "/late": page(
    `<script>go.onclick=()=>{setTimeout(()=>fetch("/api/poll"),${late});setTimeout(()=>fetch("/api/pay",{method:"POST"}),${late + 2500})}</script>`,
  ),
  "/window": page(
    `<script>go.onclick=()=>open("http://other.test:PORT/child")</script>`,
  ),
  "/read": page(`<script>go.onclick=()=>fetch("/api/balance")</script>`),
  "/fetch-cross": page(
    `<script>go.onclick=()=>fetch("http://other.test:PORT/api/q?amount=84",{mode:"no-cors"})</script>`,
  ),
  // What a real site sends to other sites around a click: an analytics
  // beacon, a CDN image, script and stylesheet, and an ad pixel.
  "/analytics": page(
    `<script>go.onclick=()=>{navigator.sendBeacon("http://other.test:PORT/g/collect","v=2");new Image().src="http://other.test:PORT/cdn/logo.png";new Image().src="http://other.test:PORT/px.gif?ev=click";const s=document.createElement("script");s.src="http://other.test:PORT/cdn/app.js";document.head.append(s);const l=document.createElement("link");l.rel="stylesheet";l.href="http://other.test:PORT/cdn/a.css";document.head.append(l)}</script>`,
  ),
  // An analytics library that posts its events with fetch to another site.
  // Only a ping beacon is telemetry by type, so within 30 s this counts.
  "/analytics-fetch": page(
    `<script>go.onclick=()=>fetch("http://other.test:PORT/v1/batch",{method:"POST",mode:"no-cors",body:"{}"})</script>`,
  ),
  // A granted form POST that loads a page, and a granted fetch whose
  // response is slow.
  "/granted-form": `<form action="/done" method="post"><button id="go">Show details</button></form>`,
  "/granted-fetch": `<button id="go" type="button" onclick="fetch('/api/slow',{method:'POST'})">Show details</button>`,
  // Links the click follows: to another site, and a same-site one that
  // redirects off-site (single sign-on, a payment processor).
  "/link": `<a id="go" href="http://other.test:PORT/child">Show details</a>`,
  "/redirect": `<a id="go" href="/hop">Show details</a>`,
  // A cross-site child frame posts a form into the top-level page, which the
  // page's own watch cannot stop.
  "/top-post": page(
    `<iframe id="f" src="http://other.test:PORT/poster"></iframe><script>go.onclick=()=>f.contentWindow.postMessage("pay","*")</script>`,
  ),
  "/poster": `<form id="p" action="http://bank.test:PORT/done" method="post" target="_top"></form><script>onmessage=()=>p.submit()</script>`,
  // The click's own write, and a control of hers that sends nothing.
  "/then-hers": page(
    `<button id="mine" type="button">Mine</button><script>go.onclick=()=>fetch("/api/pay",{method:"POST"})</script>`,
  ),
  "/hers": page(
    `<button id="mine" type="button" onclick="fetch('http://other.test:PORT/api/pay',{method:'POST',mode:'no-cors'})">Mine</button><div id="tile" onclick="fetch('http://other.test:PORT/api/tile',{method:'POST',mode:'no-cors'})">Tile</div><script>go.onclick=()=>{}</script>`,
  ),
};
const server = createServer((request, response) => {
  received.push(`${request.method} ${request.headers.host}${request.url}`);
  const path = new URL(request.url, "http://x").pathname;
  if (path === "/hop") {
    response.writeHead(302, {
      Location: `http://other.test:${server.address().port}/child`,
    });
    response.end();
    return;
  }
  if (path === "/api/slow") {
    setTimeout(() => response.end("{}"), 1500);
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    (pages[path] ?? "ok").replaceAll("PORT", String(server.address().port)),
  );
});
server.on("upgrade", (request, socket) => {
  received.push(`UPGRADE ${request.headers.host}${request.url}`);
  socket.destroy();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const origin = `http://bank.test:${port}`;

const extension = await mkdtemp(join(tmpdir(), "eliza-network-watch-"));
const source = (name) =>
  fileURLToPath(new URL(`../src/${name}`, import.meta.url));
await copyFile(source("effect-watch.mjs"), join(extension, "effect-watch.mjs"));
await copyFile(source("page-command.mjs"), join(extension, "page-command.mjs"));
await writeFile(
  join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Network watch test",
    version: "1",
    permissions: ["tabs", "scripting", "webNavigation", "webRequest"],
    // As the shipped manifest: webRequest sees a WebSocket only with ws hosts.
    host_permissions: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
    background: { service_worker: "background.mjs", type: "module" },
  }),
);
await writeFile(
  join(extension, "background.mjs"),
  `import { applyEffectWatch, createEffectWatch } from "./effect-watch.mjs";
import { pageCommand } from "./page-command.mjs";
globalThis.watch = createEffectWatch(chrome);
globalThis.pageCommand = pageCommand;
globalThis.applyEffectWatch = applyEffectWatch;
`,
);
const profile = await mkdtemp(join(tmpdir(), "eliza-network-watch-profile-"));
// Playwright's own Chromium build loads unpacked extensions headless.
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  ...(process.env.ELIZA_BROWSER_EXECUTABLE
    ? { executablePath: process.env.ELIZA_BROWSER_EXECUTABLE }
    : {}),
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--host-resolver-rules=MAP *.test 127.0.0.1",
    // So a page script can open a window, the case the watch must see.
    "--disable-popup-blocking",
  ],
});
let failed = false;
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const tab = await context.newPage();
  // Runs the shipped page command in the tab, as commands.mjs does, and
  // hands its result to the network watch as command-handler.mjs does: arm
  // before a task effect, then applyEffectWatch on the result. A snapshot's
  // result is its main frame, with the watch's verdict.
  const run = (command, snapshotId = null) =>
    worker.evaluate(
      async ([command, snapshotId]) => {
        const [tab] = await chrome.tabs.query({ url: "http://bank.test/*" });
        command = { ...command, id: String(tab.id) };
        if (command.subaction !== "snapshot")
          globalThis.watch.arm(tab.id, command.taskPolicy, command.subaction);
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          func: globalThis.pageCommand,
          args: [command, snapshotId],
          world: "ISOLATED",
        });
        const value =
          command.subaction === "snapshot"
            ? { frames: [{ frameId: 0, ...result.result }] }
            : result.result;
        // The page's own verdict is set aside, so the frame carries only the
        // network watch's.
        const page = value.frames?.[0].effectViolation;
        if (value.frames) delete value.frames[0].effectViolation;
        globalThis.applyEffectWatch(globalThis.watch, command, value);
        return {
          tabId: tab.id,
          value: value.frames ? { ...value.frames[0], page } : value,
        };
      },
      [command, snapshotId],
    );
  let sequence = 0;
  // Each case is its own binding, since a violation lasts for its binding.
  let scope = 0;
  // The grant for the next task click, as task-bindings.mjs hands it on.
  let grant = null;
  const policy = () => ({
    origin,
    expiresAt: Date.now() + 120000,
    targets: [{ selector: "#go", action: "click" }],
    expectedSelector: "#go",
    guidanceScope: String(scope),
    ...(grant ? { commitGrant: grant } : {}),
  });
  const snapshot = async () => {
    const id = `snapshot-${++sequence}`;
    const { tabId, value } = await run(
      { subaction: "snapshot", taskPolicy: policy() },
      id,
    );
    assert.equal(value.complete, true);
    return { id, tabId, value };
  };
  // A task click under the watch, then the network verdict for the next read,
  // in the command handler's order: arm, dispatch, snapshot, read.
  const taskClick = async (path, wait = 600, commitGrant = null) => {
    scope++;
    await tab.goto(`${origin}${path}`);
    const { id, tabId, value } = await snapshot();
    const node = value.elements.find(
      (element) => element.targetSelector === "#go",
    );
    grant = commitGrant && {
      grantId: `grant-${scope}`,
      selector: "#go",
      expiresAt: Date.now() + 30000,
      ...commitGrant,
    };
    const { value: clicked } = await run({
      subaction: "click",
      snapshotId: id,
      nodeId: node.id,
      taskPolicy: policy(),
    });
    grant = null;
    assert.equal(clicked.dispatched, true, JSON.stringify(clicked));
    assert.equal("watchHandoff" in clicked, false);
    await tab.waitForTimeout(wait);
    clickedTab = tabId;
    return tabId;
  };
  let clickedTab;
  // The verdict once the tab has left the bank's site, where no task snapshot
  // runs: the watch alone.
  const verdictOn = () =>
    worker.evaluate(
      ([tabId, scope]) => globalThis.watch.read(tabId, scope),
      [clickedTab, String(scope)],
    );
  // The network watch's verdict in the next task snapshot, and the page's.
  const verdicts = async () => {
    const { value } = await snapshot();
    assert.equal("watchHandoff" in value, false);
    return { network: value.effectViolation ?? null, page: value.page ?? null };
  };
  const verdict = async () => (await verdicts()).network;
  // As after the phone slept with the page open: performance.now() stops
  // during sleep, so timeOrigin + performance.now() falls behind the wall
  // clock that request times use. Set in the page command's own world.
  const sleep = (ms) =>
    worker.evaluate(
      async ([tabId, ms]) => {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: (ms) =>
            Object.defineProperty(performance, "timeOrigin", {
              value: performance.timeOrigin - ms,
              configurable: true,
            }),
          args: [ms],
          world: "ISOLATED",
        });
      },
      [clickedTab, ms],
    );
  const cases = [
    ["/frame-cross", "request", `POST other.test:${port}/api/pay`],
    ["/frame-same", "request", `POST bank.test:${port}/api/pay`],
    // An image reads; a fetch to another site after a click is the click's.
    ["/image", null, `GET other.test:${port}/p.gif?amount=84`],
    ["/fetch-cross", "request", `GET other.test:${port}/api/q?amount=84`],
    ["/analytics", null, `POST other.test:${port}/g/collect`],
    ["/analytics-fetch", "request", `POST other.test:${port}/v1/batch`],
    ["/socket", "request", `UPGRADE bank.test:${port}/socket`],
    ["/window", "window", `GET other.test:${port}/child`],
    ["/read", null, `GET bank.test:${port}/api/balance`],
  ];
  for (const [path, expected, sent] of cases) {
    await taskClick(path);
    assert.ok(received.includes(sent), `${path}: ${sent} was not sent`);
    assert.equal(await verdict(), expected, path);
    for (const extra of context.pages()) if (extra !== tab) await extra.close();
  }
  // Her own press on another control after the task click is hers.
  await taskClick("/hers");
  await tab.click("#mine");
  await tab.waitForTimeout(600);
  assert.ok(received.includes(`POST other.test:${port}/api/pay`));
  assert.equal(await verdict(), null);
  // After ten minutes of sleep her press is still hers, and her later tap
  // does not take over a write the click sent before it.
  // A tile is no control, so only her press makes its write hers.
  await taskClick("/hers");
  await sleep(600000);
  await tab.click("#tile");
  await tab.waitForTimeout(600);
  assert.ok(received.includes(`POST other.test:${port}/api/tile`));
  assert.equal(await verdict(), null, "her press after sleep");
  await taskClick("/then-hers");
  await sleep(600000);
  await tab.click("#mine");
  await tab.waitForTimeout(300);
  assert.equal(await verdict(), "request", "the click's write after sleep");
  // Her press after the last read, and the next task effect with no read in
  // between: the press reaches the earlier effect through the next result.
  // A key press leaves the snapshot fresh (a pointer press would not).
  await taskClick("/hers");
  const read = await snapshot();
  assert.equal(read.value.effectViolation ?? null, null);
  const posted = received.length;
  await tab.focus("#mine");
  await tab.keyboard.press("Enter");
  await tab.waitForTimeout(600);
  assert.ok(received.slice(posted).includes(`POST other.test:${port}/api/pay`));
  const { value: again } = await run({
    subaction: "click",
    snapshotId: read.id,
    nodeId: read.value.elements.find(
      (element) => element.targetSelector === "#go",
    ).id,
    taskPolicy: policy(),
  });
  assert.equal(again.dispatched, true, JSON.stringify(again));
  assert.equal("previousWatchHandoff" in again, false);
  assert.equal(await verdict(), null, "her press before the next effect");
  // The commit she said yes to. A form POST whose page load is read in the
  // new document, which has no record of the click.
  await taskClick("/granted-form", 800, {});
  assert.ok(received.includes(`POST bank.test:${port}/done`));
  assert.equal(new URL(tab.url()).pathname, "/done");
  assert.equal(await verdict(), null, "granted form page load");
  // A granted fetch read while its response is still on the way, and after.
  await taskClick("/granted-fetch", 200, {
    requestTarget: { path: "/api/slow", method: "POST" },
  });
  assert.ok(received.includes(`POST bank.test:${port}/api/slow`));
  assert.equal(await verdict(), null, "granted fetch in flight");
  await tab.waitForTimeout(2000);
  assert.equal(await verdict(), null, "granted fetch after its response");
  // A link the click follows is not a violation, also through a redirect to
  // another site; a POST into the top-level page is.
  await taskClick("/link", 800);
  assert.equal(new URL(tab.url()).hostname, "other.test");
  assert.equal(await verdictOn(), null, "cross-site link");
  await taskClick("/redirect", 800);
  assert.equal(new URL(tab.url()).hostname, "other.test");
  assert.equal(
    await verdictOn(),
    null,
    "same-site link that redirects off-site",
  );
  await taskClick("/top-post", 800);
  assert.ok(received.includes(`POST bank.test:${port}/done`));
  assert.equal(await verdict(), "request", "POST into the top-level page");
  // A request the page starts after the old 30 second window.
  if (late) {
    const before = received.length;
    await taskClick("/late", late + 1000);
    assert.ok(
      received.slice(before).includes(`GET bank.test:${port}/api/poll`),
    );
    assert.ok(
      !received.slice(before).includes(`POST bank.test:${port}/api/pay`),
    );
    assert.deepEqual(
      await verdicts(),
      { network: null, page: null },
      "the site's own poll after 30 s",
    );
    await tab.waitForTimeout(2500);
    assert.ok(
      received.slice(before).includes(`POST bank.test:${port}/api/pay`),
    );
    assert.equal(await verdict(), "request");
  }
  console.log(
    `network watch: ok (frames, cross-site, image, cross-site fetch, a site's analytics and CDN, fetch analytics, WebSocket, window, own-site GET, her press, her press and the click's write after sleep, her press before the next effect, granted form page load, granted fetch in flight, links and redirects, top-level POST${late ? ", a poll and a write after 30 s" : ""})`,
  );
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await context.close();
  server.close();
  await rm(extension, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
