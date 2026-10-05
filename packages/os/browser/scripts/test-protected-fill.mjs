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
  console.log(
    "PASS: OTP requires protected host marker and dedicated field permission; ordinary, password, non-OTP and Verify paths denied; code excluded from snapshot.",
  );
} finally {
  await browser.close();
}
