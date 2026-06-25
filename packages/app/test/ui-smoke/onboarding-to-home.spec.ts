import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
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

// CRITICAL FLOW — completing onboarding lands on the HOME screen (the floating
// chat overlay over the home widgets), and a swipe-left flips to the
// springboard launcher.
//
// This boots a fresh device (no first-run-complete), drives the REAL onboarding
// UI to completion via the simplest non-cloud path — Local runtime →
// on-device ("all-local") inference — which calls
// completeFirstRun("chat", { launchCompanionOverlay: true }). That sets the tab
// to "chat" → ChatRouteShellContent → HomeScreenMount(initialPage="home") →
// HomeSpringboardSurface(home=HomeScreen[<WidgetHost slot="home">],
// springboard=SpringboardSurface). So the post-onboarding landing is the home:
// the ContinuousChatOverlay composer is present AND the home widget host renders
// its seeded per-plugin cards. A real left-flick on the home page then pans the
// rail to the springboard (data-page="springboard") and reveals a launcher tile.
//
// The fixtures, route mocks, and flow helpers are shared with the mobile-
// viewport lane (onboarding-to-home-mobile.spec.ts) via onboarding-to-home.shared.

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-to-home",
);
const screenshot = makeScreenshotter(SCREENSHOT_DIR);

test.describe("onboarding → home → springboard", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("completing onboarding lands on the home and swipe-left opens the springboard", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    // No Electrobun RPC bridge is injected (matching first-run-startup.spec): the
    // local first-run path's bridge calls (getDesktopRuntimeMode → null,
    // agentStart → null) are non-throwing no-ops, and waitForAgentApi falls back
    // to the HTTP GET /api/auth/status mocked below, which resolves on the first
    // poll. Injecting a partial bridge could change which startup gate fires.
    await injectFullCapabilityHost(page);
    await installHomeRoutes(page);
    // Fresh device: no persisted first-run completion (mobile-runtime-mode left
    // unset so the local desktop path is taken).
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeOnboardingToHome(
      page,
      (locator: Locator) => locator.click(),
    );

    // Capture the populated home.
    await settleHomeEntrance(page);
    await screenshot(page, "home");

    await swipeLeftToSpringboard(page, surface);
    await screenshot(page, "springboard");
  });
});
