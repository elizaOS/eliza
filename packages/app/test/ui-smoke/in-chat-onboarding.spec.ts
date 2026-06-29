import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Chat-centric first-run (#9952, Phase 1). With the `inChatOnboarding` flag ON
// a fresh profile lands directly on the homescreen with the REAL floating chat
// (ContinuousChatOverlay) auto-opened, and the onboarding greeting + runtime
// CHOICE are seeded into that live transcript — NOT the legacy full-screen
// FirstRunChat surface. This spec boots that path and asserts the real overlay
// renders the greeting + the runtime choice buttons, and that picking a choice
// is intercepted locally (no agent send) instead of going to the model.

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

// A full-capability host (real API base) so the runtime choice offers every
// option rather than falling back to cloud-only.
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

test("in-chat onboarding seeds the greeting + runtime choice into the real floating chat", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);
  // Fresh device + flag ON: no persisted first-run completion, in-chat path.
  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
    "eliza:in-chat-onboarding": "1",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The shell paints during first-run (flag ON) — the REAL ContinuousChatOverlay
  // mounts and auto-opens; the legacy full-screen FirstRunChat must NOT appear.
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("first-run-chat")).toHaveCount(0);

  // The seeded greeting renders as a normal assistant message.
  await expect(page.getByText(/hey there! I'm Eliza/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/How would you like to run me/i)).toBeVisible({
    timeout: 15_000,
  });

  // The runtime CHOICE renders for free via InlineWidgetText as real buttons.
  const cloud = page.getByTestId("choice-cloud");
  const local = page.getByTestId("choice-local");
  const other = page.getByTestId("choice-other");
  await expect(cloud).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeVisible();
  await expect(other).toBeVisible();

  await page.screenshot({
    path: "test/ui-smoke/__inchat__/in-chat-onboarding-runtime-choice.png",
    fullPage: true,
  });

  // Picking a runtime is intercepted locally (consumeFirstRunChoice) and routed
  // through the headless first-run use case — the agent send is skipped and the
  // next ConductorStep (the provider sub-choice) is seeded into the transcript.
  await local.click();
  await expect(page.getByTestId("choice-provider:on-device")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("choice-provider:elizacloud")).toBeVisible();

  await expectNoRenderTelemetryErrors(page, "in-chat onboarding");
});
