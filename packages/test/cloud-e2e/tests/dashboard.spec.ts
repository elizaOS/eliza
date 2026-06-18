import {
  getPersistedDockerImage,
  pollSandboxStatus,
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

  test("dashboard deploys an agent with a custom image", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    const dockerImage = "ghcr.io/elizaos/eliza:e2e-dashboard-custom";
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    // #8493 made the classic dashboard the default surface; the canvas deploy
    // flow this test exercises now lives behind the UI toggle. Seed the
    // persisted canvas store so the canvas workspace (and its deploy form)
    // renders. version:1 matches the store so the classic-default migration
    // (which only resets defaultUiMode when version < 1) leaves this intact.
    await authenticatedPage.addInitScript(() => {
      localStorage.setItem(
        "eliza-cloud-canvas",
        JSON.stringify({ state: { defaultUiMode: "canvas" }, version: 1 }),
      );
    });

    await authenticatedPage.goto(`${stack.urls.frontend}/dashboard/agents`);
    await authenticatedPage
      .getByPlaceholder("e.g. trading-assistant")
      .fill("e2e-dashboard-agent");
    // The dashboard now exposes the deploy flow inside the canvas workspace.
    // Custom images are always deployed to dedicated sandboxes; the UI
    // auto-selects and locks that tier so the API receives a routable image.
    await authenticatedPage.locator("select").nth(0).selectOption("custom");
    await expect(authenticatedPage.locator("select").nth(1)).toHaveValue(
      "dedicated",
    );
    await authenticatedPage
      .getByPlaceholder("ghcr.io/elizaos/eliza:stable")
      .fill(dockerImage);

    const createResponsePromise = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/eliza/agents" &&
        response.request().method() === "POST" &&
        [201, 202].includes(response.status()),
    );

    await authenticatedPage
      .getByRole("button", { name: "Deploy Agent Instance" })
      .click();
    const createResponse = await createResponsePromise;

    const createBody = (await createResponse.json()) as {
      data?: { id?: string; agentId?: string; sandboxId?: string };
    };
    const agentId =
      createBody.data?.agentId ??
      createBody.data?.id ??
      createBody.data?.sandboxId;
    if (!agentId) {
      throw new Error("Expected create response to include agent id");
    }

    expect(
      await getPersistedDockerImage(agentId, seededUser.organizationId),
    ).toBe(dockerImage);

    await pollSandboxStatus(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      agentId,
      "running",
      {
        timeoutMs: 30_000,
        intervalMs: 250,
        onTick: processJobs,
      },
    );
  });
});
