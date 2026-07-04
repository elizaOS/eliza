/**
 * Playwright UI-smoke spec for the Files View app flow using the real renderer
 * fixture.
 */
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
 * Visual + smoke coverage for the BUILTIN "Files" view (/apps/files, #8876).
 *
 * The Files view lists stored files from `GET /api/files` and offers
 * download/share/delete + type facets. Here we stub `/api/files` with a
 * populated fixture (an image + a PDF) and `/api/media/**` with a tiny PNG so
 * the populated state renders, then capture it at desktop + mobile.
 *
 * Assertions are deliberately lenient (mirroring builtin-views-visual): the view
 * must mount, render readable content (the stubbed files surface), and never
 * throw an uncaught page error — the redesign/regression guard, not pixel-exact.
 */

// 1x1 transparent PNG so stubbed /api/media image tiles render without a fetch.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const FILES_FIXTURE = {
  files: [
    {
      fileName: `${HASH_A}.png`,
      url: `/api/media/${HASH_A}.png`,
      hash: HASH_A,
      mimeType: "image/png",
      size: 20_480,
      createdAt: 1_700_000_002_000,
    },
    {
      fileName: `${HASH_B}.pdf`,
      url: `/api/media/${HASH_B}.pdf`,
      hash: HASH_B,
      mimeType: "application/pdf",
      size: 51_200,
      createdAt: 1_700_000_001_000,
    },
  ],
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("Files view visual + smoke (desktop + mobile)", () => {
  for (const vp of VIEWPORTS) {
    test(`files ${vp.name}`, async ({ page }) => {
      const screenshotDir =
        process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
        path.join(process.cwd(), "test-results", "files-view");
      await mkdir(screenshotDir, { recursive: true });

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);

      // Registered AFTER the defaults so these take precedence (Playwright runs
      // route handlers in reverse registration order).
      await page.route("**/api/files", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(FILES_FIXTURE),
        }),
      );
      await page.route("**/api/media/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "image/png",
          body: Buffer.from(TINY_PNG_BASE64, "base64"),
        }),
      );

      await openAppPath(page, "/apps/files");

      const viewRoot = page.locator("main").first();
      await expect(viewRoot).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          async () =>
            viewRoot.evaluate(
              (root) => root.innerText.trim().replace(/\s+/g, " ").length,
            ),
          {
            message: `files ${vp.name} should render readable content`,
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(10);

      await captureScreenshotWithQualityRetry(page, `files ${vp.name}`, {
        fullPage: false,
        path: path.join(screenshotDir, `files-${vp.name}.png`),
        attempts: 3,
      });

      expect(
        pageErrors,
        `files ${vp.name} must not throw an uncaught page error`,
      ).toEqual([]);
    });
  }
});
