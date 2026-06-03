import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Every other ui-smoke spec seeds `eliza:first-run-complete = "1"`, so the
// onboarding surface never gets render-telemetry coverage. Startup now renders
// compact onboarding from StartupScreen, so this spec lands on that current
// surface with the guard armed and checks the runtime choices remain stable.

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function routeFirstRunIncomplete(page: Page): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, { complete: false, cloudProvisioned: false });
  });
}

test("first-run onboarding renders without a render loop and lets the runtime be chosen", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  // Land on a fresh device: no persisted first-run completion.
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const toast = page.getByTestId("onboarding-toast");
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast).toContainText("Set up your agent");

  await expect(toast.getByRole("button", { name: "Eliza Cloud" })).toBeVisible(
    { timeout: 15_000 },
  );
  const local = toast.getByRole("button", { name: "Use Local" });
  if (await local.count()) {
    await expect(local).toBeVisible();
  }

  // Dwell so any startup/onboarding render loop would cross the telemetry
  // error threshold.
  await page.waitForTimeout(4_000);

  await expectNoRenderTelemetryErrors(page, "first-run onboarding");
  await expect(toast).toBeVisible();
});
