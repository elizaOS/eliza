/** Exercises 200% zoom on the real hosted shell with a locked-meta control. */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function pageScale(page: Page) {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    width: window.visualViewport?.width ?? window.innerWidth,
  }));
}

/**
 * The served shell can issue a client-side redirect (first-run routing) right
 * after domcontentloaded, destroying the execution context mid-evaluate. The
 * assertions here are about the served document's viewport meta, which is
 * identical across those routes, so retry the read across the navigation.
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

test.describe("WCAG 2.2 SC 1.4.4 browser zoom", () => {
  test("coarse-pointer chat text controls compute to Safari's 16px focus threshold", async ({
    page,
  }) => {
    await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/chat");

    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);

    const composer = page.getByTestId("chat-composer-textarea");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    expect(
      await composer.evaluate((node) => getComputedStyle(node).fontSize),
    ).toBe("16px");

    // Exercise Tailwind's emitted cascade with the smallest in-transcript base
    // density. Component tests pin this same override onto custom choice,
    // form/select, search, sensitive-request, and inline-edit controls.
    const probeFontSize = await page.evaluate(() => {
      const probe = document.createElement("input");
      probe.className = "text-xs pointer-coarse:text-base";
      document.body.append(probe);
      const fontSize = getComputedStyle(probe).fontSize;
      probe.remove();
      return fontSize;
    });
    expect(probeFontSize).toBe("16px");
  });

  test("the served web shell allows 2× zoom", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const viewportMeta = await evaluateAcrossNavigation(page, () => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta?.getAttribute("content") ?? "";
    });

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
