/** Isolated Chromium OTP policy tests; no real credentials or installed native host. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pageCommand } from "../src/commands.mjs";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("https://otp.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<input id="otp" aria-label="Code" autocomplete="one-time-code"><input id="password" aria-label="Password" type="password"><input id="name" aria-label="Name"><button id="verify" type="button">Verify</button>',
    }),
  );
  await page.goto("https://otp.example");
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "protected-fill-test",
  });
  const run = async (command, id = null) => {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(id)})`,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  let seq = 0;
  const attempt = async (selector, permission, protectedKind = true) => {
    const id = `snapshot-${++seq}`;
    const state = await run({ subaction: "snapshot" }, id);
    const labels = {
      "#otp": "Code",
      "#password": "Password",
      "#name": "Name",
      "#verify": "Verify",
    };
    const node = state.elements.find(
      (value) => value.label === labels[selector],
    );
    assert.ok(node);
    return run({
      subaction: selector === "#verify" ? "click" : "fill",
      snapshotId: id,
      nodeId: node.id,
      text: "123456",
      taskPolicy: {
        origin: "https://otp.example",
        expiresAt: Date.now() + 60000,
        targets: [{ selector, action: permission }],
        ...(protectedKind ? { protectedValueKind: "verification-code" } : {}),
      },
    });
  };
  assert.equal(
    (await attempt("#otp", "fill", false)).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (await attempt("#otp", "fill", true)).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (await attempt("#otp", "fill-code", false)).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal((await attempt("#otp", "fill-code", true)).dispatched, true);
  assert.equal(await page.locator("#otp").inputValue(), "123456");
  assert.equal(
    JSON.stringify(await run({ subaction: "snapshot" }, "after")).includes(
      "123456",
    ),
    false,
  );
  assert.equal(
    (await attempt("#password", "fill-code", true)).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (await attempt("#name", "fill-code", true)).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (await attempt("#verify", "click", true)).error.kind,
    "POLICY_BLOCKED",
  );
  // ---- Task effects must not submit or leave the page ------------------
  // An auto-submitting code field, a button that calls form.submit(), a
  // date field and a link, on a controlled page.
  await page.route("https://effects.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form id="code" action="/verified" method="post"><input id="otp2" aria-label="Code" autocomplete="one-time-code" maxlength="6"></form>
<form id="pay" action="/paid" method="get"><input id="when" aria-label="Payment date" type="date"><button id="next" type="button" onclick="document.getElementById('pay').submit()">Review details</button></form>
<input id="typed" aria-label="Typed" value="by the person"><a id="account" href="/account">Account details</a>
<script>window.submits=0;document.getElementById('otp2').addEventListener('input',e=>{if(e.target.value.length===6){window.submits++;e.target.form.requestSubmit()}});document.addEventListener('submit',()=>window.submits++);</script>`,
    }),
  );
  await page.goto("https://effects.example/start");
  const { frameTree: effectsTree } = await cdp.send("Page.getFrameTree");
  const effectsWorld = await cdp.send("Page.createIsolatedWorld", {
    frameId: effectsTree.frame.id,
    worldName: "task-effects-test",
  });
  const runEffects = async (command, id = null) => {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: effectsWorld.executionContextId,
      expression: `(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(id)})`,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  const effectsPolicy = (targets, extra = {}) => ({
    origin: "https://effects.example",
    expiresAt: Date.now() + 60000,
    guidanceScope: "7",
    targets,
    ...extra,
  });
  const act = async (label, subaction, targets, extra = {}) => {
    const id = `effects-${++seq}`;
    const state = await runEffects(
      { subaction: "snapshot", taskPolicy: effectsPolicy(targets) },
      id,
    );
    const node = state.elements.find((value) => value.label === label);
    assert.ok(node, label);
    return runEffects({
      subaction,
      snapshotId: id,
      nodeId: node.id,
      text: extra.text ?? "",
      taskPolicy: effectsPolicy(targets, extra.policy),
    });
  };
  const read = () =>
    runEffects(
      { subaction: "snapshot", taskPolicy: effectsPolicy([]) },
      `effects-${++seq}`,
    );
  // Only whether a field has text leaves the page, never the text.
  const first = await read();
  assert.equal(
    first.elements.find((value) => value.label === "Typed").hasInput,
    true,
  );
  assert.equal(
    first.elements.find((value) => value.label === "Code").hasInput,
    false,
  );
  assert.equal(JSON.stringify(first).includes("by the person"), false);
  assert.equal(first.effectViolation, undefined);
  // A protected code fill that makes the page submit itself is stopped.
  assert.equal(
    (
      await act("Code", "fill", [{ selector: "#otp2", action: "fill-code" }], {
        text: "123456",
        policy: { protectedValueKind: "verification-code" },
      })
    ).dispatched,
    true,
  );
  await page.waitForTimeout(200);
  assert.equal(page.url(), "https://effects.example/start");
  assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal((await read()).effectViolation, "submit");
  // Another binding does not see this binding's violation.
  assert.equal(
    (
      await runEffects(
        {
          subaction: "snapshot",
          taskPolicy: { ...effectsPolicy([]), guidanceScope: "8" },
        },
        `effects-${++seq}`,
      )
    ).effectViolation,
    undefined,
  );
  // A date field takes only a real calendar day.
  // A later binding must record its own violation after an earlier one failed.
  assert.equal(
    (
      await act("Code", "fill", [{ selector: "#otp2", action: "fill-code" }], {
        text: "654321",
        policy: { protectedValueKind: "verification-code", guidanceScope: "8" },
      })
    ).dispatched,
    true,
  );
  assert.equal(
    (
      await runEffects(
        {
          subaction: "snapshot",
          taskPolicy: effectsPolicy([], { guidanceScope: "8" }),
        },
        `effects-${++seq}`,
      )
    ).effectViolation,
    "submit",
  );
  const dateTarget = [{ selector: "#when", action: "fill" }];
  for (const text of ["10/01/2026", "2026-02-30", "2026-13-01", "0000-01-01"])
    assert.equal(
      (await act("Payment date", "fill", dateTarget, { text })).error.kind,
      "POLICY_BLOCKED",
      text,
    );
  assert.equal(
    (await act("Payment date", "fill", dateTarget, { text: "2026-10-01" }))
      .dispatched,
    true,
  );
  assert.equal(await page.locator("#when").inputValue(), "2026-10-01");
  // A host-chosen reviewed target admits only that control.
  const both = [
    { selector: "#when", action: "fill" },
    { selector: "#typed", action: "fill" },
  ];
  assert.equal(
    (
      await act("Payment date", "fill", both, {
        text: "2026-10-02",
        policy: { expectedSelector: "#typed" },
      })
    ).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (
      await act("Payment date", "fill", both, {
        text: "2026-10-02",
        policy: { expectedSelector: "#when" },
      })
    ).dispatched,
    true,
  );
  // A button that submits its form from script is stopped; nothing leaves.
  assert.equal(
    (
      await act("Review details", "click", [
        { selector: "#next", action: "click" },
      ])
    ).dispatched,
    true,
  );
  await page.waitForTimeout(300);
  assert.equal(page.url(), "https://effects.example/start");
  // A click on a link still opens that link.
  assert.equal(
    (
      await act("Account details", "click", [
        { selector: "#account", action: "click" },
      ])
    ).dispatched,
    true,
  );
  await page.waitForURL("https://effects.example/account");
  // ---- Script requests and address changes after a task action ----------
  // A code field that verifies itself with fetch() never submits a form or
  // leaves the document. The request cannot be stopped, but it is reported,
  // also when the page sends it after a delay. A request the person's own
  // typing starts, and a third-party request, are not.
  const posted = [];
  await page.route("https://analytics.example/**", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route("https://fetch.example/**", (route) => {
    const request = route.request();
    if (request.method() !== "GET" || request.url().includes("/api/")) {
      posted.push(new URL(request.url()).pathname);
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<input id="otp3" aria-label="Code" autocomplete="one-time-code" maxlength="6">
<input id="later" aria-label="Later" maxlength="6"><input id="route" aria-label="Route"><input id="note" aria-label="Note"><input id="search" aria-label="Search">
<script>
document.getElementById('otp3').addEventListener('input',e=>{if(e.target.value.length===6)fetch('/api/verify',{method:'POST',body:'{}'})});
document.getElementById('later').addEventListener('input',e=>{if(e.target.value.length===6)setTimeout(()=>fetch('/api/later',{method:'POST'}),3500)});
document.getElementById('route').addEventListener('input',()=>history.pushState({}, '', '/next'));
document.getElementById('note').addEventListener('input',()=>navigator.sendBeacon('https://analytics.example/collect','x'));
document.getElementById('search').addEventListener('input',()=>fetch('/api/suggest?q=1'));
</script>`,
    });
  });
  await page.goto("https://fetch.example/start");
  const { frameTree: fetchTree } = await cdp.send("Page.getFrameTree");
  const fetchWorld = await cdp.send("Page.createIsolatedWorld", {
    frameId: fetchTree.frame.id,
    worldName: "task-requests-test",
  });
  const runFetch = async (command, id) => {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: fetchWorld.executionContextId,
      expression: `(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(id)})`,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  const fetchPolicy = (scope, targets = [], extra = {}) => ({
    origin: "https://fetch.example",
    expiresAt: Date.now() + 60000,
    guidanceScope: scope,
    targets,
    ...extra,
  });
  const fetchAct = async (scope, label, selector, text, extra = {}) => {
    const id = `fetch-${++seq}`;
    const targets = [
      { selector, action: extra.protectedValueKind ? "fill-code" : "fill" },
    ];
    const state = await runFetch(
      { subaction: "snapshot", taskPolicy: fetchPolicy(scope, targets) },
      id,
    );
    const node = state.elements.find((value) => value.label === label);
    assert.ok(node, label);
    const result = await runFetch(
      {
        subaction: "fill",
        snapshotId: id,
        nodeId: node.id,
        text,
        taskPolicy: fetchPolicy(scope, targets, extra),
      },
      null,
    );
    assert.equal(result.dispatched, true, label);
  };
  const fetchRead = async (scope) =>
    (
      await runFetch(
        { subaction: "snapshot", taskPolicy: fetchPolicy(scope) },
        `fetch-${++seq}`,
      )
    ).effectViolation;
  // A third-party beacon is not the site acting on the fill.
  await fetchAct("20", "Note", "#note", "hello");
  await page.waitForTimeout(500);
  assert.equal(await fetchRead("20"), undefined);
  // The person's own typing may make the site search; that is hers.
  await page.click("#search");
  await page.keyboard.type("a");
  await page.waitForTimeout(500);
  assert.equal(await fetchRead("20"), undefined);
  // An auto-verifying code field that posts with fetch() is reported.
  await fetchAct("21", "Code", "#otp3", "123456", {
    protectedValueKind: "verification-code",
  });
  await page.waitForTimeout(500);
  assert.deepEqual(posted, ["/api/suggest", "/api/verify"]);
  assert.equal(await fetchRead("21"), "request");
  // A request the page sends a few seconds later is still reported.
  await fetchAct("22", "Later", "#later", "123456");
  await page.waitForTimeout(500);
  assert.equal(await fetchRead("22"), undefined);
  await page.waitForTimeout(4000);
  assert.ok(posted.includes("/api/later"));
  assert.equal(await fetchRead("22"), "request");
  // A same-document address change (a script router) is reported.
  await fetchAct("23", "Route", "#route", "x");
  await page.waitForTimeout(300);
  assert.equal(await fetchRead("23"), "navigation");
  console.log(
    "PASS: OTP requires protected host marker and dedicated field permission; ordinary, password, non-OTP and Verify paths denied; code excluded from snapshot; task fills and clicks cannot submit or navigate (auto-submit code field, script form.submit()), a link click opens its link, same-site fetch/beacon requests (also delayed) and same-document address changes after a task fill are reported while the person's own and third-party requests are not, violations are reported per binding; date fields take only real days; an expected target admits only that control; field input is reported as a boolean only.",
  );
} finally {
  await browser.close();
}
