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

test("landing permits a trusted browser pinch while retaining horizontal swipe", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const session = await context.newCDPSession(page);
  await session.send("Input.synthesizePinchGesture", {
    x: 195,
    y: 422,
    scaleFactor: 2,
    relativeSpeed: 800,
    gestureSourceType: "touch",
  });

  await expect
    .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
    .toBeGreaterThanOrEqual(1.9);

  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  const telegram = page.getByRole("button", { name: "Telegram" });
  await expect(telegram).toHaveAttribute("aria-pressed", "false");
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 300, y: 400 }],
  });
  for (const x of [260, 220, 180, 140, 100]) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: 400 }],
    });
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(telegram).toHaveAttribute("aria-pressed", "true");
  await context.close();
});

for (const viewport of REFLOW_VIEWPORTS) {
  test(`landing reflows at 200% in ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await applyTwoHundredPercentTextSize(page);

    await expectNoUnreachableOverflow(page);
    for (const name of ["iMessage", "Telegram", "Discord", "Try Now"]) {
      await expectFullyInViewport(
        page,
        page.getByRole("button", { name }).first(),
      );
    }
    await expectFullyInViewport(page, page.locator("header a"));
    const namedControl = (name: string) =>
      page.getByRole("button", { name }).first();
    for (const [first, second] of [
      ["Back", "Telegram"],
      ["Open video call", "Discord"],
      ["Eliza", "iMessage"],
      ["Get Started", "Try Now"],
    ]) {
      const firstControl =
        first === "Get Started"
          ? page.locator("header a")
          : namedControl(first);
      await expectControlsNotToOverlap(firstControl, namedControl(second));
    }
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
