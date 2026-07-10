/**
 * Real-browser screenshots of the GitHub connection card's guided-setup
 * states (#15796). Runs the esbuild bundle step under bun (see
 * build-github-card-fixture.mjs), loads the resulting page in headless
 * chromium with the brand palette wired into Tailwind, drives the real
 * component (clicks the sign-in button, waits for the device code / error),
 * and captures desktop + mobile.
 *
 * Run under node (playwright's launcher wedges under bun on Windows):
 *   node plugins/plugin-task-coordinator/src/__e2e__/run-github-card-shot.mjs
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "github-card-shots");

execFileSync("bun", ["run", join(here, "build-github-card-fixture.mjs")], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
const url = `file://${join(outDir, "github-card.html")}`;

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const errors = [];
try {
  const shoot = async (page, state, actions, checks, file) => {
    await page.goto(`${url}?state=${state}`);
    await page.waitForSelector('[data-testid="github-card-fixture"]');
    await page.waitForTimeout(400);
    if (actions) await actions(page);
    if (checks) await checks(page);
    await page.screenshot({ path: join(outDir, file), fullPage: true });
    console.log(`  \u{1F4F8} ${file}`);
  };

  const desktop = await browser.newPage({
    viewport: { width: 1100, height: 700 },
    deviceScaleFactor: 2,
  });
  desktop.on("pageerror", (e) => errors.push(String(e)));

  // BEFORE-equivalent: no oauth client id configured — PAT paste only (this is
  // the entire card as it existed before this change).
  await shoot(
    desktop,
    "pat-only",
    null,
    async (page) => {
      assert(
        (await page.getByText("Sign in with GitHub").count()) === 0,
        "pat-only state hides the device sign-in button",
      );
      assert(
        (await page.getByText(/Generate a token/).count()) > 0,
        "pat-only state keeps the PAT link",
      );
    },
    "01-before-pat-only-desktop.png",
  );

  // AFTER: device flow available — guided sign-in button offered.
  await shoot(
    desktop,
    "device",
    null,
    async (page) => {
      assert(
        (await page.getByText("Sign in with GitHub").count()) === 1,
        "device state offers the guided sign-in button",
      );
    },
    "02-after-signin-offered-desktop.png",
  );

  // AFTER: sign-in clicked — user code shown, waiting for approval.
  await shoot(
    desktop,
    "device",
    async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.waitForSelector('[data-testid="github-device-user-code"]');
      await page.waitForTimeout(300);
    },
    async (page) => {
      assert(
        (await page.getByTestId("github-device-user-code").textContent()) ===
          "ELIZ-A123",
        "waiting state shows the short user code",
      );
      assert(
        (await page.evaluate(() => window.__openedExternal)) ===
          "https://github.com/login/device",
        "sign-in opens github.com/login/device externally",
      );
    },
    "03-after-device-code-waiting-desktop.png",
  );

  // AFTER: user denied on github.com — actionable error, button recovers.
  await shoot(
    desktop,
    "denied",
    async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.waitForSelector("text=/sign-in was denied/");
      await page.waitForTimeout(200);
    },
    async (page) => {
      assert(
        (await page
          .getByText(/paste a personal access token instead/)
          .count()) > 0,
        "denied state suggests the PAT fallback",
      );
    },
    "04-after-denied-error-desktop.png",
  );

  // AFTER: connected state.
  await shoot(
    desktop,
    "connected",
    null,
    async (page) => {
      assert(
        (await page.getByText("@eliza-agent-bot").count()) > 0,
        "connected state shows the GitHub login",
      );
    },
    "05-after-connected-desktop.png",
  );
  await desktop.close();

  const mobile = await browser.newPage({
    viewport: { width: 402, height: 800 },
    deviceScaleFactor: 2,
  });
  mobile.on("pageerror", (e) => errors.push(String(e)));
  await shoot(mobile, "pat-only", null, null, "06-before-pat-only-mobile.png");
  await shoot(
    mobile,
    "device",
    async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.waitForSelector('[data-testid="github-device-user-code"]');
      await page.waitForTimeout(300);
    },
    null,
    "07-after-device-code-waiting-mobile.png",
  );
  await mobile.close();
} finally {
  await browser.close();
}

assert(errors.length === 0, `no page errors (${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);
console.log(`\nScreenshots → ${outDir}`);
if (failures > 0) {
  process.exitCode = 1;
}
