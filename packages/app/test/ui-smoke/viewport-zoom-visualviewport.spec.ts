/** Exercises 200% zoom on the real hosted shell with a locked-meta control. */
import { expect, type Page, test } from "@playwright/test";

async function pageScale(page: Page) {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    width: window.visualViewport?.width ?? window.innerWidth,
  }));
}

test.describe("WCAG 2.2 SC 1.4.4 browser zoom", () => {
  test("the served web shell allows 2× zoom", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const viewportMeta = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta?.getAttribute("content") ?? "";
    });

    expect(viewportMeta).toContain("width=device-width");
    expect(viewportMeta).toContain("initial-scale=1.0");
    expect(viewportMeta).toContain("viewport-fit=cover");
    expect(viewportMeta).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(viewportMeta).not.toMatch(/maximum-scale/i);

    const baseline = await pageScale(page);
    expect(baseline.scale).toBeCloseTo(1, 1);

    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await expect
      .poll(async () => (await pageScale(page)).scale)
      .toBeGreaterThan(1.5);

    const zoomed = await pageScale(page);
    expect(zoomed.width).toBeLessThan(baseline.width * 0.75);
    await expect(page.locator("body")).toBeVisible();
  });

  test("the previous lockdown blocks the same zoom request", async ({
    page,
  }) => {
    await page.route("**/viewport-lockdown-control", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><main>Locked control</main>',
      }),
    );
    await page.goto("/viewport-lockdown-control", {
      waitUntil: "domcontentloaded",
    });
    expect((await pageScale(page)).scale).toBeCloseTo(1, 1);

    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.waitForTimeout(500);
    expect((await pageScale(page)).scale).toBeCloseTo(1, 1);
  });
});
