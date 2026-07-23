/**
 * Playwright UI-smoke coverage for the launcher's single-grid interaction flow
 * using the real renderer fixture on desktop and mobile viewports.
 */
import { mkdir, writeFile } from "node:fs/promises";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
// Shared REAL-touch gesture helper (#10722): genuine CDP
// `Input.dispatchTouchEvent` through the browser's hit-test / touch-action /
// implicit-capture pipeline — NOT a synthetic `el.dispatchEvent(new
// PointerEvent(...))` that bypasses all of it.
import { touchSwipe } from "../../../ui/src/testing/real-touch-gestures";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.jpg`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: screenshotPath,
    type: "jpeg",
    quality: 90,
    fullPage: false,
    attempts: 4,
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
}

async function writeEvidenceFile(
  testInfo: TestInfo,
  name: string,
  body: string,
): Promise<void> {
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(testInfo.outputPath(name), body);
}

async function installLauncherEvidenceRoutes(page: Page): Promise<void> {
  await page.route("**/api/avatar/vrm", async (route) => {
    const method = route.request().method();
    if (method !== "HEAD" && method !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 204 });
  });
}

async function tileIds(scope: Locator): Promise<string[]> {
  return scope.locator('[data-testid^="launcher-tile-"]').evaluateAll((nodes) =>
    nodes
      .map((node) => node.getAttribute("data-testid") ?? "")
      .filter(Boolean)
      .map((id) => id.replace("launcher-tile-", "")),
  );
}

async function touchScrollLauncher(
  page: Page,
  scrollTestId: string,
  direction: "down" | "up",
): Promise<void> {
  const dy = direction === "down" ? -360 : 360;
  await touchSwipe(page, `[data-testid="${scrollTestId}"]`, 0, dy, {
    steps: 10,
    stepDelayMs: 16,
  });
}

async function bootLauncher(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installLauncherEvidenceRoutes(page);
  await openAppPath(page, "/views");
  await expect(page.getByTestId("launcher")).toBeVisible({
    timeout: 60_000,
  });
}

/**
 * Interaction-level coverage for the iOS-like view catalog (Launcher, #8796).
 * The current launcher is one vertically scrollable grid: Chat is the ambient
 * home composer rather than a duplicate tile, and paging controls no longer
 * exist. This drives the real touch-scrolling and tile-navigation paths against
 * a live app boot. Run with E2E_RECORD=1 to capture a video walkthrough.
 */
test.describe("launcher catalog interactions", () => {
  test.describe("single-grid touch and navigation", () => {
    test.use({ hasTouch: true });

    for (const viewport of [
      { name: "desktop", size: { width: 1440, height: 1000 } },
      { name: "mobile", size: { width: 390, height: 844 } },
    ] as const) {
      test(`single grid, real-touch scrolling, and Browser tile launch on ${viewport.name}`, async ({
        page,
      }, testInfo) => {
        const consoleLines: string[] = [];
        const pageErrors: string[] = [];
        const httpErrors: string[] = [];
        page.on("console", (message) =>
          consoleLines.push(`${message.type()}: ${message.text()}`),
        );
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("response", (response) => {
          if (response.status() < 400) return;
          httpErrors.push(
            `${response.status()} ${response.request().method()} ${response.url()}`,
          );
        });

        await bootLauncher(page, viewport.size);

        const grid = page.getByTestId("launcher-page-window");
        await expect(page.getByTestId("launcher-dock")).toHaveCount(0);
        await expect(page.getByTestId("launcher-page-rail")).toHaveCount(0);
        await expect(page.getByTestId("launcher-page-1")).toHaveCount(0);
        await expect(page.getByTestId("launcher-tile-chat")).toHaveCount(0);
        await expect(grid.getByTestId("launcher-tile-settings")).toBeVisible();
        await expect(
          grid.locator('[data-testid^="launcher-tile-"]').first(),
        ).toBeVisible();
        await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
        await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);

        await page.waitForTimeout(300);
        await screenshot(
          page,
          testInfo,
          `${viewport.name}-launcher-page-tiles`,
        );
        const tileIdsInGrid = await tileIds(grid);
        expect(tileIdsInGrid.length).toBeGreaterThan(8);
        expect(tileIdsInGrid.slice(0, 2)).toEqual(["settings", "wallet"]);

        let scrollTopAfterTouch = 0;
        if (viewport.name === "mobile") {
          // The launcher is embedded on Home, whose bounded apps region owns
          // vertical overflow; the inner grid deliberately stays natural-height.
          const scrollHost = page.getByTestId("home-apps-scroll");
          await expect
            .poll(() => scrollHost.evaluate((element) => element.scrollHeight))
            .toBeGreaterThan(
              await scrollHost.evaluate((element) => element.clientHeight),
            );
          await touchScrollLauncher(page, "home-apps-scroll", "down");
          await expect
            .poll(() => scrollHost.evaluate((element) => element.scrollTop), {
              message:
                "the single launcher grid scrolls after a real touch swipe",
            })
            .toBeGreaterThan(0);
          scrollTopAfterTouch = await scrollHost.evaluate(
            (element) => element.scrollTop,
          );
          await screenshot(
            page,
            testInfo,
            `${viewport.name}-launcher-after-touch-scroll`,
          );
          await touchScrollLauncher(page, "home-apps-scroll", "up");
          await expect
            .poll(() => scrollHost.evaluate((element) => element.scrollTop))
            .toBeLessThan(scrollTopAfterTouch);
        }

        await grid
          .getByTestId("launcher-tile-browser")
          .locator("button")
          .click();
        await expect
          .poll(() => new URL(page.url()).hash + new URL(page.url()).pathname)
          .toContain("/browser");
        await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
        await page.waitForTimeout(300);
        await screenshot(
          page,
          testInfo,
          `${viewport.name}-browser-tile-launched`,
        );

        const evidence = {
          viewport: viewport.name,
          tiles: tileIdsInGrid,
          layout: "single-vertical-grid" as const,
          scrollTopAfterTouch,
          finalUrl: page.url(),
          pageErrors,
          httpErrors,
          consoleLines,
        };
        expect(pageErrors, "no uncaught page errors").toEqual([]);
        expect(httpErrors, "no HTTP error responses").toEqual([]);

        await writeEvidenceFile(
          testInfo,
          `${viewport.name}-launcher-observations.json`,
          `${JSON.stringify(evidence, null, 2)}\n`,
        );
        await testInfo.attach(`${viewport.name} launcher observations`, {
          body: JSON.stringify(evidence, null, 2),
          contentType: "application/json",
        });
      });
    }
  });
});
