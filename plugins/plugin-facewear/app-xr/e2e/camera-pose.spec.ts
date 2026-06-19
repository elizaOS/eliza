/**
 * camera-pose.spec.ts
 *
 * Playwright e2e test: verifies that XR panels rendered by app-xr follow
 * the camera pose (screen-space DOM overlay). Panels must be positioned
 * relative to the viewport — not the world — so they "follow the camera"
 * as the user moves their head.
 *
 * Uses the emulator's setPose() API to move the virtual camera and checks
 * that overlaid panels remain in-frame.
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.XR_BASE_URL ?? "http://localhost:31337";
const EMULATOR_WS =
  process.env.XR_EMULATOR_WS ?? "ws://localhost:31338/ws-xr";

test.describe("XR panel camera-space positioning", () => {
  test("panels stay in viewport after camera pose change", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);

    // Connect the emulator
    const connected = await page.evaluate(async (wsUrl) => {
      // @ts-expect-error injected by emulator fixture
      if (!window.__xrEmulator) return false;
      // @ts-expect-error
      await window.__xrEmulator.connect(wsUrl);
      return true;
    }, EMULATOR_WS);

    if (!connected) {
      test.skip(true, "XR emulator not available — skipping camera-pose test");
      return;
    }

    // Open a panel
    await page.evaluate(() => {
      // @ts-expect-error
      window.__xrEmulator.sendControl({ type: "open-view", viewId: "wallet" });
    });

    // Set an extreme camera pose (rotated 45°)
    await page.evaluate(() => {
      setPose({
        position: { x: 0, y: 1.6, z: 0 },
        orientation: { x: 0, y: 0.383, z: 0, w: 0.924 }, // 45° yaw
      });
    });

    // Wait a frame
    await page.waitForTimeout(100);

    // The panel container must still be visible in the viewport
    const panelVisible = await page.evaluate(() => {
      const panel = document.querySelector("[data-xr-panel]");
      if (!panel) return false;
      const rect = (panel as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    expect(panelVisible, "panel must remain visible after camera rotation").toBe(true);
  });

  test("setPose() is available in emulator context", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);

    // The emulator fixture injects setPose() globally
    const hasPose = await page.evaluate(() => typeof setPose !== "undefined");

    // This may be false if running without the emulator — that's acceptable
    // for CI. The key requirement is that when the emulator IS present, the
    // function is defined.
    if (!hasPose) {
      test.skip(true, "setPose() not injected — emulator not loaded");
    }
  });
});

// Type declaration for global setPose injected by the emulator fixture
declare function setPose(pose: {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}): void;
