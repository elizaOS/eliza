import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { VIEW_CASES } from "./plugin-view-cases";

/**
 * Generic per-view interaction coverage for PLUGIN views (#8796).
 *
 * The sibling all-views-interaction.spec covers built-in views; this applies
 * the same "exercise every control, assert no uncaught crash" pass to the
 * dynamically-loaded plugin view bundles (GUI variants), so plugin views get
 * control-level coverage too — not just boot/render. Run with E2E_RECORD=1 for
 * per-view video.
 */

const GUI_CASES = VIEW_CASES.filter((c) => c.viewType === "gui");

const MAX_CLICKS = 20;
const MAX_INPUTS = 6;
const CLICK_SELECTOR =
  "button:visible, [role='button']:visible, [role='tab']:visible, [role='menuitem']:visible, a[href^='#']:visible";
const INPUT_SELECTOR =
  "input:visible:not([type='file']):not([disabled]), textarea:visible:not([disabled])";

test.describe("plugin view interaction coverage", () => {
  for (const view of GUI_CASES) {
    test(`${view.id} — exercise every control, no crash`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      await page.setViewportSize({ width: 1440, height: 1000 });
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });
      // Let the dynamic bundle mount before exercising controls.
      await expect(page.getByText("Failed to load view")).toHaveCount(0, {
        timeout: 30_000,
      });

      const inputs = page.locator(INPUT_SELECTOR);
      const inputCount = Math.min(await inputs.count(), MAX_INPUTS);
      for (let i = 0; i < inputCount; i += 1) {
        await inputs
          .nth(i)
          .fill("test", { timeout: 2_000 })
          .catch(() => {});
      }

      const clickCount = Math.min(
        await page.locator(CLICK_SELECTOR).count(),
        MAX_CLICKS,
      );
      for (let i = 0; i < clickCount; i += 1) {
        await page
          .locator(CLICK_SELECTOR)
          .nth(i)
          .click({ timeout: 2_000 })
          .catch(() => {});
        if (!page.url().includes(view.path)) {
          await openAppPath(page, view.path).catch(() => {});
        }
        await page.keyboard.press("Escape").catch(() => {});
      }

      expect(
        pageErrors,
        `${view.id}: a control interaction threw an uncaught error`,
      ).toEqual([]);
    });
  }
});
