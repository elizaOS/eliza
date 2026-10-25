/** Covers the sleep wake cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import {
  agentLifecycleAction,
  createCloudAgent,
  listBackups,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("sleep / wake", () => {
  test("running agent sleeps (durable backup + freed compute) then wakes back to running", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-sleep-wake",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
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
      onTick: processJobs,
    });

    const backups = await listBackups(api, seededUser.apiKey, sandboxId);
    expect(
      backups.length,
      "sleep must leave at least one restore point",
    ).toBeGreaterThanOrEqual(1);

    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "wake",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });
  });

  test("sleep is idempotent for an already-sleeping agent", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-sleep-idem",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
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
      onTick: processJobs,
    });

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
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-wake-noop",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
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
