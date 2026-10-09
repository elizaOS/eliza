/** Exercises actual registry refresh failure/recovery at small and large browser text sizes. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

for (const width of [390, 1280]) {
  for (const fontSize of [12, 32]) {
    test(`unavailable app recovery at ${width}px with ${fontSize}px root text`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, "/camera");
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      const recovery = page.locator(
        '[data-view-status="unavailable"][data-view-id="camera"]',
      );
      await expect(recovery).toBeVisible();
      let release: (() => void) | undefined;
      let attempts = 0;
      await page.route("**/api/views", async (route) => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          await route.fulfill({
            status: 503,
            json: { error: "Synthetic registry outage" },
          });
        } else {
          await route.fallback();
        }
      });
      try {
        await recovery
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await expect(
          recovery.getByRole("button", { name: "Checking…", exact: true }),
        ).toBeDisabled();
        await expect.poll(() => attempts).toBe(1);
        release?.();
        await expect(recovery).toContainText(
          "Couldn’t check app availability. Try again.",
        );
        await recovery
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await expect.poll(() => attempts).toBe(2);
        await expect(recovery).toContainText(
          "This app is still unavailable. Install or enable it, then retry.",
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        // A clipped card can leave document scrollWidth unchanged. Check each
        // escape control against the card itself as well as the viewport.
        const card = recovery.getByRole("status");
        const cardBox = await card.boundingBox();
        if (!cardBox) throw new Error("Recovery card has no visible bounds");
        for (const button of await card.getByRole("button").all()) {
          const box = await button.boundingBox();
          if (!box) throw new Error("Recovery control has no visible bounds");
          expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(
            Math.min(width, cardBox.x + cardBox.width),
          );
          expect(
            await button.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          await expect
            .poll(() =>
              button.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return [bounds.top + 2, bounds.bottom - 2].every((y) =>
                  element.contains(
                    document.elementFromPoint(
                      bounds.left + bounds.width / 2,
                      y,
                    ),
                  ),
                );
              }),
            )
            .toBe(true);
        }
        await page.screenshot({
          path: testInfo.outputPath("unavailable-recovery.png"),
          fullPage: true,
        });
        await card
          .getByRole("button", { name: "Back to views", exact: true })
          .click();
        await expect(page).toHaveURL(/\/views$/);
      } finally {
        release?.();
      }
    });
  }
}
