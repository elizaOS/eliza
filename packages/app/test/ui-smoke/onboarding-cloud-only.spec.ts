/**
 * Cloud-only onboarding UI-smoke (#13377) — the PRODUCTION DEFAULT flow.
 *
 * Unlike the onboarding-to-home lanes (which opt in to the dev-only runtime
 * chooser via injectFullCapabilityHost), these specs boot the app exactly as a
 * shipped build does: no chooser override, so onboarding is the single
 * "Sign in to Eliza Cloud" step. Covered: the sign-in-only greeting (no
 * local/remote options), the tap-driven flow to a real completion at
 * provisioning success (no tutorial gate), session injection (a stored steward
 * session skips the sign-in ask — zero interactions to the onboarded home),
 * and existing-agents auto-adoption (the picker never appears in cloud-only).
 * Cloud login + provisioning are mocked at the network boundary, same as the
 * chooser-mode cloud lane.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  completeCloudOnlyOnboardingToHome,
  completeCloudOnlySessionInjectionToHome,
  expectCloudOnlySignInOnboarding,
  injectCloudAuthToken,
  installCloudRoutes,
  installHomeRoutes,
  makeScreenshotter,
  settleHomeEntrance,
} from "./onboarding-to-home.shared";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-cloud-only",
);
const screenshot = makeScreenshotter(SCREENSHOT_DIR);

/**
 * #14362: cloud-only onboarding lands the user straight in chat/home. The
 * one-time post-onboarding character-select landing was removed, so the
 * character-customization surface must never mount automatically — it is
 * reached explicitly from Settings/launcher. Assert both the surface (the
 * `character-editor-view` marker) and the route.
 */
async function expectNoCharacterSelectLanding(page: Page): Promise<void> {
  await expect(page.getByTestId("character-editor-view")).toHaveCount(0);
  expect(page.url()).not.toContain("character/select");
}

test.describe("cloud-only onboarding (production default)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("fresh boot offers exactly one path — Sign in to Eliza Cloud — and the tap completes onboarding at provisioning success", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    const state = await installHomeRoutes(page);
    // Zero existing cloud agents: the bind is a silent auto-provision, so the
    // whole flow is greeting → one tap → onboarded home.
    await installCloudRoutes(page, { agentCount: 0 });
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expectCloudOnlySignInOnboarding(page);
    await screenshot(page, "cloud-only-sign-in-greeting");

    const { surface } = await completeCloudOnlyOnboardingToHome(page, {
      state,
    });
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-only-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    await expectNoCharacterSelectLanding(page);
  });

  test("session injection: a stored Eliza Cloud session skips the sign-in ask — zero interactions to the onboarded home", async ({
    page,
  }) => {
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page, { agentCount: 0 });
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudOnlySessionInjectionToHome(page, {
      state,
    });
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-only-session-injection-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    await expectNoCharacterSelectLanding(page);
  });

  test("existing cloud agents are auto-adopted — no picker, zero interactions", async ({
    page,
  }) => {
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudOnlySessionInjectionToHome(page, {
      state,
    });
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-only-auto-adopt-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    await expectNoCharacterSelectLanding(page);
  });
});
