/**
 * Real Chromium regressions for browser pinch zoom and 200% text reflow on
 * the public homepage routes.
 */

import { expect, type Locator, type Page, test } from "playwright/test";

const REFLOW_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 812, height: 375 },
] as const;

async function applyTwoHundredPercentTextSize(page: Page) {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "font-size",
        ),
      ),
    )
    .toBe("32px");
}

async function expectNoUnreachableOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
}

async function expectFullyInViewport(page: Page, locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.height ?? 0,
  );
}

async function expectControlsNotToOverlap(first: Locator, second: Locator) {
  const firstBounds = await first.boundingBox();
  const secondBounds = await second.boundingBox();
  expect(firstBounds).not.toBeNull();
  expect(secondBounds).not.toBeNull();
  const overlapWidth =
    Math.min(
      (firstBounds?.x ?? 0) + (firstBounds?.width ?? 0),
      (secondBounds?.x ?? 0) + (secondBounds?.width ?? 0),
    ) - Math.max(firstBounds?.x ?? 0, secondBounds?.x ?? 0);
  const overlapHeight =
    Math.min(
      (firstBounds?.y ?? 0) + (firstBounds?.height ?? 0),
      (secondBounds?.y ?? 0) + (secondBounds?.height ?? 0),
    ) - Math.max(firstBounds?.y ?? 0, secondBounds?.y ?? 0);
  expect(overlapWidth <= 1 || overlapHeight <= 1).toBe(true);
}

for (const viewport of REFLOW_VIEWPORTS) {
  test(`landing reflows at 200% in ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await applyTwoHundredPercentTextSize(page);

    await expectNoUnreachableOverflow(page);
    // The zoomed page may scroll vertically; each control must be reachable
    // by scrolling and fit fully inside the viewport once scrolled to.
    const textCta = page.getByRole("link", { name: "Text" });
    const callCta = page.getByRole("link", { name: "Call" });
    await textCta.scrollIntoViewIfNeeded();
    await expectFullyInViewport(page, textCta);
    await callCta.scrollIntoViewIfNeeded();
    await expectFullyInViewport(page, callCta);
    await expectControlsNotToOverlap(textCta, callCta);
  });

  test(`downloads reflows at 200% in ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/downloads", { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: /Your Eliza, everywhere/i })
      .waitFor();
    await applyTwoHundredPercentTextSize(page);

    await expectNoUnreachableOverflow(page);
    for (const name of ["Web app", "Downloads", "Cloud", "OS", "Download"]) {
      await expectFullyInViewport(
        page,
        page
          .getByRole("navigation", { name: "Eliza products" })
          .getByRole("link", { name, exact: true }),
      );
    }
  });
}
