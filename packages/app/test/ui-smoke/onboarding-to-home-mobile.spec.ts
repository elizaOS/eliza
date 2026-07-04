/**
 * Playwright UI-smoke spec for the Onboarding To Home Mobile app flow using
 * the real renderer fixture.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { devices, expect, type Locator, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  completeCloudInferenceOnboardingToHome,
  completeCloudOnboardingToHome,
  completeOnboardingToHome,
  completeOtherProviderSettingsHandoff,
  injectCloudAuthToken,
  injectFullCapabilityHost,
  installCloudRoutes,
  installHomeRoutes,
  makeScreenshotter,
  settleHomeEntrance,
  swipeLeftToLauncher,
} from "./onboarding-to-home.shared";

// Mobile-viewport counterpart of onboarding-to-home.spec.ts. Same keyless flow —
// fresh device → real Local/on-device onboarding → completeFirstRun("chat") →
// home with seeded widgets → swipe-left → launcher — but driven through a
// Pixel-class Chromium context with `hasTouch: true, isMobile: true` and a touch
// viewport, so the onboarding cards are TAPPED and the launcher reveal is a
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

test.describe("onboarding → home → launcher (mobile viewport)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("first-run → home → swipe-left → launcher with touch", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
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

    // Tap (not click) the inline choice buttons — the touch path through the
    // WebView, inside the same floating ContinuousChatOverlay. The shared flow
    // also asserts the onboarding lock (disabled composer, Escape gated) and
    // the auto-collapse on completion.
    const { surface } = await completeOnboardingToHome(
      page,
      (locator: Locator) => locator.tap(),
      { state, tutorial: "skip" },
    );

    // Restated at the spec level: completion auto-collapsed the sheet, so the
    // touch flick below lands on the home rail with no manual collapse step,
    // and the composer unlocked for normal chat.
    await expect(
      page.getByTestId("continuous-chat-overlay"),
    ).not.toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled();

    // Capture the populated mobile home landing.
    await settleHomeEntrance(page);
    await screenshot(page, "home");

    // A real left-flick over the home page pans the rail to the launcher.
    await swipeLeftToLauncher(page, surface, { input: "touch" });
    await screenshot(page, "launcher");
  });

  test("cloud first-run completes in chat with touch", async ({ page }) => {
    await injectFullCapabilityHost(page);
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudOnboardingToHome(
      page,
      (locator: Locator) => locator.tap(),
      { state, tutorial: "skip" },
    );

    await settleHomeEntrance(page);
    await screenshot(page, "cloud-home");
    await expect(surface).toHaveAttribute("data-page", "home");
  });

  test("cloud-inference provider first-run completes in chat with touch", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudInferenceOnboardingToHome(
      page,
      (locator: Locator) => locator.tap(),
      { state, tutorial: "skip" },
    );

    await settleHomeEntrance(page);
    await screenshot(page, "cloud-inference-home");
    await expect(surface).toHaveAttribute("data-page", "home");
  });

  test("other provider handoff stays in chat with touch", async ({ page }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeOtherProviderSettingsHandoff(
      page,
      (locator: Locator) => locator.tap(),
      { state, tutorial: "skip" },
    );

    await settleHomeEntrance(page);
    await screenshot(page, "other-settings-handoff");
    await expect(surface).toHaveAttribute("data-page", "home");
  });
});
