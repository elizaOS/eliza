/** Exercises 200% zoom on the real hosted shell with a locked-meta control. */
import { expect, type Page, test } from "@playwright/test";

async function pageScale(page: Page) {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    width: window.visualViewport?.width ?? window.innerWidth,
  }));
}

/**
 * The served shell can issue a client-side redirect (first-run routing) right
 * after domcontentloaded, destroying the execution context mid-evaluate. The
 * replacement document can briefly expose an empty head before its parser
 * installs the viewport tag. The assertions are about the settled served
 * document, which is identical across those routes, so retry both transitions.
 */
async function evaluateAcrossNavigation<T>(
  page: Page,
  fn: () => T,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await page.evaluate(fn);
    } catch (error) {
      // error-policy:J3 — only the known navigation race is retried; anything
      // else rethrows immediately.
      if (!/Execution context was destroyed/.test(String(error))) throw error;
      lastError = error;
      await page.waitForLoadState("domcontentloaded");
    }
  }
  throw lastError;
}

async function readViewportMetaAcrossNavigation(page: Page): Promise<string> {
  let content = "";
  await expect
    .poll(
      async () => {
        content = await evaluateAcrossNavigation(page, () => {
          const meta = document.querySelector('meta[name="viewport"]');
          return meta?.getAttribute("content") ?? "";
        });
        return content;
      },
      {
        message: "the final served document should expose viewport metadata",
      },
    )
    .not.toBe("");
  return content;
}

test.describe("WCAG 2.2 SC 1.4.4 browser zoom", () => {
  test("the served web shell allows 2× zoom", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const viewportMeta = await readViewportMetaAcrossNavigation(page);

    expect(viewportMeta).toContain("width=device-width");
    expect(viewportMeta).toContain("initial-scale=1.0");
    expect(viewportMeta).toContain("viewport-fit=cover");
    expect(viewportMeta).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(viewportMeta).not.toMatch(/maximum-scale/i);

    const baseline = await evaluateAcrossNavigation(page, () => ({
      scale: window.visualViewport?.scale ?? 1,
      width: window.visualViewport?.width ?? window.innerWidth,
    }));
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
