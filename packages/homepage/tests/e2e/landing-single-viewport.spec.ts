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

test("prefills the human setup, then lets Eliza respond", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const phone = page.locator(".landing-iphone");
  await expect(phone).toHaveAttribute("data-demo-messages", "4");
  await expect(
    page.getByText("we're low on coffee", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("and oat milk", { exact: true })).toBeVisible();
  await expect(
    page.getByText("I took recycling out", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("laundry got left in the washer again lol", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".landing-bubble--eliza")).toHaveCount(0);
  await expect(page.locator(".landing-demo-card")).toHaveCount(0);
  await expect(phone).toHaveAttribute("data-demo-typing", "Eliza", {
    timeout: 3_500,
  });
  await expect(
    page.getByText(
      "I checked the house rotation. You have coffee and laundry, Noor has the dishwasher, Eli's recycling counts, and Jules has the plants. That's even.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".landing-demo-card")).toHaveCount(0);
});

test("plays the original welcome aura each time the contact menu opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    let contextCount = 0;
    class FakeAudioParam {
      setValueAtTime(_value: number, _time: number) {}
      exponentialRampToValueAtTime(_value: number, _time: number) {}
    }
    class FakeAudioNode {
      connect(destination: unknown) {
        return destination;
      }
    }
    class FakeGainNode extends FakeAudioNode {
      gain = new FakeAudioParam();
    }
    class FakeOscillatorNode extends FakeAudioNode {
      frequency = new FakeAudioParam();
      type: OscillatorType = "sine";
      start(_time: number) {}
      stop(_time: number) {}
    }
    class FakeAudioContext {
      currentTime = 0;
      destination = new FakeAudioNode();
      constructor() {
        contextCount += 1;
      }
      createGain() {
        return new FakeGainNode();
      }
      createOscillator() {
        return new FakeOscillatorNode();
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
    Object.defineProperty(window, "__landingAuraContextCount", {
      configurable: true,
      get: () => contextCount,
    });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const tapTarget = page.locator(".landing-tap-target");
  await tapTarget.click();
  await expect(page.locator(".landing-sheet")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __landingAuraContextCount: number;
          }
        ).__landingAuraContextCount,
    ),
  ).toBe(1);

  await page.locator(".landing-sheet-close").click();
  await tapTarget.click();
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __landingAuraContextCount: number;
          }
        ).__landingAuraContextCount,
    ),
  ).toBe(2);
});

test("human replies show the participant's iOS typing indicator", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const phone = page.locator(".landing-iphone");
  await expect(phone).toHaveAttribute("data-demo-typing", "Jules", {
    timeout: 14_000,
  });

  const indicator = page.locator('[data-demo-typing-indicator="Jules"]');
  await expect(indicator).toBeVisible();
  await expect(indicator.locator(".landing-message-author")).toHaveText(
    "Jules",
  );
  await expect(indicator.locator(".landing-message-avatar")).toHaveAttribute(
    "src",
    "/brand/people/demo-jules.webp",
  );
  await expect(indicator.locator(".landing-typing span")).toHaveCount(3);
  await expect(indicator.locator(".landing-typing")).toHaveAttribute(
    "aria-label",
    "Jules is typing",
  );

  await expect(phone).toHaveAttribute("data-demo-typing", "", {
    timeout: 4_000,
  });
  await expect(page.getByText("I'm home late", { exact: true })).toBeVisible();
});

test("concurrent human replies share one compact typing row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const phone = page.locator(".landing-iphone");
  await expect(phone).toHaveAttribute("data-demo-typing", "Eli,Jules", {
    timeout: 12_000,
  });

  const indicator = page.locator(
    '[data-demo-typing-indicator="Eli and Jules"]',
  );
  await expect(indicator).toBeVisible();
  await expect(indicator.locator(".landing-message-author")).toHaveText(
    "Eli and Jules",
  );
  await expect(indicator.locator(".landing-message-avatar")).toHaveCount(2);
  await expect(indicator.locator(".landing-typing")).toHaveAttribute(
    "aria-label",
    "Eli and Jules are typing",
  );
  const multipleAuthorBox = await indicator
    .locator(".landing-message-author")
    .boundingBox();
  const multipleBubbleBox = await indicator
    .locator(".landing-typing")
    .boundingBox();
  const multipleAvatarSlotBox = await indicator
    .locator(".landing-message-avatar-slot")
    .boundingBox();
  const multipleBodyBox = await indicator
    .locator(".landing-message-body")
    .boundingBox();
  const latestMessageBox = await page
    .locator('[data-demo-item="true"]')
    .last()
    .boundingBox();
  const multipleIndicatorBox = await indicator.boundingBox();

  expect(
    (multipleAvatarSlotBox?.x ?? 0) + (multipleAvatarSlotBox?.width ?? 0),
  ).toBeLessThanOrEqual((multipleBodyBox?.x ?? 0) + 1);
  expect(multipleIndicatorBox?.y ?? 0).toBeGreaterThanOrEqual(
    (latestMessageBox?.y ?? 0) + (latestMessageBox?.height ?? 0),
  );

  await expect(phone).toHaveAttribute("data-demo-typing", "Jules", {
    timeout: 3_000,
  });
  const singleIndicator = page.locator('[data-demo-typing-indicator="Jules"]');
  const singleAuthorBox = await singleIndicator
    .locator(".landing-message-author")
    .boundingBox();
  const singleBubbleBox = await singleIndicator
    .locator(".landing-typing")
    .boundingBox();
  expect(
    Math.abs((multipleAuthorBox?.x ?? 0) - (singleAuthorBox?.x ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((multipleBubbleBox?.x ?? 0) - (singleBubbleBox?.x ?? 0)),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByText("I'm home late", { exact: true })).toBeVisible();
  await expect(page.getByText("plants are done", { exact: true })).toBeVisible({
    timeout: 3_000,
  });
});

test("all five longer rooms keep rotating without hiding usable thread space", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width: 390, height: 1275 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const phone = page.locator(".landing-iphone");
  await expect(phone).toHaveAttribute("data-demo-cycle", "1", {
    timeout: 340_000,
  });
  await expect(phone).toHaveAttribute("data-demo-scenario", "household", {
    timeout: 5_000,
  });
  await expect(phone).toHaveAttribute("data-demo-phase", "playing");
  await expect(phone).toHaveAttribute("data-demo-scenario-index", "1");
  await expect(phone).toHaveAttribute("data-demo-scenarios", "5");
  await expect(phone).toHaveAttribute(
    "data-demo-visited",
    "household,co-parenting,friends,trip,community",
  );
  await expect
    .poll(async () => Number(await phone.getAttribute("data-demo-messages")))
    .toBeGreaterThanOrEqual(4);

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
