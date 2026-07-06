/**
 * Playwright UI-smoke spec for the Launcher Interaction app flow using the
 * real renderer fixture.
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

/**
 * Where the launcher page rail physically sits: the rail's computed transform
 * X plus one page's width. When page 0 is active the rail rests at x≈0; a
 * committed swipe to page 1 translates it to x≈-pageWidth. Asserting on this
 * (alongside the `aria-hidden` page state) proves the rail actually moved —
 * the same signal run-home-screen-e2e.mjs asserts after its real-touch swipe.
 */
async function railGeometry(
  page: Page,
): Promise<{ x: number; pageWidth: number }> {
  return page.getByTestId("launcher-page-rail").evaluate((el) => {
    const transform = getComputedStyle(el).transform;
    const matrix =
      transform && transform !== "none"
        ? new DOMMatrixReadOnly(transform)
        : new DOMMatrixReadOnly();
    const firstPage = el.querySelector('[data-testid="launcher-page-0"]');
    return {
      x: matrix.m41,
      pageWidth: (firstPage ?? el).getBoundingClientRect().width,
    };
  });
}

/**
 * REAL touch swipe across the launcher page window — CDP touch input in a
 * `hasTouch` context, the same parameters the boot-free launcher runner
 * (run-home-screen-e2e.mjs) drives paging with. There is deliberately NO
 * fallback here: if touch paging is broken, this test FAILS. The previous
 * version of this spec dispatched synthetic PointerEvents and silently fell
 * back to clicking the desktop `<`/`>` edge buttons whenever the "swipe"
 * didn't page, so it stayed green with touch paging entirely broken — the
 * exact anti-pattern #10722 de-larps. Edge buttons are covered by their own
 * explicit test below.
 */
async function touchSwipeLauncher(
  page: Page,
  direction: "next" | "prev",
): Promise<void> {
  const dx = direction === "next" ? -280 : 280;
  await touchSwipe(page, '[data-testid="launcher-page-window"]', dx, 0, {
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
 *
 * Unlike builtin-views-visual.spec (which only asserts each view boots without
 * crashing), this drives the catalog's actual controls against a live app
 * boot. The launcher has NO dock / featured-views surface (#11174): every view
 * is an ordinary tile on the swipeable pages, with the curated "Apps" page
 * (page 0) leading with Chat and Settings. Covered here: the no-dock contract,
 * curated page-0 ordering, REAL-touch swipe paging (#10722), tap-to-launch of
 * the Chat tile, and — separately and explicitly — the desktop `<`/`>` pager
 * edge buttons. Run with E2E_RECORD=1 to capture a video walkthrough.
 */
test.describe("launcher catalog interactions", () => {
  // Real CDP touch input is only accepted in a touch-enabled context, so the
  // paging lane opts into `hasTouch` (same pattern as chat-clear-swipe's
  // real-touch describe). The gesture itself is Chromium CDP; this spec runs
  // on the chromium project only.
  test.describe("real-touch swipe paging (#10722 — no synthetic events, no fallback)", () => {
    test.use({ hasTouch: true });

    for (const viewport of [
      { name: "desktop", size: { width: 1440, height: 1000 } },
      { name: "mobile", size: { width: 390, height: 844 } },
    ] as const) {
      test(`no dock, page tiles, real-touch swipe paging, and Chat tile launch on ${viewport.name}`, async ({
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

        const firstPage = page.getByTestId("launcher-page-0");
        // The featured-views dock was removed (#11174): no dock element exists,
        // and Chat/Settings are ordinary page tiles at the head of page 0.
        await expect(page.getByTestId("launcher-dock")).toHaveCount(0);
        await expect(firstPage.getByTestId("launcher-tile-chat")).toBeVisible();
        await expect(
          firstPage.getByTestId("launcher-tile-settings"),
        ).toBeVisible();
        await expect(
          firstPage.locator('[data-testid^="launcher-tile-"]').first(),
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
        const firstPageTileIds = await tileIds(firstPage);

        // The builtin catalog always curates multiple pages (Apps first, then
        // the overflow/Developer pages — launcher-curation.ts) — hard-assert
        // page 1 exists instead of conditionally skipping, so a regression to
        // a single page can never silently turn the swipe coverage into a
        // no-op.
        const secondPage = page.getByTestId("launcher-page-1");
        await expect(secondPage).toHaveCount(1);
        await expect(secondPage).toHaveAttribute("aria-hidden", "true");
        const railBefore = await railGeometry(page);

        // ── Swipe NEXT with a real finger. Page advancement is asserted on
        // the pager's real state (`aria-hidden` flips with the active page)
        // AND on the rail's physical transform — never on an edge-button
        // fallback.
        await touchSwipeLauncher(page, "next");
        await expect(secondPage).toHaveAttribute("aria-hidden", "false");
        await expect(firstPage).toHaveAttribute("aria-hidden", "true");
        await expect
          .poll(async () => (await railGeometry(page)).x, {
            message: "rail translates to page 1 after the real-touch swipe",
          })
          .toBeLessThan(-railBefore.pageWidth * 0.5);
        const railAfterNext = await railGeometry(page);
        // Page 2's tiles are really there (not just an attribute flip).
        await expect(
          secondPage.locator('[data-testid^="launcher-tile-"]').first(),
        ).toBeVisible();
        const secondPageTileIds = await tileIds(secondPage);
        expect(secondPageTileIds.length).toBeGreaterThan(0);
        await page.waitForTimeout(300);
        await screenshot(
          page,
          testInfo,
          `${viewport.name}-launcher-after-swipe`,
        );

        // ── Swipe PREV back to the Apps page — same real-touch path.
        await touchSwipeLauncher(page, "prev");
        await expect(firstPage).toHaveAttribute("aria-hidden", "false");
        await expect(secondPage).toHaveAttribute("aria-hidden", "true");
        await expect
          .poll(async () => (await railGeometry(page)).x, {
            message: "rail translates back to page 0 after the prev swipe",
          })
          .toBeGreaterThan(-railBefore.pageWidth * 0.5);
        const railAfterPrev = await railGeometry(page);

        // Chat launches from its ordinary page tile on page 0.
        await firstPage
          .getByTestId("launcher-tile-chat")
          .locator("button")
          .click();
        await expect
          .poll(() => new URL(page.url()).hash + new URL(page.url()).pathname)
          .toContain("/chat");
        await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
        await page.waitForTimeout(300);
        await screenshot(page, testInfo, `${viewport.name}-chat-tile-launched`);

        const evidence = {
          viewport: viewport.name,
          firstPageTiles: firstPageTileIds,
          secondPageTiles: secondPageTileIds,
          pageAdvance: "real-cdp-touch-swipe" as const,
          rail: {
            pageWidth: railBefore.pageWidth,
            xBefore: railBefore.x,
            xAfterNextSwipe: railAfterNext.x,
            xAfterPrevSwipe: railAfterPrev.x,
          },
          finalUrl: page.url(),
          pageErrors,
          httpErrors,
          consoleLines,
        };
        // Curated "Apps" page order leads with Chat then Settings
        // (launcher-curation.ts APPS_PAGE_ORDER) — as page tiles, not a dock.
        expect(evidence.firstPageTiles.slice(0, 2)).toEqual([
          "chat",
          "settings",
        ]);
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

  // The `<`/`>` pager edge buttons are a REAL desktop affordance (#10717:
  // fine-pointer / hover-capable devices, where the swipe gesture is not the
  // sole navigation). They get their own explicit assertions here — in the
  // default non-touch Desktop Chrome context where they actually render —
  // instead of doubling as a silent fallback inside the swipe test.
  test("desktop pager edge buttons page next/prev (explicit affordance, not a swipe fallback)", async ({
    page,
  }, testInfo) => {
    await bootLauncher(page, { width: 1440, height: 1000 });

    const firstPage = page.getByTestId("launcher-page-0");
    const secondPage = page.getByTestId("launcher-page-1");
    await expect(secondPage).toHaveCount(1);
    await expect(firstPage).toHaveAttribute("aria-hidden", "false");

    // On page 0 only the `>` button renders (canPrev is false at the first
    // page, PagerEdgeButtons self-hides the dead direction).
    const nextButton = page.getByTestId("launcher-pager-edge-next");
    await expect(nextButton).toBeVisible();
    await expect(page.getByTestId("launcher-pager-edge-prev")).toHaveCount(0);

    await nextButton.click();
    await expect(secondPage).toHaveAttribute("aria-hidden", "false");
    await expect(firstPage).toHaveAttribute("aria-hidden", "true");

    // And back: off page 0, `<` appears (no assumption that page 1 is the
    // LAST page — the catalog may curate more than two pages, in which case
    // `>` legitimately stays visible here).
    const prevButton = page.getByTestId("launcher-pager-edge-prev");
    await expect(prevButton).toBeVisible();
    await prevButton.click();
    await expect(firstPage).toHaveAttribute("aria-hidden", "false");
    await expect(secondPage).toHaveAttribute("aria-hidden", "true");
    // canPrev self-hide re-engages at the first page.
    await expect(page.getByTestId("launcher-pager-edge-prev")).toHaveCount(0);

    await screenshot(page, testInfo, "desktop-launcher-edge-buttons");
  });
});
