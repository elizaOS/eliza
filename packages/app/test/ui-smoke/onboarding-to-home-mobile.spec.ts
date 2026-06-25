import { rm } from "node:fs/promises";
import path from "node:path";
import { devices, expect, type Locator, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  completeOnboardingToHome,
  injectFullCapabilityHost,
  installHomeRoutes,
  makeScreenshotter,
  settleHomeEntrance,
  swipeLeftToSpringboard,
} from "./onboarding-to-home.shared";

// Mobile-viewport counterpart of onboarding-to-home.spec.ts. Same keyless flow —
// fresh device → real Local/on-device onboarding → completeFirstRun("chat") →
// home with seeded widgets → swipe-left → springboard — but driven through a
// Pixel-class Chromium context with `hasTouch: true, isMobile: true` and a touch
// viewport, so the onboarding cards are TAPPED and the springboard reveal is a
// touch flick at the exact WebView viewport size that ships on Capacitor
// iOS/Android. This is the desktop-Chromium-with-mobile-emulation lane; the
// real installed Capacitor WebView lane lives in
// test/android/onboarding-to-home.android.spec.ts (driven by mobile-e2e.yml).
//
// `devices["Pixel 7"]` sets viewport 412×915, deviceScaleFactor 2.625,
// isMobile: true, hasTouch: true and a mobile Chrome userAgent — so the Local
// onboarding card is enabled (canSelectLocalRuntime keys off the injected
// __electrobunWindowId, not the UA) and touch input drives the real pointer
// handlers.
test.use({ ...devices["Pixel 7"] });

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-to-home-mobile",
);
const screenshot = makeScreenshotter(SCREENSHOT_DIR);

test.describe("onboarding → home → springboard (mobile viewport)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("first-run → home → swipe-left → springboard with touch", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    await injectFullCapabilityHost(page);
    await installHomeRoutes(page);
    // Fresh device: no persisted first-run completion.
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Prove this is a real touch context (hasTouch: true), so `locator.tap()`
    // and the touch flick exercise the actual pointer/touch path and the "with
    // touch" claim is not a larp on a silently-desktop context.
    expect(
      await page.evaluate(
        () =>
          navigator.maxTouchPoints > 0 ||
          window.matchMedia("(pointer: coarse)").matches,
      ),
      "Pixel 7 device descriptor must yield a touch-capable context",
    ).toBe(true);

    // Tap (not click) the onboarding cards — the touch path through the WebView.
    const { surface } = await completeOnboardingToHome(
      page,
      (locator: Locator) => locator.tap(),
    );

    // Capture the populated mobile home landing.
    await settleHomeEntrance(page);
    await screenshot(page, "home");

    // A real left-flick over the home page pans the rail to the springboard.
    await swipeLeftToSpringboard(page, surface);
    await screenshot(page, "springboard");
  });
});
