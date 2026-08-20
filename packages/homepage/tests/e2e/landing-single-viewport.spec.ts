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
          32,
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

test("all five longer rooms play once without hiding usable thread space", async ({
  page,
}) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 390, height: 1275 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const phone = page.locator(".landing-iphone");
  await expect(phone).toHaveAttribute("data-demo-phase", "settled", {
    timeout: 60_000,
  });
  await expect(phone).toHaveAttribute("data-demo-scenario", "community");
  await expect(phone).toHaveAttribute("data-demo-scenario-index", "5");
  await expect(phone).toHaveAttribute("data-demo-scenarios", "5");
  await expect(phone).toHaveAttribute(
    "data-demo-visited",
    "friends,co-parenting,household,trip,community",
  );
  await expect(phone).toHaveAttribute("data-demo-messages", "12");

  await expect
    .poll(
      () =>
        page.locator(".landing-phone-thread").evaluate((thread) => {
          const messages =
            thread.querySelectorAll<HTMLElement>("[data-demo-item]");
          const firstMessage = messages.item(0);
          const lastMessage = messages.item(messages.length - 1);
          if (!firstMessage || !lastMessage) return false;
          const threadRect = thread.getBoundingClientRect();
          const firstRect = firstMessage.getBoundingClientRect();
          const messageRect = lastMessage.getBoundingClientRect();
          if (thread.scrollHeight <= thread.clientHeight + 1) {
            return (
              firstRect.top - threadRect.top <= 70 &&
              messageRect.bottom <= threadRect.bottom
            );
          }
          return threadRect.bottom - messageRect.bottom <= 18;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
});
