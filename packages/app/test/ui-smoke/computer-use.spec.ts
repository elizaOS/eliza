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

test("first-run starts with setup choices before capability settings", async ({
  page,
}) => {
  await seedAppStorage(page, {
    "eliza:first-run-complete": "0",
    "elizaos:first-run:force-fresh": "1",
    "elizaos:active-server": "",
  });
  await installDefaultAppRoutes(page);

  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const toast = page.getByTestId("onboarding-toast");
  const bootstrap = page.getByRole("form", { name: "Bootstrap token entry" });
  await expect(toast.or(bootstrap)).toBeVisible();
  if (await toast.isVisible()) {
    await expect(
      toast.getByText(/Run on-device, or sign in to Eliza Cloud/),
    ).toBeVisible();
    await expect(
      toast.getByRole("button", { name: "Eliza Cloud" }),
    ).toBeVisible();
    const localRuntime = toast.getByRole("button", { name: "Use Local" });
    if (await localRuntime.count()) {
      await expect(localRuntime).toBeVisible();
    }
  } else {
    await expect(
      page.getByRole("heading", { name: "Finish setting up your container" }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("switch", { name: "Enable Computer Use" }),
  ).toHaveCount(0);
});
