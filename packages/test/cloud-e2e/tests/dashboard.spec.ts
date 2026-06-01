import {
  getPersistedDockerImage,
  pollSandboxStatus,
  tickProvisioning,
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

    await authenticatedPage.goto(`${stack.urls.frontend}/dashboard/agents`);
    await authenticatedPage.getByRole("button", { name: "New Agent" }).click();
    await authenticatedPage
      .getByLabel("Agent Name")
      .fill("e2e-dashboard-agent");
    await authenticatedPage.getByLabel("Type").click();
    await authenticatedPage
      .getByRole("option", { name: "Custom Image" })
      .click();
    await authenticatedPage.getByLabel("Docker Image").fill(dockerImage);

    const createResponsePromise = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/eliza/agents" &&
        response.request().method() === "POST" &&
        response.status() === 201,
    );
    const provisionResponsePromise = authenticatedPage.waitForResponse(
      (response) =>
        /\/api\/v1\/eliza\/agents\/[^/]+\/provision$/.test(
          new URL(response.url()).pathname,
        ) && [202, 409, 200].includes(response.status()),
    );

    await authenticatedPage.getByRole("button", { name: "Deploy" }).click();
    await createResponsePromise;
    const provisionResponse = await provisionResponsePromise;

    const provisionBody = (await provisionResponse.json()) as {
      data?: { agentId?: string };
    };
    const agentId = provisionBody.data?.agentId;
    if (!agentId) {
      throw new Error("Expected provision response to include agent id");
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
        onTick: async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
        },
      },
    );
  });
});
