import {
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
  tickProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("deprovision", () => {
  test("DELETE agent transitions to deleted via async job", async ({
    stack,
    seededUser,
  }) => {
    // Provision first so we have something to delete.
    const sandboxId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      "e2e-deprovision",
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
        onTick: async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
        },
      },
    );

    // Issue DELETE — async flow from PR #7746 should enqueue an agent_delete job
    const delRes = await fetch(
      `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${seededUser.apiKey}` },
      },
    );
    expect([200, 202, 204]).toContain(delRes.status);

    // DELETE best-effort wakes the worker immediately, but the scheduled cron
    // endpoint is the production fallback. Drive that fallback explicitly so
    // mock-stack E2E proves the queued delete job can be processed end to end.
    const deleteTick = await tickProvisioning(
      { apiUrl: stack.urls.api },
      { timeoutMs: 60_000 },
    );
    expect(deleteTick.status).toBe(200);

    await expect
      .poll(
        async () => {
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
