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
  installCloudApiStubs,
  seedStewardToken,
} from "./helpers/cloud-audit-fixtures";

test.use({ video: "on" });

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

// The /dashboard cloud-console shell only renders in a renderer built with
// VITE_PLAYWRIGHT_TEST_AUTH=true (the Steward test-auth route shell); without
// it the app never leaves boot. Same gate as cloud-console-routes.spec.ts and
// the cloud-surfaces audit, which share these fixtures.
test.skip(
  !TEST_AUTH_ENABLED,
  "set VITE_PLAYWRIGHT_TEST_AUTH=true so StewardProvider renders the cloud console route shell",
);

test("agent detail page renders explicit fallbacks for a malformed agent timestamp", async ({
  page,
}) => {
  await seedStewardToken(page);
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

  await page.goto("/dashboard/agents/agent-smoke-1", {
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
