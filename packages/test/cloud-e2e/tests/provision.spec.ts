import {
  createCloudAgent,
  getPersistedAgentSummary,
  getPersistedDockerImage,
  listActiveBillingResources,
  pollSandboxStatus,
  sendAgentBridgeRequest,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("provision", () => {
  test("shared agent skips provisioning and active billing while bridge routing works", async ({
    stack,
    seededUser,
  }) => {
    const sandboxId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      "e2e-shared-runtime-agent",
    );
    const persisted = await getPersistedAgentSummary(
      sandboxId,
      seededUser.organizationId,
    );

    expect(persisted).toMatchObject({
      status: "running",
      executionTier: "shared",
      sandboxId: null,
      billingStatus: "active",
    });

    const activeResources = await listActiveBillingResources(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
    );
    expect(
      activeResources
        .filter((resource) => resource.resourceType === "agent_sandbox")
        .map((resource) => resource.resourceId),
    ).not.toContain(sandboxId);

    const heartbeat = await sendAgentBridgeRequest(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId,
      { jsonrpc: "2.0", id: "shared-status", method: "heartbeat" },
    );
    expect(heartbeat.result).toMatchObject({
      status: "running",
      ready: true,
      agentId: sandboxId,
      runtime: "shared",
    });

    const invalidMessage = await sendAgentBridgeRequest(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId,
      { jsonrpc: "2.0", id: "shared-message", method: "message.send" },
    );
    expect(invalidMessage.error).toMatchObject({
      code: -32602,
      message: "message.send requires params.text",
    });
  });

  test("provisioning job transitions to running via control-plane tick", async ({
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
      "e2e-provision-agent",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);

    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });
  });

  test("API provisions a custom image through the full agent lifecycle", async ({
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
    const dockerImage = "ghcr.io/elizaos/eliza:e2e-custom";
    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-api-custom-image",
      { dockerImage, autoProvision: false },
    );

    expect(
      await getPersistedDockerImage(sandboxId, seededUser.organizationId),
    ).toBe(dockerImage);

    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);

    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      intervalMs: 250,
      onTick: processJobs,
    });

    expect(
      await getPersistedDockerImage(sandboxId, seededUser.organizationId),
    ).toBe(dockerImage);
  });
});
