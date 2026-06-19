import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("chat, apps, and settings routes render through the real shell", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  // The chat tab now routes through the single global chat overlay
  // surface. The ready signal is the overlay plus the interactive composer.
  await assertReadyChecks(
    page,
    "chat shell",
    [
      {
        selector: '[data-testid="continuous-chat-overlay"]',
      },
      {
        selector:
          '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      },
    ],
    "all",
  );

  await openAppPath(page, "/apps");
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search views…" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Companion" })
      .or(page.getByText("No views available")),
  ).toBeVisible();

  await openAppPath(page, "/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await openSettingsSection(page, /^Capabilities\b/);
  const capabilitiesSection = page.locator("#capabilities");
  await capabilitiesSection.scrollIntoViewIfNeeded();
  await expect(capabilitiesSection).toBeVisible();
  await expect(
    capabilitiesSection.getByText("Capabilities", { exact: true }),
  ).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("switch", { name: "Enable Computer Use" }),
  ).toBeVisible();
  await openSettingsSection(page, /^App Permissions\b/);
  await expect(page.locator("#app-permissions")).toBeVisible();
  await expect(
    page
      .locator("#app-permissions")
      .getByText("App Permissions", { exact: true }),
  ).toBeVisible();
});
