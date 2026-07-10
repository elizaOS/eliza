/**
 * Playwright UI-smoke spec for the Onboarding To Home app flow using the real
 * renderer fixture.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "../e2e-artifacts/fixtures";
import {
  expectOnlyAllowedPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  completeCloudInferenceOnboardingToHome,
  completeCloudOnboardingToHome,
  completeOnboardingToHome,
  completeOtherProviderSettingsHandoff,
  connectRemoteFirstRunToHome,
  expectChatFirstOnboarding,
  injectCloudAuthToken,
  injectFullCapabilityHost,
  installCloudRoutes,
  installHomeRoutes,
  makeScreenshotter,
  type OnboardingRouteState,
  settleHomeEntrance,
  swipeLeftToLauncher,
} from "./onboarding-to-home.shared";

// CRITICAL FLOW (#9952) — onboarding is now PART OF THE CHAT. A fresh profile
// (firstRunComplete=false) paints the homescreen + the real chat overlay. The
// headless conductor seeds runtime/provider choices, Cloud OAuth, cloud-agent
// picks, and the tutorial CHOICE into the transcript. There is NO separate
// full-screen onboarding surface anymore.
//
// These specs boot a fresh device (no first-run-complete) and drive the in-chat
// flow in the REAL shell to completion, then assert the post-onboarding landing
// is the HOME (the ContinuousChatOverlay composer over the home widgets) and that
// POST /api/first-run fired exactly once. Covered paths: chat-first + gate-absent
// assertion, Local/on-device, Cloud (OAuth card mocked at the network boundary +
// cloud-agent pick), tutorial-or-skip (both branches), and POST-once.
//
// The fixtures, route mocks, and flow helpers are shared with the mobile-viewport
// lane (onboarding-to-home-mobile.spec.ts) via onboarding-to-home.shared.

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-to-home",
);
const screenshot = makeScreenshotter(SCREENSHOT_DIR);

const desktopClick = (locator: Locator) => locator.click();

test.describe("in-chat onboarding → home → launcher", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    // The chat-native tour narrates through the real voice engine the moment
    // "Take the tutorial" completes onboarding; the keyless harness's stubbed
    // TTS audio can't be decoded, and useVoiceChat's designed fail-closed path
    // logs exactly that one error. Everything else must stay clean.
    await expectOnlyAllowedPageDiagnostics(page, testInfo.title, [
      /\[useVoiceChat\] .* TTS failed; failing closed/,
    ]);
  });

  test("Local onboarding lands on the home and swipe-left opens the launcher", async ({
    page,
    statecap,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    // No Electrobun RPC bridge is injected: the local first-run path's bridge
    // calls (getDesktopRuntimeMode → null, agentStart → null) are non-throwing
    // no-ops, and waitForAgentApi falls back to the HTTP GET /api/auth/status
    // mocked below, which resolves on the first poll.
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    // Fresh device: no persisted first-run completion (mobile-runtime-mode left
    // unset so the local desktop path is taken).
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Capture the chat-first onboarding landing before driving it. The helper
    // also asserts the onboarding lock: composer disabled ("Sign in to start
    // chatting") and Escape NOT collapsing the pinned-open sheet.
    await expectChatFirstOnboarding(page);
    // NEGATIVE, restated at the spec level: mid-onboarding the sheet cannot be
    // dismissed — the old Escape-collapse-to-reach-the-launcher step is gone.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
      "data-open",
      "true",
    );
    await screenshot(page, "onboarding-chat-first");
    await statecap("onboarding-chat-first");

    const { surface } = await completeOnboardingToHome(page, desktopClick, {
      state,
      tutorial: "skip",
    });

    // Completion settled the sheet from the pinned FULL detent down to the HALF
    // detent (#15339 / ContinuousChatOverlay.firstrun.test): the sheet stays
    // OPEN with the home revealed behind its top half, and the composer unlocks.
    // swipeLeftToLauncher collapses the open sheet before the flick.
    await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
      "data-detent",
      "half",
    );
    await expect(page.getByTestId("continuous-chat-overlay")).toHaveAttribute(
      "data-open",
      "true",
    );
    await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled();

    // Post-login permission priming (#12331) can open over the home on the
    // completion edge; completeOnboardingToHome already drove its "Skip for now"
    // dismissal (dismissPermissionPrimingIfShown), and swipeLeftToLauncher clears
    // any residual before the flick — so no separate dismissal step is needed
    // here (a second one races the helper's and flakes).

    // Capture the populated home.
    await settleHomeEntrance(page);
    await screenshot(page, "home");
    await statecap("home-after-onboarding");

    await swipeLeftToLauncher(page, surface, { input: "mouse" });
    await screenshot(page, "launcher");
    await statecap("launcher-after-swipe");
  });

  test("Cloud onboarding connects, binds an agent, and lands on the home", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudOnboardingToHome(
      page,
      desktopClick,
      {
        state,
        tutorial: "skip",
      },
    );
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
  });

  test("Local cloud-inference onboarding completes in chat", async ({
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
      desktopClick,
      {
        state,
        tutorial: "skip",
      },
    );
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-inference-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    expect(JSON.stringify(state.firstRunPosts[0])).toContain("elizacloud");
  });

  test("Other provider completes in chat and hands off to Settings without model download", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    let localDownloadStarted = false;
    await page.route("**/api/local-inference/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() === "POST" &&
        (url.pathname.endsWith("/downloads") ||
          url.pathname.endsWith("/active"))
      ) {
        localDownloadStarted = true;
      }
      await route.fallback();
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeOtherProviderSettingsHandoff(
      page,
      desktopClick,
      {
        state,
        tutorial: "skip",
      },
    );
    await settleHomeEntrance(page);
    await screenshot(page, "other-settings-handoff");
    expect(await surface.getAttribute("data-page")).toBe("home");
    expect(localDownloadStarted).toBe(false);
  });

  test("Remote connect adopts a host and replaces onboarding without the old screen", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const apiBase = await page.evaluate(() => window.location.origin);
    const { surface, activeServer } = await connectRemoteFirstRunToHome(page, {
      state,
      apiBase,
    });

    await settleHomeEntrance(page);
    await screenshot(page, "remote-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    expect(activeServer).toContain(apiBase);
  });

  test("tutorial CHOICE 'Take the tutorial' completes onboarding and launches the tour", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state: OnboardingRouteState = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Same Local path, but pick "Take the tutorial" at the final CHOICE — it
    // still flips firstRunComplete and lands on the home, AND starts the
    // chat-native tour: the welcome turn (with its Next choice) lands in the
    // same live transcript onboarding just used. No overlay engine remains.
    await completeOnboardingToHome(page, desktopClick, {
      state,
      tutorial: "start",
    });

    await expect(
      page.getByTestId("choice-__tutorial__:next:welcome"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("tutorial-spotlight")).toHaveCount(0);
    await settleHomeEntrance(page);
    await screenshot(page, "tutorial-start");
  });
});
