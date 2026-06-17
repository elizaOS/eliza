import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Every other ui-smoke spec seeds `eliza:first-run-complete = "1"`, so the
// onboarding surface (StartupScreen → CompactOnboarding, "Choose how to run
// your agent") never gets render-telemetry coverage. That surface is exactly
// where the agent-start render loop froze onboarding, so this spec lands on it
// with the guard armed and drives the runtime selection that preceded the
// freeze.

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

// A full-capability host (real API base) so the onboarding offers all three
// runtimes — without it the surface falls back to cloud-only and the Remote
// card is correctly disabled.
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
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
  await injectFullCapabilityHost(page);
  // Land on a fresh device: no persisted first-run completion.
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The onboarding card renders inside the orange first-run background. The
  // outer container testid is stable across the redesign.
  const onboarding = page.getByTestId("onboarding-toast");
  await expect(onboarding).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Choose how to run your agent")).toBeVisible({
    timeout: 15_000,
  });

  // The redesigned onboarding offers three runtime option cards. Cloud is the
  // recommended resting choice; Remote opens an inline connect form; Local
  // starts an on-device runtime. All three are always rendered (Remote is only
  // disabled on cloud-only hosts, never removed).
  const cloud = page.getByTestId("onboarding-option-cloud");
  const remote = page.getByTestId("onboarding-option-remote");
  const local = page.getByTestId("onboarding-option-local");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(remote).toBeVisible();
  await expect(local).toBeVisible();

  // Drive the Remote → Back round-trip a few times. Each pass re-renders the
  // onboarding selector — the same churn path that previously froze
  // onboarding — without committing a runtime and leaving the surface.
  for (let i = 0; i < 4; i++) {
    await remote.click();
    const remoteConnect = page.getByTestId("onboarding-remote-connect");
    await expect(remoteConnect).toBeVisible({ timeout: 10_000 });
    // The remote step exposes the agent URL + access-token fields.
    const apiBase = page.getByPlaceholder("https://agent.example.com");
    await expect(apiBase).toBeVisible();
    await apiBase.fill("https://agent.example.com");
    await page.getByPlaceholder("Access token (if required)").fill("");
    await expect(remoteConnect).toBeEnabled();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(cloud).toBeVisible({ timeout: 10_000 });
  }

  // Cloud remains the always-offered resting choice after the churn.
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(cloud).toBeEnabled({ timeout: 15_000 });

  await expectNoRenderTelemetryErrors(page, "first-run onboarding");
  await expect(onboarding).toBeVisible();
});
