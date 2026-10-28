/** Isolated Chromium consented-commit tests; no real site, account or value. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { commitFormHash } from "../../../../plugins/plugin-browser/src/commit-form-hash.ts";
import { pageCommand } from "../src/commands.mjs";

const origin = "https://pay.example";
const pages = {
  // A plain form: the commit is a page load to the same origin.
  "/form": `<form action="/done" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay">Pay now</button></form>`,
  // A script form: the commit is a request and an address change.
  "/script": `<form id="f" action="/never" method="post"><button id="send">Send payment</button></form><script>f.addEventListener("submit",(e)=>{e.preventDefault();fetch("/api/pay",{method:"POST"}).then(()=>history.pushState({},"","/sent"))})</script>`,
  // A form that posts to another origin.
  "/cross": `<form action="https://other.example/take" method="post"><button id="pay">Pay now</button></form>`,
  // A button whose script also sends another form: only its own is granted.
  "/twice": `<form id="a" action="/first" method="post"><button id="pay" onclick="b.requestSubmit()">Pay now</button></form><form id="b" action="/second" method="post"></form>`,
  // A button whose script sends only another form: nothing is granted.
  "/elsewhere": `<form id="a" action="/mine" method="post"><button id="pay" onclick="event.preventDefault();b.requestSubmit()">Pay now</button></form><form id="b" action="/theirs" method="post"></form>`,
  // A GET form: its page load carries no form data.
  "/get": `<form action="/found" method="get"><input name="q" aria-label="Query" value="12"><button id="pay">Pay now</button></form>`,
  // The page cancels the granted submit, then sends the form from script.
  "/cancel": `<form id="f" action="/later" method="post"><button id="pay">Pay now</button></form><script>f.addEventListener("submit",(e)=>{e.preventDefault();setTimeout(()=>f.submit(),100)})</script>`,
  // A second submitter of the granted form, clicked by the granted button's
  // script: its formaction would send the form elsewhere.
  "/alt-click": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();alt.click()">Pay now</button><button id="alt" formaction="/exfil">Other</button></form>`,
  // The granted click sends the form with another submitter; the granted
  // button's own submit still follows it.
  "/alt-request": `<form id="f" action="/pay" method="post"><button id="pay" onclick="f.requestSubmit(alt)">Pay now</button><button id="alt" formaction="/exfil">Other</button></form>`,
  // Another submitter that overrides only the method or the encoding.
  "/alt-method": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();f.requestSubmit(alt)">Pay now</button><button id="alt" formmethod="get">Other</button></form>`,
  "/alt-enctype": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();f.requestSubmit(alt)">Pay now</button><button id="alt" formenctype="text/plain">Other</button></form>`,
  // A script form.submit() sends no submit event and has no submitter.
  "/script-submit": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();f.submit()">Pay now</button></form>`,
  "/button-submit": `<form id="f" action="/pay" method="post"><button id="pay" type="button" onclick="f.submit()">Pay now</button></form>`,
  // The granted button's script moves the form's action after the click.
  "/moved": `<form id="f" action="/pay" method="post"><button id="pay" onclick="f.action='/exfil'">Pay now</button></form>`,
  // The granted button's script swaps in a copy of itself and clicks it.
  "/swapped": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();const copy=pay.cloneNode(true);copy.onclick=null;pay.replaceWith(copy);copy.click()">Pay now</button></form>`,
  // A submit with no submitter: the granted button is the default button.
  "/implicit": `<form id="f" action="/pay" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay" onclick="event.preventDefault();f.requestSubmit()">Pay now</button></form>`,
  // ... is not the default button.
  "/implicit-second": `<form id="f" action="/pay" method="post"><button id="save" formaction="/exfil">Save</button><button id="pay" onclick="event.preventDefault();f.requestSubmit()">Pay now</button></form>`,
  // ... overrides the form's action, so a submit without it goes elsewhere.
  "/implicit-override": `<form id="f" action="/exfil" method="post"><button id="pay" formaction="/pay" onclick="event.preventDefault();f.requestSubmit()">Pay now</button></form>`,
  // A button whose script sends two own-site requests.
  "/requests": `<button id="pay" onclick="fetch('/api/one',{method:'POST'}).then(()=>fetch('/api/two',{method:'POST'}))">Pay now</button>`,
  // The granted submit button's script fetches another path of the site.
  "/exfil-fetch": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();fetch('/exfil',{method:'POST'})">Pay now</button></form>`,
  // The page sends the granted form itself, with fetch to its action.
  "/ajax": `<form id="f" action="/api/pay" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay">Pay now</button></form><script>f.addEventListener("submit",(e)=>{e.preventDefault();fetch(f.action,{method:"POST",body:new FormData(f,e.submitter)})})</script>`,
  // A plain "Pay" button (no form) that posts with fetch or a beacon.
  "/js-pay": `<button id="pay" onclick="fetch('/api/pay',{method:'POST'})">Pay now</button>`,
  "/js-beacon": `<button id="pay" onclick="navigator.sendBeacon('/api/pay')">Pay now</button>`,
  // Form contents. The fields the person reviewed, with the submitter's own
  // name/value, a decomposed accent and a multi-line note.
  "/fields": `<form id="f" action="/pay" method="post"><input name="payee" aria-label="Payee" value="Zoe\u0301"><input name="amount" aria-label="Amount" value="12"><textarea name="note" aria-label="Note">rent\nOctober</textarea><input type="file" name="receipt" aria-label="Receipt"><button id="pay" name="go" value="yes">Pay now</button></form>`,
  // The same form, sent by the page with fetch, so the hash is reported.
  "/fields-ajax": `<form id="f" action="/api/pay" method="post"><input name="payee" aria-label="Payee" value="Zoe\u0301"><input name="amount" aria-label="Amount" value="12"><textarea name="note" aria-label="Note">rent\nOctober</textarea><input type="file" name="receipt" aria-label="Receipt"><button id="pay" name="go" value="yes">Pay now</button></form><script>f.addEventListener("submit",(e)=>{e.preventDefault();fetch(f.action,{method:"POST",body:new FormData(f,e.submitter)})})</script>`,
  // The granted button's script changes a field or adds a hidden input.
  "/changed": `<form id="f" action="/pay" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay" name="go" value="yes" onclick="f.amount.value='9999'">Pay now</button></form>`,
  "/hidden": `<form id="f" action="/pay" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay" name="go" value="yes" onclick="const extra=document.createElement('input');extra.type='hidden';extra.name='to';extra.value='mallory';f.append(extra)">Pay now</button></form>`,
  // A formdata handler that changes only the data the page load sends.
  "/late-change": `<form id="f" action="/pay" method="post"><input name="amount" aria-label="Amount" value="12"><button id="pay" name="go" value="yes">Pay now</button></form><script>let reads=0;f.addEventListener("formdata",(e)=>{if(++reads>1)e.formData.set("amount","9999")})</script>`,
  // A script form.submit() into a new window, which this window never loads.
  "/blank": `<form id="f" action="/pay" method="post"><button id="pay" onclick="event.preventDefault();f.target='_blank';f.submit()">Pay now</button></form>`,
  "/blank-button": `<form id="f" action="/pay" method="post" target="_blank"><button id="pay" type="button" onclick="f.submit()">Pay now</button></form>`,
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
      contentType: "text/html; charset=utf-8",
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

  // A script commit: its one own-site request is consented. The address
  // change after it is still recorded, so the host reads the page back, and
  // the grant cannot be used again in this document.
  await open("/script");
  const payTarget = { requestTarget: { path: "/api/pay", method: "POST" } };
  const scripted = await press(
    "Send payment",
    grant("script-grant", { selector: "#send", ...payTarget }),
    "#send",
  );
  assert.equal(scripted.dispatched, true, JSON.stringify(scripted));
  await settle();
  assert.ok(received.includes(`POST ${origin}/api/pay`));
  const after = (await snapshot()).state;
  assert.equal(after.effectViolation, "navigation");
  assert.deepEqual(after.consentedCommit, {
    grantId: "script-grant",
    kind: "submit",
    formHash: commitFormHash([]),
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

  // Another explicit approval on this page gets its own effect receipt.
  assert.equal(
    (
      await press(
        "Send payment",
        grant("second-grant", { selector: "#send", ...payTarget }),
        "#send",
      )
    ).dispatched,
    true,
  );
  await settle();
  assert.equal(
    (await snapshot()).state.consentedCommit.grantId,
    "second-grant",
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

  // A grant sends only the granted control's own form.
  await open("/elsewhere");
  assert.equal(
    (await press("Pay now", grant("elsewhere-grant"))).dispatched,
    true,
  );
  await settle();
  assert.ok(!received.includes(`POST ${origin}/theirs`));
  const elsewhere = (await snapshot()).state;
  assert.equal(elsewhere.effectViolation, "submit");

  // A GET form's page load is the granted submit too.
  await open("/get");
  assert.equal((await press("Pay now", grant("get-grant"))).dispatched, true);
  await page.waitForURL(`${origin}/found?q=12`);
  assert.ok(received.includes(`GET ${origin}/found`));

  // A cancelled granted submit cannot be sent later from script.
  await open("/cancel");
  assert.equal(
    (await press("Pay now", grant("cancel-grant"))).dispatched,
    true,
  );
  await page.waitForTimeout(500);
  assert.ok(!received.includes(`POST ${origin}/later`));
  const cancelled = (await snapshot()).state;
  assert.equal(cancelled.effectViolation, "submit");

  // Only the granted control's own submit is consented. Each of these sends
  // nothing and is reported, without a consented commit.
  const refused = async (path, sent, extra = {}) => {
    await open(path);
    const grantId = `${path.slice(1)}-grant`;
    assert.equal(
      (await press("Pay now", grant(grantId, extra))).dispatched,
      true,
      path,
    );
    await settle();
    assert.equal(page.url(), `${origin}${path}`, path);
    assert.ok(!received.includes(sent), `${path} sent ${sent}`);
    const state = (await snapshot()).state;
    assert.equal(state.effectViolation, "submit", path);
    assert.equal(state.consentedCommit, undefined, path);
  };
  // A second submitter with formaction, clicked by script.
  await refused("/alt-click", `POST ${origin}/exfil`);
  // A second submitter that overrides the method or the encoding.
  await refused("/alt-method", `GET ${origin}/pay`);
  await refused("/alt-enctype", `POST ${origin}/pay`);
  // A script form.submit(), from a submit button or a plain button.
  await refused("/script-submit", `POST ${origin}/pay`);
  await refused("/button-submit", `POST ${origin}/pay`);
  // The granted button's own submit after its script moved the action.
  await refused("/moved", `POST ${origin}/exfil`);
  // A copy of the granted button swapped in and clicked by script.
  await refused("/swapped", `POST ${origin}/pay`);
  // No submitter, and the granted button is not the default button or
  // overrides the action.
  await refused("/implicit-second", `POST ${origin}/pay`);
  await refused("/implicit-override", `POST ${origin}/exfil`);

  // requestSubmit(alt) is stopped; the granted button's own submit, which
  // follows it, is the one consented.
  await open("/alt-request");
  assert.equal(
    (await press("Pay now", grant("alt-request-grant"))).dispatched,
    true,
  );
  await page.waitForURL(`${origin}/pay`);
  assert.ok(received.includes(`POST ${origin}/pay`));
  assert.ok(!received.includes(`POST ${origin}/exfil`));

  // No submitter, from the default button that overrides nothing.
  const before = received.length;
  await open("/implicit");
  assert.equal(
    (await press("Pay now", grant("implicit-grant"))).dispatched,
    true,
  );
  await page.waitForURL(`${origin}/pay`);
  assert.ok(received.slice(before).includes(`POST ${origin}/pay`));
  assert.ok(!received.includes(`POST ${origin}/exfil`));

  // One grant, one request: the second own-site request is recorded.
  await open("/requests");
  assert.equal(
    (
      await press(
        "Pay now",
        grant("requests-grant", {
          requestTarget: { path: "/api/one", method: "POST" },
        }),
      )
    ).dispatched,
    true,
  );
  await settle();
  assert.ok(received.includes(`POST ${origin}/api/two`));
  const requests = (await snapshot()).state;
  assert.equal(requests.effectViolation, "request");
  assert.deepEqual(requests.consentedCommit, {
    grantId: "requests-grant",
    kind: "request",
  });

  // A request is consented only when it is the granted one. Each of these
  // reaches the site (a request cannot be stopped from the page) and is
  // reported, without a consented commit.
  const unconsented = async (path, sent, extra = {}) => {
    await open(path);
    const grantId = `${path.slice(1)}-grant`;
    assert.equal(
      (await press("Pay now", grant(grantId, extra))).dispatched,
      true,
      path,
    );
    await settle();
    assert.ok(received.includes(sent), `${path} did not send ${sent}`);
    const state = (await snapshot()).state;
    assert.equal(state.effectViolation, "request", path);
    assert.equal(state.consentedCommit, undefined, path);
  };
  // A same-site fetch to another path than the granted form's action.
  await unconsented("/exfil-fetch", `POST ${origin}/exfil`);
  // A non-form control with no declared request target.
  await unconsented("/js-pay", `POST ${origin}/api/pay`);
  // A declared target for another path, or another method (a beacon POSTs).
  await unconsented("/js-pay", `POST ${origin}/api/pay`, {
    requestTarget: { path: "/api/other", method: "POST" },
  });
  await unconsented("/js-beacon", `POST ${origin}/api/pay`, {
    requestTarget: { path: "/api/pay", method: "GET" },
  });
  // The declared request target is consented, by path or by URL.
  const consentedRequest = async (path, extra) => {
    await open(path);
    const grantId = `${path.slice(1)}-ok-grant`;
    assert.equal(
      (await press("Pay now", grant(grantId, extra))).dispatched,
      true,
      path,
    );
    await settle();
    const state = (await snapshot()).state;
    assert.equal(state.effectViolation, undefined, path);
    assert.equal(state.consentedCommit?.grantId, grantId, path);
    assert.equal(state.consentedCommit.kind, "request", path);
    return state;
  };
  await consentedRequest("/js-pay", {
    requestTarget: { path: "/api/pay", method: "POST" },
  });
  await consentedRequest("/js-pay", {
    requestTarget: { url: `${origin}/api/pay`, method: "POST" },
  });
  await consentedRequest("/js-beacon", {
    requestTarget: { path: "/api/pay", method: "POST" },
  });
  // Without a declared target, the form's own action, sent by the page.
  await open("/ajax");
  assert.equal((await press("Pay now", grant("ajax-grant"))).dispatched, true);
  await settle();
  const ajax = (await snapshot()).state;
  assert.equal(ajax.effectViolation, undefined);
  assert.equal(ajax.consentedCommit.grantId, "ajax-grant");

  // Form contents. What the host showed: tree order, the submitter's own
  // name/value, the file input left out, the accent composed and the note's
  // line break as the page holds it.
  const reviewed = [
    ["payee", "Zoé"],
    ["amount", "12"],
    ["note", "rent\r\nOctober"],
    ["go", "yes"],
  ];
  // The host helper and the page agree: a grant with no formHash reports the
  // hash of what the page sent, and it equals the host's.
  await open("/fields-ajax");
  assert.equal(
    (await press("Pay now", grant("fields-report-grant"))).dispatched,
    true,
  );
  await settle();
  const reported = (await snapshot()).state.consentedCommit;
  assert.equal(reported.grantId, "fields-report-grant");
  assert.equal(reported.formHash, commitFormHash(reviewed));
  // ... and a grant carrying that hash is consented (and its fetch too).
  await open("/fields-ajax");
  assert.equal(
    (
      await press(
        "Pay now",
        grant("fields-ajax-grant", { formHash: commitFormHash(reviewed) }),
      )
    ).dispatched,
    true,
  );
  await settle();
  const matched = (await snapshot()).state;
  assert.equal(matched.effectViolation, undefined);
  assert.equal(matched.consentedCommit.formHash, commitFormHash(reviewed));
  // A matching formHash sends the page load.
  await open("/fields");
  assert.equal(
    (
      await press(
        "Pay now",
        grant("fields-grant", { formHash: commitFormHash(reviewed) }),
      )
    ).dispatched,
    true,
  );
  await page.waitForURL(`${origin}/pay`);
  assert.ok(received.includes(`POST ${origin}/pay`));
  // Form data that differs from what she saw is stopped and reported.
  const bound = {
    formHash: commitFormHash([
      ["amount", "12"],
      ["go", "yes"],
    ]),
  };
  const sentBefore = received.length;
  const notSent = async (path) => {
    await refused(path, "nothing", bound);
    assert.ok(
      !received.slice(sentBefore).includes(`POST ${origin}/pay`),
      `${path} sent the form`,
    );
  };
  // A field value the granted button's script changed after her yes.
  await notSent("/changed");
  // A hidden input it added.
  await notSent("/hidden");
  // Data a formdata handler changed in the page load only.
  await notSent("/late-change");
  // A formHash for the reviewed fields but another form's data.
  await notSent("/fields");

  // A script form.submit() into another window is not seen by this window's
  // page load; reading its form data reports it.
  for (const path of ["/blank", "/blank-button"]) {
    await open(path);
    assert.equal(
      (await press("Pay now", grant(`${path.slice(1)}-grant`))).dispatched,
      true,
      path,
    );
    await settle();
    const state = (await snapshot()).state;
    assert.equal(state.effectViolation, "submit", path);
    assert.equal(state.consentedCommit, undefined, path);
  }
  console.log("consented commit grant: ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
