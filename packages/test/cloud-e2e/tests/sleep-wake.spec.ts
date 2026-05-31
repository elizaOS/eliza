import {
  agentLifecycleAction,
  createCloudAgent,
  listBackups,
  pollSandboxStatus,
  startAgentProvisioning,
  tickProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

const onTick = (apiUrl: string) => async () => {
  await tickProvisioning({ apiUrl });
};

test.describe("sleep / wake", () => {
  test("running agent sleeps (durable backup + freed compute) then wakes back to running", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };

    // Provision to running.
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-sleep-wake",
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    // Sleep: a durable backup is taken, the container is removed, status → sleeping.
    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "sleep",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "sleeping", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    const backups = await listBackups(api, seededUser.apiKey, sandboxId);
    expect(
      backups.length,
      "sleep must leave at least one restore point",
    ).toBeGreaterThanOrEqual(1);

    // Wake: a fresh container is provisioned and state restored, status → running.
    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "wake",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });
  });

  test("sleep is idempotent for an already-sleeping agent", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-sleep-idem",
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "sleep",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "sleeping", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    // Second sleep on a sleeping agent short-circuits with 200 (no new job).
    const { body } = await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "sleep",
      [200],
    );
    expect(JSON.stringify(body)).toContain("already sleeping");
  });

  test("waking an already-running agent is a no-op", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-wake-noop",
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    const { body } = await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "wake",
      [200],
    );
    expect(JSON.stringify(body)).toContain("already running");
  });
});
