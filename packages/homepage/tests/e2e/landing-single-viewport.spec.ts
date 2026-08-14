/**
 * Responsive coverage for the landing page's one-screen product promise.
 * The smallest supported phone through a normal desktop must retain the full
 * hero and demo without document scrolling or horizontal overflow.
 */

import { expect, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`landing fits ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForLandingIntro(page);

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      phone: document
        .querySelector(".landing-iphone")
        ?.getBoundingClientRect()
        .toJSON(),
    }));

    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.documentHeight).toBe(layout.viewportHeight);
    expect(layout.phone).toBeDefined();
    expect(layout.phone?.top).toBeGreaterThanOrEqual(0);
    expect(layout.phone?.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  });
}
