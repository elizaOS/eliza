import { test, expect } from "../src/helpers/test-fixtures";
import {
  pollSandboxStatus,
  tickProvisioning,
} from "../src/helpers/provisioning";

test.describe("provision", () => {
  test("provisioning job transitions to running via control-plane tick", async ({
    stack,
    seededUser,
  }) => {
    // Drive provisioning entirely via API — the wizard surface is rich UI and
    // its CloudSetupSession flow varies build-to-build. The end-state contract
    // is what matters: a provisioning job exists, the cron tick processes it,
    // the sandbox ends `running`.
    const createRes = await fetch(`${stack.urls.api}/api/v1/eliza/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seededUser.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "e2e-provision-agent",
        plan: "starter",
      }),
    });

    expect(
      [200, 201, 202],
      `agent create returned ${createRes.status}: ${await createRes.clone().text()}`,
    ).toContain(createRes.status);

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
    expect(sandboxId, "expected sandbox id from create response").toBeTruthy();

    await pollSandboxStatus(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId as string,
      "running",
      {
        timeoutMs: 30_000,
        intervalMs: 250,
        onTick: async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
        },
      },
    );

    // Control-plane store should reflect a created sandbox
    const cpSandboxes = stack.mocks.controlPlane.store.allSandboxes();
    expect(cpSandboxes.length).toBeGreaterThan(0);
  });
});
