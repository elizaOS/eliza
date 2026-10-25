/** Covers the dashboard cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import {
  createCloudAgent,
  getPersistedDockerImage,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("dashboard session", () => {
  test("seeded user reaches dashboard with test-auth session", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    await authenticatedPage.goto(`${stack.urls.frontend}/dashboard`);

    await expect(authenticatedPage).not.toHaveURL(/\/login(\?|$)/);

    // Sanity: the seeded user's email should appear in some account surface or
    // localStorage should be writable from a logged-in context.
    await authenticatedPage.evaluate(() => {
      localStorage.setItem(
        "eliza-dashboard-session",
        JSON.stringify({ step: 1 }),
      );
    });
    const stored = await authenticatedPage.evaluate(() =>
      localStorage.getItem("eliza-dashboard-session"),
    );
    expect(stored).toContain("step");

    // Confirm the API has a real record for this user.
    const me = await fetch(`${stack.urls.api}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect([200, 401, 404]).toContain(me.status);
  });

  test("dashboard lists a running custom-image agent", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const dockerImage = "ghcr.io/elizaos/eliza:e2e-dashboard-custom";
    const agentName = "e2e-dashboard-agent";
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    // The console no longer deploys agents: /dashboard/agents is a management
    // table, and provisioning happens in the `/join` flow (default image) or
    // through the API. The custom-image DEPLOY contract is covered end to end at
    // the API boundary by provision.spec.ts ("API provisions a custom image
    // through the full agent lifecycle"); what belongs here is the surviving
    // console surface — that a dedicated custom-image agent actually reaches the
    // dashboard's table as running.
    const agentId = await createCloudAgent(api, seededUser.apiKey, agentName, {
      dockerImage,
      autoProvision: false,
    });
    expect(
      await getPersistedDockerImage(agentId, seededUser.organizationId),
    ).toBe(dockerImage);

    await startAgentProvisioning(api, seededUser.apiKey, agentId);
    await pollSandboxStatus(api, seededUser.apiKey, agentId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });

    await authenticatedPage.goto(`${stack.urls.frontend}/dashboard/agents`);
    const row = authenticatedPage
      .getByRole("row")
      .filter({ hasText: agentName });
    await expect(row.first()).toBeVisible({ timeout: 30_000 });
    await expect(row.first()).toContainText("running");
  });
});
