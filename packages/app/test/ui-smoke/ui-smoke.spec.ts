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
  // The chat tab now routes through the single global chat overlay
  // surface. The ready signal is the compact conversation affordance plus the
  // interactive composer.
  await assertReadyChecks(
    page,
    "chat shell",
    [
      {
        selector:
          'button[aria-label="expand conversation"], button[aria-label="collapse conversation"]',
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
    page.getByRole("button", {
      name: /Companion\s+@elizaos\/plugin-companion/,
    }),
  ).toBeVisible();

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
