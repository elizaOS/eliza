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
  await seedAppStorage(page, {
    "eliza:first-run-complete": "0",
    "elizaos:first-run:force-fresh": "1",
    "elizaos:active-server": "",
  });
  await installDefaultAppRoutes(page);

  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const firstRunSurface = page
    .getByTestId("first-run-chat")
    .or(page.getByRole("form", { name: "Bootstrap token entry" }));
  await expect(firstRunSurface).toBeVisible();
  const bootstrapGate = page.getByRole("form", {
    name: "Bootstrap token entry",
  });
  if (await bootstrapGate.isVisible()) {
    await expect(
      page.getByRole("switch", { name: "Enable Computer Use" }),
    ).toHaveCount(0);
    return;
  }
  // The in-chat first-run flow greets first and offers the runtime choices as
  // in-chat ChoiceWidget options. The Computer Use switch must NOT be reachable
  // before the agent exists.
  await expect(page.getByTestId("first-run-greeting")).toBeVisible();
  await expect(page.getByTestId("choice-cloud")).toBeVisible();
  const localRuntime = page.getByTestId("choice-local");
  if (await localRuntime.count()) {
    await expect(localRuntime).toBeVisible();
  }
  const remoteRuntime = page.getByTestId("choice-remote");
  if (await remoteRuntime.count()) {
    await expect(remoteRuntime).toBeVisible();
  }
  await expect(
    page.getByRole("switch", { name: "Enable Computer Use" }),
  ).toHaveCount(0);
});
