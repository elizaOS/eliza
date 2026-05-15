import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
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
  await assertReadyChecks(
    page,
    "chat shell",
    [
      { selector: '[data-testid="conversations-sidebar"]' },
      { selector: '[data-testid="chat-composer-textarea"]' },
      { selector: '[data-testid="chat-widgets-bar"]' },
    ],
    "all",
  );

  await openAppPath(page, "/apps");
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByText("No views available")).toBeVisible();

  await openAppPath(page, "/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  const capabilitiesSection = page.locator("#capabilities");
  await capabilitiesSection.scrollIntoViewIfNeeded();
  await expect(capabilitiesSection).toBeVisible();
  await expect(
    capabilitiesSection.getByText("Capabilities", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#permissions")).toBeVisible();
  await expect(
    page.locator("#permissions").getByText("Permissions", { exact: true }),
  ).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("switch", { name: "Enable Computer Use" }),
  ).toBeVisible();
});
