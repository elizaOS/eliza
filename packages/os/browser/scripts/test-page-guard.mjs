/** Isolated Chromium tests of the in-page click guard; no real site, account or value. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pageCommand } from "../src/commands.mjs";

const origin = "https://shop.example";
// Every control records its own press, so a test sees whether it ran.
const press = (id, label, tag = "button", extra = 'type="button"') =>
  `<${tag} id="${id}" ${extra} onclick="pressed.push('${id}')">${label}</${tag}>`;
const controls = [
  press("pagar", "Pagar ahora"),
  press("finalize", "Finalize"),
  press("role", "Confirmar pago", "div", 'role="button" tabindex="0"'),
  press("fragment", "Pagar", "a", 'href="#"'),
  press("script", "Pagar", "a", 'href="javascript:void 0"'),
  press("away", "Billing history", "a", 'href="/history"'),
  press("box", "", "input", 'type="checkbox" aria-label="Paperless"'),
  press(
    "more",
    "Details",
    "button",
    'type="button" aria-expanded="false" aria-controls="more-panel"',
  ),
  press("tab", "Card", "div", 'role="tab" tabindex="0" aria-controls="card"'),
  '<div id="more-panel" hidden>Fees</div><div id="card" role="tabpanel"></div>',
  // Controls that only claim to disclose: a div with aria-expanded, a button
  // whose aria-controls names nothing here, and a tab that names nothing.
  press("claims", "Pagar", "div", 'role="button" aria-expanded="false"'),
  press(
    "nowhere",
    "Pagar",
    "button",
    'type="button" aria-expanded="false" aria-controls="missing"',
  ),
  press("bare-tab", "Pagar", "div", 'role="tab" tabindex="0"'),
  `<details><summary id="summary" onclick="pressed.push('summary')">Fees</summary>Fee table</details>`,
].join("");
const script = "<script>window.pressed=[]</script>";
const pages = {
  // A total in the text, in another language than the guard's words.
  "/total": `<html lang="es-MX"><p>Total: $84.20</p>${controls}${script}</html>`,
  // The same amount written with a code after the number.
  "/code": `<html lang="de"><p>Betrag 84,20 EUR</p>${controls}${script}</html>`,
  // No amount, but a card field.
  "/card": `<html><input autocomplete="cc-number" aria-label="Número">${controls}${script}</html>`,
  // A control whose script posts a moment later.
  "/later": `<button id="go" type="button" onclick="setTimeout(()=>fetch('/api/pay',{method:'POST'}),300)">Show details</button>`,
  // No money at all.
  "/plain": `<html lang="not a tag!"><p>Horario de atención</p>${controls}${script}</html>`,
};
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ELIZA_BROWSER_EXECUTABLE
    ? { executablePath: process.env.ELIZA_BROWSER_EXECUTABLE }
    : {}),
});
let failed = false;
try {
  const context = await browser.newContext();
  await context.route(/^https:\/\/shop\.example\//, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: pages[new URL(route.request().url()).pathname] ?? "<p>Other</p>",
    }),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let world;
  const open = async (path) => {
    await page.goto(`${origin}${path}`);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    ({ executionContextId: world } = await cdp.send(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: "page-guard-test" },
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
  const policy = (selector, extra) => ({
    origin,
    expiresAt: Date.now() + 60000,
    targets: [{ selector, action: "click" }],
    expectedSelector: selector,
    guidanceScope: "1",
    ...extra,
  });
  const snapshot = async (selector = "#pagar", extra = {}) => {
    const id = `snapshot-${++sequence}`;
    const state = await run(
      { subaction: "snapshot", taskPolicy: policy(selector, extra) },
      id,
    );
    assert.equal(state.complete, true);
    return { id, state };
  };
  // Clicks one control under a task policy with no grant. Returns whether
  // the guard let it through and whether the page's own handler ran.
  const click = async (selector, extra = {}) => {
    const { id, state } = await snapshot(selector, extra);
    const node = state.elements.find(
      (element) => element.targetSelector === selector,
    );
    assert.ok(node, `No ${selector} control`);
    const result = await run({
      subaction: "click",
      snapshotId: id,
      nodeId: node.id,
      taskPolicy: policy(selector, extra),
    });
    // A followed link leaves the page, and its record with it.
    const ran = await page
      .evaluate((id) => window.pressed.includes(id), selector.slice(1))
      .catch(() => null);
    return { allowed: result.dispatched === true, ran, result };
  };
  const opaque = [
    "#pagar",
    "#finalize",
    "#role",
    "#fragment",
    "#script",
    "#claims",
    "#nowhere",
    "#bare-tab",
  ];
  const inert = ["#box", "#more", "#tab", "#summary", "#away"];

  // On a page that shows money, a control whose effect only its script
  // defines is never pressed without a grant, whatever its words say.
  for (const path of ["/total", "/code", "/card"])
    for (const selector of opaque) {
      await open(path);
      const { allowed, ran, result } = await click(selector);
      assert.equal(allowed, false, `${path} ${selector}`);
      assert.equal(result.error?.kind, "POLICY_BLOCKED", `${path} ${selector}`);
      assert.equal(ran, false, `${path} ${selector}`);
    }
  // Controls whose effect the browser defines still work there.
  for (const selector of inert) {
    await open("/total");
    const { allowed } = await click(selector);
    assert.equal(allowed, true, selector);
  }
  await page.waitForURL(`${origin}/history`);
  // With no money on the page the guard decides by its words, as before:
  // these Spanish words are not in COMMIT_CONTROL.
  for (const selector of opaque) {
    await open("/plain");
    assert.equal((await click(selector)).allowed, true, selector);
    assert.equal(await page.evaluate(() => window.pressed.length), 1);
  }
  // The host's own commit words add to the guard's.
  const spanish = { commitPattern: "\\b(pagar|confirmar)\\b" };
  for (const selector of ["#pagar", "#role", "#fragment"]) {
    await open("/plain");
    const { allowed, ran } = await click(selector, spanish);
    assert.equal(allowed, false, selector);
    assert.equal(ran, false, selector);
  }
  await open("/plain");
  assert.equal((await click("#finalize", spanish)).allowed, true);
  // A pattern the page cannot compile allows nothing.
  await open("/plain");
  assert.equal((await click("#away", { commitPattern: "(" })).allowed, false);

  // Snapshots report the language the page declares, or null.
  await open("/total");
  assert.equal((await snapshot()).state.lang, "es-mx");
  await open("/plain");
  assert.equal((await snapshot()).state.lang, null);
  await open("/card");
  assert.equal((await snapshot()).state.lang, null);
  // A binding longer than a timer can wait (2^31 - 1 ms) still keeps the
  // in-page watch on.
  await open("/later");
  const month = { expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
  assert.equal((await click("#go", month)).allowed, true);
  await page.waitForTimeout(1500);
  assert.equal((await snapshot("#go", month)).state.effectViolation, "request");
  console.log("page guard: ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser.close();
}
if (failed) process.exitCode = 1;
