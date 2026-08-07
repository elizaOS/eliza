/** Covers the deprovision cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import {
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("deprovision", () => {
  test("DELETE agent transitions to deleted via async job", async ({
    stack,
    seededUser,
  }) => {
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };
    const sandboxId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      "e2e-deprovision",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId,
    );

    await pollSandboxStatus(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId,
      "running",
      {
        timeoutMs: 30_000,
        onTick: processJobs,
      },
    );

    const delRes = await fetch(
      `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${seededUser.apiKey}` },
      },
    );
    expect([200, 202, 204]).toContain(delRes.status);

    await processJobs();

    await expect
      .poll(
        async () => {
          await processJobs();
          const res = await fetch(
            `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}`,
            { headers: { Authorization: `Bearer ${seededUser.apiKey}` } },
          );
          if (res.status === 404) return "deleted";
          const body = (await res.json().catch(() => ({}))) as {
            status?: string;
            data?: { status?: string };
          };
          return body.status ?? body.data?.status;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe("deleted");
  });
});
