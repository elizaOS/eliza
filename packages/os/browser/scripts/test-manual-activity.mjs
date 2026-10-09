/** Real Chromium event semantics; transport is an explicit in-page test adapter. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installManualActivity } from "../src/manual-activity.mjs";

const browser = await chromium.launch({
  headless: true,
  ...(process.env.ELIZA_BROWSER_EXECUTABLE
    ? { executablePath: process.env.ELIZA_BROWSER_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage();
  const messages = [];
  await page.exposeFunction("__recordManualActivity", (message) => {
    messages.push(message);
    return { recorded: true };
  });
  await page.route("https://manual.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<form><input name="private" value="never-record-this"><button>Submit test</button></form><form id="signin"><input autocomplete="username" name="user" value="private-user"><button>Next</button></form><script>for(const form of document.forms)form.onsubmit=event=>event.preventDefault();</script>',
    }),
  );
  await page.goto("https://manual.example/form");
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: (message) => globalThis.__recordManualActivity(message),
      },
    };
  });
  const install = (revision, expiresAt) =>
    page.evaluate(
      `(${installManualActivity.toString()})(${revision}, ${expiresAt})`,
    );
  await install(1, Date.now() + 60000);
  await page.evaluate(() => document.querySelector("form").requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(
    messages.length,
    0,
    "script-only submission is not human activation",
  );
  await page.getByRole("button", { name: "Submit test" }).click();
  await page.waitForFunction(
    () => globalThis.__elizaManualActivityV1 !== undefined,
  );
  await page.waitForTimeout(100);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "form-submit");
  assert.equal(messages[0].credential, undefined);
  assert.equal(JSON.stringify(messages).includes("never-record-this"), false);
  // A user-name step of a sign-in is marked as a sign-in form, value-free.
  await page.getByRole("button", { name: "Next" }).click();
  await page.waitForTimeout(100);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].credential, true);
  assert.equal(JSON.stringify(messages).includes("private-user"), false);
  messages.pop();
  await install(2, Date.now() + 60000);
  await page.getByRole("button", { name: "Submit test" }).click();
  await page.waitForTimeout(100);
  assert.equal(messages.length, 2);
  assert.equal(
    messages[1].bindingRevision,
    2,
    "rebind removes the old listener",
  );
  await install(3, Date.now() - 1);
  await page.getByRole("button", { name: "Submit test" }).click();
  await page.waitForTimeout(100);
  assert.equal(messages.length, 2, "expired capture is silent");
  await page.evaluate(() => {
    chrome.runtime.sendMessage = async () => {
      throw new Error("test transport lost");
    };
  });
  await install(4, Date.now() + 60000);
  await page.getByRole("button", { name: "Submit test" }).click();
  await page.waitForTimeout(100);
  assert.equal(
    (await install(5, Date.now() + 60000)).captureGap,
    true,
    "failed transport remains an explicit capture gap",
  );
  console.log(
    "PASS: Chromium trusted activation, script-only refusal, value exclusion, sign-in form marking, rebind, expiry and failed transport gap; simulated message transport only.",
  );
} finally {
  await browser.close();
}
