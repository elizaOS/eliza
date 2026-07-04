/**
 * Playwright UI-smoke spec for the Computer Use app flow using the real
 * renderer fixture.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test("settings exposes computer use capability controls", async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/settings/voice");

  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await openSettingsSection(page, /^Capabilities\b/);

  await expect(page.locator("#capabilities")).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable Computer Use" }),
  ).toBeVisible();

  await page.getByRole("switch", { name: "Enable Computer Use" }).click();

  await expect(
    page.getByText(
      /Computer Use requires Accessibility and Screen Recording permissions\./,
    ),
  ).toBeVisible();
  await openSettingsSection(page, /^App Permissions\b/);
  await expect(page.locator("#app-permissions")).toBeVisible();
  await expect(
    page
      .locator("#app-permissions")
      .getByText("App Permissions", { exact: true }),
  ).toBeVisible();
});

test("first-run starts with setup choices before capability settings", async ({
  page,
}) => {
  // This test asserts the full runtime chooser (incl. the Local option), which
  // is OFF by default (#13377 cloud-only onboarding) — opt in via the override.
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
    "eliza:enable-runtime-chooser": "1",
  });
  await installDefaultAppRoutes(page);
  // #9952: onboarding is in-chat. Boot with first-run NOT complete so the
  // headless conductor seeds the greeting + runtime choice into the live
  // floating ContinuousChatOverlay (installDefaultAppRoutes serves a static
  // complete first-run; this override wins).
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ complete: false, cloudProvisioned: false }),
    });
  });

  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
  await expect(
    page.getByText("First, where should your agent run?", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("choice-__first_run__:runtime:cloud"),
  ).toBeVisible();
  await expect(
    page.getByTestId("choice-__first_run__:runtime:local"),
  ).toBeVisible();

  // The Computer Use capability switch must NOT be reachable before the agent
  // exists — the in-chat onboarding gates it.
  await expect(
    page.getByRole("switch", { name: "Enable Computer Use" }),
  ).toHaveCount(0);
});
