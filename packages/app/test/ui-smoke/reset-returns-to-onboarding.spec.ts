import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

const FIRST_RUN_OPTIONS = {
  names: [],
  styles: [],
  providers: [],
  cloudProviders: [],
  models: {},
  inventoryProviders: [],
  sharedStyleRules: "",
};

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  // The reset endpoints the renderer hits after the user confirms the modal.
  // The server-side wipe is unit-tested elsewhere; here we only need it to
  // succeed so the renderer runs its local wipe → first-run path.
  await page.route("**/api/agent/reset", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/first-run/options", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FIRST_RUN_OPTIONS),
    });
  });

  await page.route("**/api/agent/restart", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: { state: "running", agentName: "Playwright Smoke" },
      }),
    });
  });
});

test("Reset Everything wipes the agent and returns to first-run onboarding", async ({
  page,
}) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Backup & Reset");

  // Opening the danger-zone warning must not run the destructive action.
  const resetRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/agent/reset"),
    { timeout: 15_000 },
  );

  await page.getByRole("button", { name: "Reset Everything" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Reset everything?")).toBeVisible();
  await expect(
    dialog.getByText(/Everything will be deleted and destroyed/),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Delete everything" }).click();

  // The reset actually fires against the server...
  await resetRequest;

  // ...and the renderer returns to the pre-agent first-run onboarding surface
  // (App.tsx gates this on `!firstRunComplete`, which the local wipe sets).
  await expect(page.getByTestId("pre-agent-cloud-shell")).toBeVisible({
    timeout: 20_000,
  });
});

test("cancelling the Reset Everything warning leaves the agent untouched", async ({
  page,
}) => {
  let resetCalled = false;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/agent/reset")
    ) {
      resetCalled = true;
    }
  });

  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Backup & Reset");

  await page.getByRole("button", { name: "Reset Everything" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Reset everything?")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toBeHidden();
  // Still on the settings shell — no onboarding redirect, no reset call.
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  expect(resetCalled).toBe(false);
});
