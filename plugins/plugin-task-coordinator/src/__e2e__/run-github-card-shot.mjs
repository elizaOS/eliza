/**
 * Browser review harness for every guided GitHub connection state.
 * It drives the real component in desktop and mobile viewports, asserts each
 * transition, and captures loading, success, cancellation, expiry, denial,
 * unavailable, retry, waiting, and connected pixels.
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
const fixtureUrl = `file://${join(outDir, "github-card.html")}`;

let failures = 0;
const errors = [];
function assert(condition, message) {
  console.log(`${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures += 1;
}

const cases = [
  {
    state: "loading",
    check: async (page) =>
      assert(
        (await page
          .getByText(/Loading this agent's GitHub connection/)
          .count()) === 1,
        "loading is distinct from disconnected",
      ),
  },
  {
    state: "success",
    action: async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.getByText("@eliza-agent-bot").waitFor();
    },
    check: async (page) =>
      assert(
        (await page.getByText("@eliza-agent-bot").count()) > 0,
        "successful device grant renders the connected identity",
      ),
  },
  {
    state: "device",
    name: "cancelled",
    action: async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.getByTestId("github-device-user-code").waitFor();
      await page.getByText("Cancel").click();
      await page.getByText(/sign-in was cancelled/).waitFor();
    },
    check: async (page) =>
      assert(
        (await page.getByText(/No credential was changed or removed/).count()) >
          0,
        "server-confirmed cancellation is explicit",
      ),
  },
  {
    state: "expired",
    action: async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.getByText(/sign-in code expired/).waitFor({ timeout: 5_000 });
    },
    check: async (page) =>
      assert(
        (await page.getByRole("button", { name: "Try again" }).count()) === 1,
        "expiry is retryable",
      ),
  },
  {
    state: "denied",
    action: async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.getByText(/sign-in was denied/).waitFor({ timeout: 5_000 });
    },
    check: async (page) =>
      assert(
        (await page.getByRole("button", { name: "Try again" }).count()) === 1,
        "denial is retryable",
      ),
  },
  {
    state: "unavailable",
    check: async (page) =>
      assert(
        (await page.getByText(/connection status is unavailable/).count()) ===
          1,
        "vault failure renders unavailable, never disconnected",
      ),
  },
  {
    state: "retry",
    action: async (page) => {
      await page.getByText("Retry").click();
      await page.getByText(/generate a token on github.com/i).waitFor();
    },
    check: async (page) =>
      assert(
        (await page.getByText(/generate a token on github.com/i).count()) === 1,
        "retry recovers to the disconnected state",
      ),
  },
  {
    state: "device",
    name: "waiting",
    action: async (page) => {
      await page.getByText("Sign in with GitHub").click();
      await page.getByTestId("github-device-user-code").waitFor();
    },
    check: async (page) =>
      assert(
        (await page.getByTestId("github-device-user-code").textContent()) ===
          "ELIZ-A123",
        "waiting state shows only the user code",
      ),
  },
  {
    state: "connected",
    check: async (page) =>
      assert(
        (await page.getByText("Reconnect").count()) === 1,
        "connected state offers reconnect",
      ),
  },
];

const browser = await chromium.launch({ args: ["--disable-gpu"] });
try {
  for (const viewport of [
    { label: "desktop", width: 1100, height: 700 },
    { label: "mobile", width: 402, height: 800 },
  ]) {
    for (const reviewCase of cases) {
      // A fresh page per state prevents a shrinking success render or a
      // surviving timer from carrying scroll/layout state into later proof.
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.goto(`${fixtureUrl}?state=${reviewCase.state}`);
        // Animated SVGs and transitions create transient compositor layers in
        // headless Chromium; freeze motion in evidence so every tile is stable.
        await page.addStyleTag({
          content:
            "*,*::before,*::after{animation:none!important;transition:none!important}",
        });
        await page.getByTestId("github-card-fixture").waitFor();
        await page.waitForTimeout(150);
        await reviewCase.action?.(page);
        await reviewCase.check(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        // State proofs stay at rest; the intentional hover proof is captured
        // separately below so a click's final pointer position cannot leak in.
        await page.mouse.move(viewport.width - 1, viewport.height - 1);
        const headerBox = await page
          .getByText("GitHub", { exact: true })
          .boundingBox();
        assert(
          headerBox !== null && headerBox.y >= 0,
          `${viewport.label} ${reviewCase.name ?? reviewCase.state} header is not clipped`,
        );
        const dimensions = await page.evaluate(() => ({
          viewportHeight: window.innerHeight,
          documentHeight: document.documentElement.scrollHeight,
        }));
        assert(
          dimensions.documentHeight <= dimensions.viewportHeight,
          `${viewport.label} ${reviewCase.name ?? reviewCase.state} full view fits in capture`,
        );
        await page.waitForTimeout(100);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        const name = reviewCase.name ?? reviewCase.state;
        await page.screenshot({
          path: join(outDir, `${viewport.label}-${name}.jpg`),
          animations: "disabled",
          caret: "hide",
          quality: 92,
          scale: "css",
          type: "jpeg",
        });
        if (name === "unavailable") {
          await page.getByText("Retry").hover();
          await page.waitForTimeout(100);
          await page.screenshot({
            path: join(outDir, `${viewport.label}-${name}-hover.jpg`),
            animations: "disabled",
            caret: "hide",
            quality: 92,
            scale: "css",
            type: "jpeg",
          });
        }
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}

assert(errors.length === 0, `no page errors (${errors.length})`);
for (const error of errors) console.error(error);
console.log(`Screenshots → ${outDir}`);
if (failures > 0) process.exitCode = 1;
