import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Every other ui-smoke spec seeds `eliza:first-run-complete = "1"`, so the
// in-chat first-run surface (#9952: the auto-opened ContinuousChatOverlay seeded
// by the headless conductor — greeting + runtime/provider ChoiceWidgets) never
// gets render-telemetry coverage. That surface is exactly where the agent-start
// render loop once froze onboarding, so this spec lands on it with the guard
// armed and drives the runtime selection that preceded the freeze. There is NO
// separate full-screen onboarding surface anymore — onboarding IS the chat.

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

// A full-capability host (real API base + Electrobun window marker) so the local
// finish path would be reachable; the in-chat conductor seeds the same three
// runtime choices (Cloud / On this device / Bring your own keys) regardless.
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, unknown>).__ELIZA_API_BASE__ =
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

test("in-chat first-run renders without a render loop and lets the runtime be chosen", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  // Land on a fresh device: no persisted first-run completion.
  await seedAppStorage(page, { "eliza:first-run-complete": "" });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The in-chat first-run flow renders inside the REAL floating chat overlay:
  // the agent greets first, then asks the runtime question as ChoiceWidgets.
  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  await expect(
    chatOverlay.getByText("Let's get you set up", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    chatOverlay.getByText("where should your agent run", { exact: false }),
  ).toBeVisible({ timeout: 15_000 });

  // The removed full-screen onboarding gate must NOT render — proof the surface
  // is genuinely chat-first.
  for (const removed of [
    "first-run-chat",
    "first-run-greeting",
    "startup-first-run-background",
  ]) {
    await expect(page.getByTestId(removed)).toHaveCount(0);
  }

  // The runtime question offers three in-chat ChoiceWidget options.
  const cloud = page.getByTestId("choice-__first_run__:runtime:cloud");
  const local = page.getByTestId("choice-__first_run__:runtime:local");
  const other = page.getByTestId("choice-__first_run__:runtime:other");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible();
  await expect(other).toBeVisible();

  // Local advances to the provider sub-choice (on-device vs Eliza Cloud vs
  // other) — the re-render churn on the newer step that previously froze.
  await local.click();
  await expect(
    page.getByTestId("choice-__first_run__:provider:on-device"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId("choice-__first_run__:provider:elizacloud"),
  ).toBeVisible();
  await expect(
    page.getByTestId("choice-__first_run__:provider:other"),
  ).toBeVisible();

  await expectNoRenderTelemetryErrors(page, "in-chat first-run flow");
  await expect(chatOverlay).toBeVisible();
});
