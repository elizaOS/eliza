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
  <p>Visible source text</p><span style="visibility:hidden">Hidden<span style="visibility:visible">Visible child</span></span>
  <input aria-label="Name"><textarea>private-textarea-value</textarea><div contenteditable>private-editable-value</div>
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
  assert.equal(
    (await act(state, "fill", "Name", { text: "agent" })).dispatched,
    true,
  );
  assert.equal(await page.$eval("input", (node) => node.value), "agent");
  assert.equal(
    (await act(state, "fill", "Name", { text: "replay" })).error.kind,
    "STALE_REF",
  );
  cases.push("fresh fill and consume-once reference");
  state = await snapshot();
  await page.type("input", "-manual");
  assert.equal(
    (await act(state, "fill", "Name", { text: "stale" })).error.kind,
    "STALE_REF",
  );
  assert.equal(await page.$eval("input", (node) => node.value), "agent-manual");
  cases.push("manual input wins");
  state = await snapshot();
  await page.$eval("input", (node) => {
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
      '<input id="secret" type="password" aria-label="Secret"><input id="otp" autocomplete="one-time-code" aria-label="Code"><button id="signin" type="button">Sign in</button><button id="pay" type="button">Pay now</button><button id="verify" type="button">Verify</button>',
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
    ],
  };
  for (const [label, subaction] of [
    ["Secret", "fill"],
    ["Code", "fill"],
    ["Sign in", "click"],
    ["Pay now", "click"],
    ["Verify", "click"],
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
  cases.push(
    "native-reviewed targets allow a declared ordinary action and reject undeclared fields, passwords, OTP, sign-in, verification and payment controls",
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
