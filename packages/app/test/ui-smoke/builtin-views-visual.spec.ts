import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

/**
 * Visual coverage for the BUILTIN views — the pages rendered directly by the
 * App.tsx ViewRouter (not the plugin view bundles, which are covered by
 * plugin-views-visual.spec). Each is captured at desktop + mobile so the
 * minimal/light redesign stays regression-guarded at both viewports.
 *
 * Assertions are deliberately lenient: the deterministic stub backend answers
 * some routes with 501 (surfaced as console errors / in-view error cards), which
 * is expected. We guard the things the redesign must never regress: the view
 * mounts, renders readable content, and does not throw an UNCAUGHT page error
 * (a real crash — e.g. an undefined reference), at either viewport.
 */
const BUILTIN_VIEW_CASES: Array<{ id: string; path: string }> = [
  { id: "views", path: "/views" },
  { id: "settings", path: "/settings" },
  { id: "plugins", path: "/apps/plugins" },
  { id: "character", path: "/character" },
  { id: "automations", path: "/automations" },
  { id: "memories", path: "/apps/memories" },
  { id: "database", path: "/apps/database" },
  { id: "logs", path: "/apps/logs" },
  { id: "camera", path: "/camera" },
  { id: "help", path: "/help" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("builtin views visual coverage (desktop + mobile)", () => {
  for (const view of BUILTIN_VIEW_CASES) {
    for (const vp of VIEWPORTS) {
      test(`${view.id} ${vp.name}`, async ({ page }) => {
        const screenshotDir =
          process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
          path.join(process.cwd(), "test-results", "builtin-views");
        await mkdir(screenshotDir, { recursive: true });

        // Only uncaught page errors (real crashes) fail the test; stub 501s
        // arrive as console errors and are expected.
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await seedAppStorage(page);
        await installDefaultAppRoutes(page);
        await openAppPath(page, view.path);

        const viewRoot = page.locator("main").first();
        await expect(viewRoot).toBeVisible({ timeout: 60_000 });
        await expect
          .poll(
            async () =>
              viewRoot.evaluate(
                (root) => root.innerText.trim().replace(/\s+/g, " ").length,
              ),
            {
              message: `${view.id} ${vp.name} should render readable content`,
              timeout: 30_000,
            },
          )
          .toBeGreaterThan(10);

        await captureScreenshotWithQualityRetry(
          page,
          `${view.id} ${vp.name}`,
          {
            fullPage: false,
            path: path.join(screenshotDir, `${view.id}-${vp.name}.png`),
            attempts: 3,
          },
        );

        expect(
          pageErrors,
          `${view.id} ${vp.name} must not throw an uncaught page error`,
        ).toEqual([]);
      });
    }
  }
});
