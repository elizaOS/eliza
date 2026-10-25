/** Real Chromium isolated-world test; does not qualify native transport or Android. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { pageCommand } from "../src/commands.mjs";

const require = createRequire(
  import.meta.resolve("@elizaos/plugin-browser/package.json"),
);
const { default: puppeteer } = require("puppeteer-core");
if (!process.env.ELIZA_BROWSER_EXECUTABLE)
  throw new Error("Set ELIZA_BROWSER_EXECUTABLE to an installed test Chromium");
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><style>body {height:3000px} input,button {display:block}</style>
  <details><summary>New payment details</summary><label>Hidden bank field<input></label><p>Hidden payment instructions</p></details><p>Visible source text</p><span style="visibility:hidden">Hidden<span style="visibility:visible">Visible child</span></span>
  <input aria-label="Name"><select aria-label="Payment method" required><option value="">Choose a method</option><option value="private-method-value">Checking</option></select><select aria-label="Optional method"><option value="">Choose a method</option><option value="private-optional-method">Checking</option></select><textarea>private-textarea-value</textarea><div contenteditable>private-editable-value</div>
  <div role="button"><div contenteditable>private-nested-value</div><span>Safe label</span></div><button id="go" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Increment</button><span id="count">0</span>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const cases = [];
try {
  browser = await puppeteer.launch({
    executablePath: process.env.ELIZA_BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const cdp = await page.createCDPSession();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "eliza-page-freshness-test",
  });
  const run = async (command, snapshotId = null) => {
    const result = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(snapshotId)})`,
      returnByValue: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      JSON.stringify(result.exceptionDetails),
    );
    return result.result.value;
  };
  let sequence = 0;
  const snapshot = async () => {
    const id = `snapshot-${++sequence}`;
    return { id, value: await run({ subaction: "snapshot" }, id) };
  };
  const act = (state, subaction, label, extra = {}) => {
    const target = state.value.elements.find(
      (element) => element.label === label,
    );
    assert.ok(target, `Missing ${label}`);
    return run({
      subaction,
      snapshotId: state.id,
      nodeId: target.id,
      ...extra,
    });
  };
  let state = await snapshot();
  assert.ok(state.value.text.includes("Visible source text"));
  assert.ok(state.value.text.includes("Visible child"));
  assert.ok(!JSON.stringify(state.value).includes("private-textarea-value"));
  assert.ok(!JSON.stringify(state.value).includes("private-editable-value"));
  assert.equal(
    await page.evaluate(() => typeof globalThis.__elizaBrowserControlV1),
    "undefined",
  );
  assert.ok(!JSON.stringify(state.value).includes("private-nested-value"));
  cases.push("isolated state and excluded editable values");
  assert.ok(
    !state.value.elements.some(
      (element) => element.label === "Hidden bank field",
    ),
  );
  assert.ok(!state.value.text.includes("Hidden payment instructions"));
  assert.ok(
    state.value.elements.some(
      (element) => element.label === "New payment details",
    ),
  );
  await page.click("summary");
  state = await snapshot();
  assert.ok(
    state.value.elements.some(
      (element) => element.label === "Hidden bank field",
    ),
  );
  assert.ok(state.value.text.includes("Hidden payment instructions"));
  cases.push("closed details hide fields until the person opens the summary");
  let method = state.value.elements.find(
    (element) => element.label === "Payment method",
  );
  assert.equal(method.hasInput, false);
  assert.equal(method.edited, false);
  assert.equal(
    state.value.elements.find((element) => element.label === "Optional method")
      .hasInput,
    false,
  );
  await page.select("select", "private-method-value");
  state = await snapshot();
  method = state.value.elements.find(
    (element) => element.label === "Payment method",
  );
  assert.equal(method.hasInput, true);
  assert.equal(method.edited, true);
  assert.ok(!JSON.stringify(state.value).includes("private-method-value"));
  cases.push("selected method and changed field are visible without the value");
  await page.$eval("select", (node) => {
    node.required = false;
    node.options[0].textContent = "New checking account";
  });
  await page.select("select", "");
  state = await snapshot();
  method = state.value.elements.find(
    (element) => element.label === "Payment method",
  );
  assert.equal(method.hasInput, true);
  assert.equal(method.edited, true);
  await page.$eval("select", (node) => {
    node.options[0].disabled = true;
  });
  state = await snapshot();
  assert.equal(
    state.value.elements.find((element) => element.label === "Payment method")
      .hasInput,
    false,
  );
  await page.$eval("select", (node) => {
    node.selectedIndex = -1;
  });
  state = await snapshot();
  assert.equal(
    state.value.elements.find((element) => element.label === "Payment method")
      .hasInput,
    false,
  );
  cases.push(
    "valid empty-valued selection is occupied; disabled or absent selection is empty",
  );

  assert.equal(
    (await act(state, "fill", "Name", { text: "agent" })).dispatched,
    true,
  );
  assert.equal(
    await page.$eval('input[aria-label="Name"]', (node) => node.value),
    "agent",
  );
  assert.equal(
    (await act(state, "fill", "Name", { text: "replay" })).error.kind,
    "STALE_REF",
  );
  cases.push("fresh fill and consume-once reference");
  state = await snapshot();
  await page.type('input[aria-label="Name"]', "-manual");
  assert.equal(
    (await act(state, "fill", "Name", { text: "stale" })).error.kind,
    "STALE_REF",
  );
  assert.equal(
    await page.$eval('input[aria-label="Name"]', (node) => node.value),
    "agent-manual",
  );
  cases.push("manual input wins");
  state = await snapshot();
  await page.$eval('input[aria-label="Name"]', (node) => {
    node.value = "changed-without-event";
  });
  assert.equal(
    (await act(state, "fill", "Name", { text: "stale" })).error.kind,
    "STALE_REF",
  );
  cases.push("programmatic field change without input event");
  state = await snapshot();
  await page.evaluate(() =>
    document.styleSheets[0].insertRule("#go {transform:translateX(100px)}"),
  );
  assert.equal(
    (await act(state, "click", "Increment")).error.kind,
    "STALE_REF",
  );
  assert.equal(await page.$eval("#count", (node) => node.textContent), "0");
  cases.push("geometry change without DOM mutation");
  state = await snapshot();
  await page.evaluate(() => scrollTo(0, 100));
  assert.equal(
    (await act(state, "click", "Increment")).error.kind,
    "STALE_REF",
  );
  await page.evaluate(() => scrollTo(0, 0));
  cases.push("scroll invalidates geometry");
  state = await snapshot();
  await page.evaluate(() => history.pushState({}, "", "?changed=1"));
  assert.equal(
    (await act(state, "click", "Increment")).error.kind,
    "STALE_REF",
  );
  cases.push("same-document navigation invalidates reference");
  state = await snapshot();
  await page.$eval("#go", (node) => {
    node.textContent = "Changed meaning";
  });
  assert.equal(
    (await act(state, "click", "Increment")).error.kind,
    "STALE_REF",
  );
  cases.push("changed target meaning");
  state = await snapshot();
  const receipt = await act(state, "click", "Changed meaning");
  assert.deepEqual(receipt, {
    dispatched: true,
    completed: false,
    requiresReadback: true,
  });
  assert.equal(await page.$eval("#count", (node) => node.textContent), "1");
  cases.push("fresh observation permits dispatch with separate readback");
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="secret" type="password" aria-label="Secret"><input id="otp" autocomplete="one-time-code" aria-label="Code"><button id="signin" type="button">Sign in</button><button id="pay" type="button">Pay now</button><button id="verify" type="button">Verify</button><button id="confirm" type="button">Confirm payment</button><div id="make" role="button" tabindex="0">Make a payment</div><a id="schedule" href="#scheduled">Schedule payment</a><input id="proceed" type="button" value="Continue to review"><span id="lbl-pay">Pay this bill</span><div id="lb-div" role="button" tabindex="0" aria-labelledby="lbl-pay">&rarr;</div><span id="lbl-send">Send my payment</span><button id="lb-btn" type="button" aria-labelledby="lbl-send"><svg aria-hidden="true" width="8" height="8"></svg></button>',
    );
    document.querySelector("#go").type = "button";
  });
  const policy = {
    origin: new URL(page.url()).origin,
    expiresAt: Date.now() + 60000,
    targets: [
      { selector: "#secret", action: "fill" },
      { selector: "#otp", action: "fill" },
      { selector: "#signin", action: "click" },
      { selector: "#pay", action: "click" },
      { selector: "#verify", action: "click" },
      { selector: "#go", action: "click" },
      { selector: "#confirm", action: "click" },
      { selector: "#make", action: "click" },
      { selector: "#schedule", action: "click" },
      { selector: "#proceed", action: "click" },
      { selector: "#lb-div", action: "click" },
      { selector: "#lb-btn", action: "click" },
    ],
  };
  for (const [label, subaction] of [
    ["Secret", "fill"],
    ["Code", "fill"],
    ["Sign in", "click"],
    ["Pay now", "click"],
    ["Verify", "click"],
    // Commit words block a type=button, a role=button and a link alike.
    ["Confirm payment", "click"],
    ["Make a payment", "click"],
    ["Schedule payment", "click"],
    ["Continue to review", "click"],
    // Named only by aria-labelledby: the guard uses the snapshot's name.
    ["Pay this bill", "click"],
    ["Send my payment", "click"],
  ]) {
    state = await snapshot();
    assert.equal(
      (
        await act(state, subaction, label, {
          text: "never-send",
          taskPolicy: policy,
        })
      ).error.kind,
      "POLICY_BLOCKED",
    );
  }
  assert.equal(await page.$eval("#secret", (node) => node.value), "");
  state = await snapshot();
  assert.equal(
    (
      await act(state, "fill", "Name", {
        text: "not-allowed",
        taskPolicy: policy,
      })
    ).error.kind,
    "POLICY_BLOCKED",
  );
  state = await snapshot();
  assert.equal(
    (await act(state, "click", "Changed meaning", { taskPolicy: policy }))
      .dispatched,
    true,
  );
  assert.equal(await page.$eval("#count", (node) => node.textContent), "2");
  state = await snapshot();
  assert.equal(
    (
      await act(state, "click", "Changed meaning", {
        taskPolicy: { ...policy, expiresAt: 0 },
      })
    ).error.kind,
    "POLICY_BLOCKED",
  );
  state = await snapshot();
  assert.equal(
    (
      await act(state, "click", "Changed meaning", {
        taskPolicy: {
          ...policy,
          targets: [{ selector: "button", action: "click" }],
        },
      })
    ).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(await page.evaluate(() => location.hash), "");
  cases.push(
    "native-reviewed targets allow a declared ordinary action and reject undeclared fields, passwords, OTP, sign-in, verification, payment, confirm, continue and schedule controls on buttons, roles and links",
  );
  // Observation names fields the way assistive technology does and reports
  // control state and secret fields without their values.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<label for="full">Full name</label><input id="full" autocomplete="name" required aria-invalid="true" aria-describedby="hint" aria-errormessage="problem" value="private-name-value"><span id="hint">As shown on your bill</span><span id="problem">Enter your name</span><label>Card number <input id="card" autocomplete="cc-number" value="4242424242424242"></label><span id="pin-name">PIN</span><input id="pin" aria-labelledby="pin-name" autocomplete="current-password"><input id="agree" type="checkbox" checked aria-label="Paperless"><button id="more" type="button" aria-expanded="false" disabled>More</button>',
    );
    document.querySelector("#full").focus();
  });
  state = await snapshot();
  const named = (label) =>
    state.value.elements.find((element) => element.label === label);
  assert.deepEqual(
    (({ focused, required, invalid, description, sensitive, disabled }) => ({
      focused,
      required,
      invalid,
      description,
      sensitive,
      disabled,
    }))(named("Full name")),
    {
      focused: true,
      required: true,
      invalid: true,
      description: "As shown on your bill Enter your name",
      sensitive: null,
      disabled: false,
    },
  );
  assert.equal(named("Card number").sensitive, "payment-card");
  assert.equal(named("PIN").sensitive, "password");
  assert.equal(named("Paperless").checked, true);
  assert.equal(named("More").expanded, false);
  assert.equal(named("More").disabled, true);
  assert.ok(!JSON.stringify(state.value).includes("private-name-value"));
  assert.ok(!JSON.stringify(state.value).includes("4242424242424242"));
  cases.push(
    "snapshots name fields from labels and report focus, state, field help and secret-field markers without values",
  );
  // Controls with no usable name are still listed and located from the DOM:
  // nearby text, placeholder, title, image text, field name, form, group and
  // position. Unmarked secret fields are classified by their words.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form id="contact" aria-label="Contact details"><fieldset><legend>Where we reach you</legend><span>Phone</span><input id="phone" name="phone"><input name="zip" placeholder="ZIP code"></fieldset><input name="ssn"><input id="routingNumber"><label>Social Security number <input id="ss2"></label><label>PIN code <input id="pincode" name="postal_code"></label><button>Save</button></form><table><tr><td>Water bill</td><td><button type="button" class="row-pay">Open</button></td></tr><tr><td>Gas bill</td><td><button type="button" class="row-pay">Open</button></td></tr></table><div id="icon" style="cursor:pointer;width:20px;height:20px" onclick="document.querySelector(\'#count\').textContent=\'icon\'"><svg width="10" height="10"><title>Help</title></svg></div><span id="tip" title="Search the site" tabindex="0" style="display:inline-block;width:10px;height:10px"></span>',
    );
  });
  state = await snapshot();
  const by = (selector) =>
    state.value.elements.find((element) => element.targetSelector === selector);
  assert.equal(by("#phone").label, "");
  assert.equal(by("#phone").nearbyText, "Phone");
  assert.deepEqual(by("#phone").form, {
    index: 0,
    name: "Contact details",
  });
  assert.equal(by("#phone").group, "Where we reach you");
  assert.equal(by('input[name="zip"]').placeholder, "ZIP code");
  assert.equal(by('input[name="zip"]').fieldName, "zip");
  assert.equal(by('input[name="ssn"]').sensitive, "government-id");
  assert.equal(by("#routingNumber").sensitive, "bank-account");
  assert.equal(by("#ss2").sensitive, "government-id");
  assert.equal(by("#phone").sensitive, null);
  // An Indian "PIN code" postal field is an address field, not a password.
  assert.equal(by("#pincode").sensitive, null);
  const save = state.value.elements.find((element) => element.label === "Save");
  assert.equal(save.submits, true);
  assert.equal(by("#go").submits, false);
  const rows = state.value.elements.filter(
    (element) => element.label === "Open",
  );
  assert.deepEqual(
    rows.map((element) => element.nearbyText),
    ["Water bill", "Gas bill"],
  );
  assert.equal(new Set(rows.map((element) => element.targetSelector)).size, 2);
  for (const row of rows)
    assert.equal(
      await page.$$eval(row.targetSelector, (nodes) => nodes.length),
      1,
    );
  assert.equal(by("#icon").pressable, "click-handler");
  assert.equal(by("#icon").imageText, "Help");
  assert.equal(by("#tip").pressable, "tab-stop");
  assert.equal(by("#tip").title, "Search the site");
  // The page is 3000 pixels tall: the first button is on screen, the new
  // controls at its end are below it.
  assert.equal(by("#go").inViewport, true);
  assert.equal(by("#icon").inViewport, false);
  assert.ok(by("#icon").bounds.width > 0);
  cases.push(
    "unlabeled controls are listed with nearby text, placeholder, title, image text, field name, form, group, position and a unique selector; unmarked SSN and bank fields are secret",
  );
  // An unmarked secret field is never filled by a task, even when granted.
  const grant = {
    origin: new URL(page.url()).origin,
    expiresAt: Date.now() + 60000,
    targets: [
      { selector: 'input[name="ssn"]', action: "fill" },
      { selector: "#routingNumber", action: "fill" },
      { selector: "#phone", action: "fill" },
    ],
  };
  const fillAt = async (selector, text) => {
    state = await snapshot();
    return run({
      subaction: "fill",
      snapshotId: state.id,
      nodeId: by(selector).id,
      text,
      taskPolicy: grant,
    });
  };
  assert.equal(
    (await fillAt('input[name="ssn"]', "123-45-6789")).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(
    (await fillAt("#routingNumber", "021000021")).error.kind,
    "POLICY_BLOCKED",
  );
  assert.equal(await page.$eval('input[name="ssn"]', (node) => node.value), "");
  assert.equal((await fillAt("#phone", "5550100")).dispatched, true);
  assert.equal(await page.$eval("#phone", (node) => node.value), "5550100");
  cases.push(
    "a granted fill reaches an ordinary unlabeled field by its unique selector and never an unmarked SSN or routing field",
  );
  const out = testOutputPath("browser-page-freshness");
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/verification.json`,
    `${JSON.stringify({ browser: await browser.version(), cases, scope: "Chromium isolated-world page guards only; no installed native-host, Android, arbitrary-site or full human-only policy qualification" }, null, 2)}\n`,
  );
  process.stdout.write(
    `Passed ${cases.length} real Chromium page-guard cases.\n`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
