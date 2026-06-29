import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Every other ui-smoke spec seeds `eliza:first-run-complete = "1"`, so the
// first-run surface (StartupScreen → FirstRunChat, the seeded "hey there! I'm
// Eliza" greeting + in-chat runtime/provider ChoiceWidgets) never gets
// render-telemetry coverage. That surface is exactly where the agent-start
// render loop froze onboarding, so this spec lands on it with the guard armed
// and drives the runtime selection that preceded the freeze.

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

// A full-capability host (real API base) so the first-run flow offers all three
// runtimes — without it the surface falls back to cloud-only and the Remote
// option is correctly hidden.
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

test("first-run flow renders without a render loop and lets the runtime be chosen", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  // Land on a fresh device: no persisted first-run completion.
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The in-chat first-run flow renders inside the orange first-run background:
  // the agent greets first, then asks the runtime question as ChoiceWidgets.
  const firstRun = page.getByTestId("first-run-chat");
  await expect(firstRun).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("first-run-greeting")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("run your agent locally", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });

  // The runtime question offers three in-chat ChoiceWidget options. Cloud is
  // the recommended resting choice; Remote opens an inline connect form; Local
  // advances to the provider sub-choice. (Remote is hidden on cloud-only hosts.)
  const cloud = page.getByTestId("choice-cloud");
  const remote = page.getByTestId("choice-remote");
  const local = page.getByTestId("choice-local");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(remote).toBeVisible();
  await expect(local).toBeVisible();

  // Drive the Remote → Back round-trip a few times. Each pass re-renders the
  // first-run selector — the same churn path that previously froze
  // onboarding — without committing a runtime and leaving the surface.
  for (let i = 0; i < 4; i++) {
    await remote.click();
    // The remote step exposes the agent URL + access-token fields.
    const apiBase = page.getByTestId("first-run-remote-address");
    await expect(apiBase).toBeVisible({ timeout: 10_000 });
    await apiBase.fill("https://agent.example.com");
    await page.getByTestId("first-run-remote-token").fill("");
    await expect(page.getByTestId("choice-connect")).toBeVisible();
    await page.getByTestId("choice-back").click();
    await expect(cloud).toBeVisible({ timeout: 10_000 });
  }

  // Local advances to the provider sub-choice (Eliza Cloud vs on-device), the
  // same re-render churn on the newer step.
  await local.click();
  await expect(page.getByTestId("choice-elizacloud")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("choice-on-device")).toBeVisible();

  await expectNoRenderTelemetryErrors(page, "first-run flow");
  await expect(firstRun).toBeVisible();
});
