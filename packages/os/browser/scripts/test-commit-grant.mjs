/** Isolated Chromium consented-commit tests; no real site, account or value. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pageCommand } from "../src/commands.mjs";

const origin = "https://pay.example";
const pages = {
  // A plain form: the commit is a page load to the same origin.
  "/form": `<form action="/done" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay">Pay now</button></form>`,
  // A script form: the commit is a request and an address change.
  "/script": `<form id="f" action="/never" method="post"><button id="send">Send payment</button></form><script>f.addEventListener("submit",(e)=>{e.preventDefault();fetch("/api/pay",{method:"POST"}).then(()=>history.pushState({},"","/sent"))})</script>`,
  // A form that posts to another origin.
  "/cross": `<form action="https://other.example/take" method="post"><button id="pay">Pay now</button></form>`,
  // A button whose script sends two forms: only one is granted.
  "/twice": `<form id="a" action="/first" method="post"></form><form id="b" action="/second" method="post"></form><button id="pay" onclick="a.requestSubmit();b.requestSubmit()">Pay now</button>`,
};
const received = [];
const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  const context = await browser.newContext();
  await context.route(/^https:\/\/(pay|other)\.example\//, (route) => {
    const url = new URL(route.request().url());
    received.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.fulfill({
      contentType: "text/html",
      body: pages[url.pathname] ?? `<p>Received</p>`,
    });
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let world;
  const open = async (path) => {
    await page.goto(`${origin}${path}`);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    ({ executionContextId: world } = await cdp.send(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: "commit-grant-test" },
    ));
  };
  const run = async (command, id = null) => {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: world,
      expression: `(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(id)})`,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  let sequence = 0;
  const policy = (grant) => ({
    origin,
    expiresAt: Date.now() + 60000,
    targets: [{ selector: "#pay", action: "click" }],
    expectedSelector: "#pay",
    guidanceScope: "1",
    ...(grant ? { commitGrant: grant } : {}),
  });
  const snapshot = async (taskPolicy = policy()) => {
    const id = `snapshot-${++sequence}`;
    const state = await run({ subaction: "snapshot", taskPolicy }, id);
    assert.equal(state.complete, true);
    return { id, state };
  };
  const press = async (label, grant, selector = "#pay") => {
    const { id, state } = await snapshot();
    const node = state.elements.find((value) => value.label === label);
    assert.ok(node, `No ${label} control`);
    return run({
      subaction: "click",
      snapshotId: id,
      nodeId: node.id,
      taskPolicy: {
        ...policy(grant),
        targets: [{ selector, action: "click" }],
        expectedSelector: selector,
      },
    });
  };
  const grant = (grantId, extra = {}) => ({
    grantId,
    selector: "#pay",
    expiresAt: Date.now() + 30000,
    ...extra,
  });
  const settle = () => page.waitForTimeout(400);

  // Without a grant a commit control stays with the person.
  await open("/form");
  assert.equal((await press("Pay now")).error.kind, "POLICY_BLOCKED");
  // An expired grant or one for another control is no grant.
  assert.equal(
    (await press("Pay now", grant("old", { expiresAt: Date.now() - 1 }))).error
      .kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (await press("Pay now", grant("other", { selector: "#other" }))).error.kind,
    "POLICY_BLOCKED",
  );
  assert.ok(!received.includes(`POST ${origin}/done`));
  // A granted click sends the one form to its own origin.
  assert.equal((await press("Pay now", grant("form-grant"))).dispatched, true);
  await page.waitForURL(`${origin}/done`);
  assert.ok(received.includes(`POST ${origin}/done`));

  // A script commit: its own-site request and address change are consented,
  // not violations, and the grant cannot be used again in this document.
  await open("/script");
  const scripted = await press(
    "Send payment",
    grant("script-grant", { selector: "#send" }),
    "#send",
  );
  assert.equal(scripted.dispatched, true, JSON.stringify(scripted));
  await settle();
  assert.ok(received.includes(`POST ${origin}/api/pay`));
  const after = (await snapshot()).state;
  assert.equal(after.effectViolation, undefined);
  assert.deepEqual(after.consentedCommit, {
    grantId: "script-grant",
    kind: "submit",
  });
  assert.equal(
    (
      await press(
        "Send payment",
        grant("script-grant", { selector: "#send" }),
        "#send",
      )
    ).error.kind,
    "POLICY_BLOCKED",
  );

  // A grant never crosses origins: the submit is stopped and reported.
  await open("/cross");
  assert.equal((await press("Pay now", grant("cross-grant"))).dispatched, true);
  await settle();
  assert.ok(!received.some((entry) => entry.includes("other.example")));
  const crossed = (await snapshot()).state;
  assert.equal(crossed.effectViolation, "submit");
  assert.equal(crossed.consentedCommit, undefined);

  // One grant, one submit: the second form the script sends is stopped.
  await open("/twice");
  assert.equal((await press("Pay now", grant("twice-grant"))).dispatched, true);
  await page.waitForURL(`${origin}/first`);
  assert.ok(received.includes(`POST ${origin}/first`));
  assert.ok(!received.includes(`POST ${origin}/second`));
  console.log("consented commit grant: ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
