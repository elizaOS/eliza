import {
  agentLifecycleAction,
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("suspend / resume", () => {
  test("running agent suspends to stopped then resumes to running", async ({
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
      "e2e-suspend-resume",
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
      "suspend",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "stopped", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });

    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "resume",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });
  });
});
