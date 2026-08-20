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
  { width: 390, height: 1275 },
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

    const layout = await page.evaluate(() => {
      const phone = document.querySelector<HTMLElement>(".landing-iphone");
      const phoneHeader = document.querySelector<HTMLElement>(
        ".landing-phone-header",
      );
      const firstThreadItem = document.querySelector<HTMLElement>(
        ".landing-thread-preamble",
      );
      if (!phone) throw new Error("Landing phone missing");
      const phoneStyle = getComputedStyle(phone);
      const thread = document.querySelector<HTMLElement>(
        ".landing-phone-thread",
      );
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        phone: phone.getBoundingClientRect().toJSON(),
        phoneFrame: {
          borderRadius: phoneStyle.borderRadius,
          paddingTop: phoneStyle.paddingTop,
        },
        threadMaskImage: thread ? getComputedStyle(thread).maskImage : null,
        mobileThreadGap:
          phoneHeader && firstThreadItem
            ? firstThreadItem.getBoundingClientRect().top -
              phoneHeader.getBoundingClientRect().bottom
            : null,
      };
    });

    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.documentHeight).toBe(layout.viewportHeight);
    expect(layout.phone).toBeDefined();
    expect(layout.phone?.top).toBeGreaterThanOrEqual(0);
    expect(layout.phone?.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    if (viewport.width <= 640) {
      expect(Number.parseFloat(layout.phoneFrame.paddingTop)).toBe(0);
      expect(Number.parseFloat(layout.phoneFrame.borderRadius)).toBe(0);
      expect(layout.mobileThreadGap).not.toBeNull();
      expect(layout.threadMaskImage).toBe("none");
      expect(
        layout.mobileThreadGap ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(64);
      if (viewport.height >= 1000) {
        expect(layout.mobileThreadGap ?? Number.POSITIVE_INFINITY).toBeLessThan(
          16,
        );
      }
    } else {
      expect(Number.parseFloat(layout.phoneFrame.paddingTop)).toBeGreaterThan(
        0,
      );
      expect(Number.parseFloat(layout.phoneFrame.borderRadius)).toBeGreaterThan(
        0,
      );
    }
  });
}

test("the loop keeps a tall mobile thread filled after pruning", async ({
  page,
}) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 390, height: 1275 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const phone = page.locator(".landing-iphone");
  await expect(phone).toHaveAttribute("data-demo-phase", "looping", {
    timeout: 60_000,
  });
  await expect
    .poll(
      async () =>
        Number.parseInt(
          (await phone.getAttribute("data-demo-messages")) ?? "0",
          10,
        ),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(20);

  await expect
    .poll(
      () =>
        page.locator(".landing-phone-thread").evaluate((thread) => {
          const messages =
            thread.querySelectorAll<HTMLElement>("[data-demo-item]");
          const lastMessage = messages.item(messages.length - 1);
          if (!lastMessage) return false;
          const threadRect = thread.getBoundingClientRect();
          const messageRect = lastMessage.getBoundingClientRect();
          return (
            thread.scrollHeight > thread.clientHeight &&
            threadRect.bottom - messageRect.bottom <= 18
          );
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
});
