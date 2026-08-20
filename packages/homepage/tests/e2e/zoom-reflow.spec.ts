/**
 * Real Chromium regressions for browser pinch zoom and 200% text reflow on
 * the public homepage routes.
 */

import { expect, type Locator, type Page, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";

const REFLOW_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 812, height: 375 },
  { width: 1440, height: 900 },
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

async function expectNoClippedHorizontalOverflow(
  page: Page,
  selectors: readonly string[],
) {
  for (const selector of selectors) {
    await expect
      .poll(async () => {
        const overflows = await page
          .locator(selector)
          .evaluateAll((elements) =>
            elements
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => element.scrollWidth - element.clientWidth),
          );
        return overflows.every((overflow) => overflow <= 0);
      })
      .toBe(true);
  }
}

async function expectFullyInViewport(page: Page, locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  // Browser text scaling can place the fractional CSS-pixel edge just past
  // the integer viewport while the control remains fully painted.
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
    (page.viewportSize()?.height ?? 0) + 1,
  );
}

for (const viewport of REFLOW_VIEWPORTS) {
  test(`landing reflows at 200% in ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await applyTwoHundredPercentTextSize(page);
    await waitForLandingIntro(page);

    await expectNoUnreachableOverflow(page);
    if (viewport.width <= 640) {
      await expectNoClippedHorizontalOverflow(page, [
        ".landing-page",
        ".landing-hero",
        ".landing-phone-stage",
        ".landing-iphone",
        ".landing-iphone-screen",
        ".landing-phone-header",
        ".landing-phone-contact",
        ".landing-phone-thread",
        ".landing-bubble",
        ".landing-composer-row",
        ".landing-phone-composer",
        ".landing-tap-target",
      ]);
      await expect(page.locator(".landing-header")).toBeHidden();
      await expect(page.locator(".landing-hero-actions")).toBeHidden();
      const hiddenHeading = await page
        .locator(".landing-hero-heading")
        .evaluate((heading) => {
          const style = getComputedStyle(heading);
          return {
            clipPath: style.clipPath,
            height: style.height,
            overflow: style.overflow,
            position: style.position,
            width: style.width,
          };
        });
      expect(hiddenHeading).toEqual({
        clipPath: "inset(50%)",
        height: "1px",
        overflow: "hidden",
        position: "absolute",
        width: "1px",
      });

      const thread = page.locator(".landing-iphone");
      await expectFullyInViewport(page, thread);
      await expect(thread).toHaveCSS("border-radius", "0px");

      const contactSheetTrigger = page.getByRole("button", {
        name: "All the ways to reach Eliza",
      });
      await expectFullyInViewport(page, contactSheetTrigger);
      await contactSheetTrigger.click();

      const contactSheet = page.getByRole("dialog");
      await expect(contactSheet).toBeVisible();
      await expectNoClippedHorizontalOverflow(page, [
        ".landing-sheet",
        ".landing-sheet-body",
        ".landing-sheet-options",
        ".landing-sheet-row",
        ".landing-sheet-close",
      ]);
      const sheetActions = [
        contactSheet.getByRole("button", { name: "Text Eliza on iMessage" }),
        contactSheet.getByRole("button", { name: "Call Eliza" }),
        contactSheet.getByRole("link", {
          name: "Message Eliza on Telegram",
        }),
        contactSheet.getByRole("link", {
          name: "Message Eliza on Discord",
        }),
        contactSheet.getByRole("link", {
          name: "Sign in to Eliza Cloud",
        }),
        contactSheet.getByRole("button", { name: "Close" }),
      ];
      for (const action of sheetActions) {
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeVisible();
        await expectFullyInViewport(page, action);
      }
    } else {
      await expectNoClippedHorizontalOverflow(page, [
        ".landing-page",
        ".landing-hero",
        ".landing-hero-copy",
        ".landing-hero-actions",
        ".landing-header-cta",
        ".landing-cta--black",
        ".landing-cta--white",
        ".landing-iphone-screen",
        ".landing-phone-thread",
        ".landing-bubble",
        ".landing-phone-composer",
      ]);
      const textCta = page.getByRole("button", { name: "Text" });
      const callCta = page.getByRole("link", { name: "Call" });
      await textCta.scrollIntoViewIfNeeded();
      await expectFullyInViewport(page, textCta);
      await callCta.scrollIntoViewIfNeeded();
      await expectFullyInViewport(page, callCta);
      await expect(page.locator(".landing-header")).toBeVisible();
      await expect(page.locator(".landing-hero-heading")).toBeVisible();
      await expect(page.locator(".landing-iphone")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "All the ways to reach Eliza" }),
      ).toBeHidden();
    }
    await expect(page.getByText("+1 (808) 788-1821")).toHaveCount(0);
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
