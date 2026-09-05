/**
 * Targeted before/after capture for the AgentDetailPage invalid-timestamp
 * fallback fix (#18812) — reuses the same auth/API-stub infrastructure as
 * the general cloud-surfaces audit, but overrides the agent-detail response
 * with a malformed createdAt/lastHeartbeatAt to demonstrate the actual
 * defect and its fix, rather than the healthy/valid-data path the general
 * audit fixture exercises.
 */
import { expect, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  installCloudApiStubs,
  seedStewardToken,
} from "./helpers/cloud-audit-fixtures";

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

test.use({ video: "on" });

test.beforeEach(({ page }) => {
  installPageDiagnosticsGuard(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("agent detail page renders explicit fallbacks for a malformed agent timestamp", async ({
  page,
}) => {
  test.skip(
    !TEST_AUTH_ENABLED,
    "requires a renderer built with the explicit Playwright test-auth gate",
  );
  await seedStewardToken(page);
  // The dashboard surface was consolidated behind the booted app shell
  // (0468c1850a): /cloud/* renders only after startup resolves, so seed a
  // completed first-run and a managed-cloud active server or the page sits at
  // "Booting up..." forever.
  await seedAppStorage(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: "cloud:personal:11111111-1111-5111-8111-111111111111",
          kind: "cloud",
          label: "Eliza Cloud",
          apiBase: location.origin,
          cloudRuntimeAgentId: "22222222-2222-4222-8222-222222222222",
          cloudRuntime: "dedicated",
        }),
      );
    } catch {
      // Sandboxed frames can deny storage; the shell frame is what matters.
    }
  });
  await installDefaultAppRoutes(page);
  await installCloudApiStubs(page);
  await page.route("**/api/v1/eliza/agents/agent-smoke-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          id: "agent-smoke-1",
          agentName: "Smoke Agent",
          agent_name: "Smoke Agent",
          status: "running",
          executionTier: "standard",
          databaseStatus: "ready",
          webUiUrl: null,
          bridgeUrl: null,
          errorMessage: null,
          createdAt: "not-a-date",
          created_at: "not-a-date",
          updatedAt: "not-a-date",
          lastHeartbeatAt: "not-a-date",
          lastActiveAt: "not-a-date",
        },
      }),
    });
  });

  // The dashboard/* surface was consolidated into /cloud/* (0468c1850a);
  // agent detail now lives at /cloud/agents/:id.
  await page.goto("/cloud/agents/agent-smoke-1", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("text=Smoke Agent", { timeout: 15_000 });
  await page.waitForTimeout(500);

  const bodyText = await page.textContent("body");
  expect(bodyText).not.toContain("Invalid Date");

  await page.screenshot({
    path: "test-results/agent-detail-invalid-date-capture.png",
    fullPage: true,
  });

  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(600);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(600);
});
