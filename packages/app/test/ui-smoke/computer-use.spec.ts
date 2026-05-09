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
    page.getByText(/Computer Use requires Accessibility and Screen Recording/),
  ).toBeVisible();
  await expect(page.locator("#permissions")).toBeVisible();
  await expect(
    page.locator("#permissions").getByText("Permissions", { exact: true }),
  ).toBeVisible();
});

test("onboarding starts with setup choices before capability settings", async ({
  page,
}) => {
  await seedAppStorage(page, {
    "eliza:onboarding-complete": "0",
    "elizaos:onboarding:force-fresh": "1",
    "eliza:onboarding:step": "features",
    "elizaos:active-server": "",
  });

  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByRole("heading", { name: "Welcome to Milady" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "I want to run it myself" }),
  ).toBeVisible();
});
