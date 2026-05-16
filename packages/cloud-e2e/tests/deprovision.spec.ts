import { test, expect } from "../src/helpers/test-fixtures";
import {
  pollSandboxStatus,
  tickProvisioning,
} from "../src/helpers/provisioning";

test.describe("deprovision", () => {
  test("DELETE agent transitions to deleted via async job", async ({
    stack,
    seededUser,
  }) => {
    // Provision first so we have something to delete.
    const createRes = await fetch(`${stack.urls.api}/api/v1/eliza/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seededUser.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "e2e-deprovision", plan: "starter" }),
    });
    expect([200, 201, 202]).toContain(createRes.status);
    const created = (await createRes.json()) as {
      id?: string;
      sandboxId?: string;
      data?: { id?: string; sandboxId?: string };
    };
    const sandboxId =
      created.sandboxId ??
      created.id ??
      created.data?.sandboxId ??
      created.data?.id;
    expect(sandboxId).toBeTruthy();

    await pollSandboxStatus(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId as string,
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

    // Tick and poll for `deleted` (or 404)
    await expect
      .poll(
        async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
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
        { timeout: 30_000, intervals: [250] },
      )
      .toMatch(/deleted|404/);

    // Hetzner mock servers map should be empty (or at least not contain this sandbox)
    const hetznerServers = [...stack.mocks.hetzner.store.servers.values()];
    expect(
      hetznerServers.filter((s) => s.status !== "deleted").length,
    ).toBeLessThanOrEqual(0);
  });
});
