/**
 * camera-pose.spec.ts
 *
 * The XR view-host shell is a screen-space (head-locked) 2D DOM overlay — it must
 * stay full-frame as the head moves, so a panel "follows the camera". This drives
 * the REAL view-host route + the REAL IWER emulator (`window.__XREmulator`, the
 * shared `@elizaos/plugin-xr` harness) — start a session, set an extreme head
 * pose, and assert the shell stays in frame.
 *
 * Replaces the previous dead test, which called a `window.__xrEmulator.connect()`
 * / `.sendControl()` / global `setPose()` API that never existed and `test.skip`'d
 * on every run (false green). No skip here — it runs and asserts.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const BASE_URL = process.env.XR_BASE_URL ?? "http://localhost:31337";
const __dirname = dirname(fileURLToPath(import.meta.url));
// The single canonical XR emulator bundle (shared with plugin-xr — #9941).
const EMULATOR_BUNDLE = resolve(__dirname, "../../emulator/dist/emulator.js");

test.beforeEach(async ({ page }) => {
  // Inject the IWER emulator before the page loads (the harness pattern):
  // polyfills navigator.xr with a controllable Quest 3 + window.__XREmulator.
  const emulator = readFileSync(EMULATOR_BUNDLE, "utf8");
  await page.addInitScript({ content: emulator });
});

test.describe("XR view-host follows the camera (head-locked shell)", () => {
  test("emulator installs navigator.xr and an immersive session starts", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/wallet`);
    await page.waitForFunction(
      () => typeof window.__XREmulator !== "undefined",
    );

    expect(await page.evaluate(() => typeof navigator.xr !== "undefined")).toBe(
      true,
    );
    expect(await page.evaluate(() => window.__XREmulator.startSession())).toBe(
      true,
    );
    expect(
      await page.evaluate(() => window.__XREmulator.getStats().sessionActive),
    ).toBe(true);
  });

  test("the shell stays full-frame after an extreme head pose change", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/api/xr/view-host/wallet`);
    await page.waitForFunction(
      () => typeof window.__XREmulator !== "undefined",
    );
    await page.evaluate(() => window.__XREmulator.startSession());

    // Rotate the head 45° (yaw) and move it — the screen-space shell must not move.
    await page.evaluate(() =>
      window.__XREmulator.setPose({
        position: { x: 0, y: 1.6, z: 0.5 },
        orientation: { x: 0, y: 0.383, z: 0, w: 0.924 },
      }),
    );

    // setPose is reflected in the emulated head pose telemetry.
    const head = await page.evaluate(
      () => window.__XREmulator.getHeadPose().orientation.y,
    );
    expect(head).toBeCloseTo(0.383, 3);

    // The head-locked shell still covers the viewport.
    const covers = await page.evaluate(() => {
      const shell = document.getElementById("xr-shell");
      if (!shell) return false;
      const r = shell.getBoundingClientRect();
      return (
        r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2
      );
    });
    expect(covers, "head-locked shell stays full-frame").toBe(true);
  });
});
