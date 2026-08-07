/** Covers the provision cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
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

    const pairingResponse = await fetch(
      `${stack.urls.api}/api/v1/eliza/agents/${sandboxId}/pairing-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${seededUser.apiKey}` },
      },
    );
    expect(
      pairingResponse.status,
      `pairing-token returned ${pairingResponse.status}: ${await pairingResponse.clone().text()}`,
    ).toBe(200);
    const pairingBody = (await pairingResponse.json()) as {
      data?: { redirectUrl?: string };
    };
    // After #8262 the pairing redirect prefers the agent's stored bridge_url
    // (the local-docker provider sets http://127.0.0.1:<port>) over the legacy
    // <uuid>.<baseDomain> subdomain, which has no billing proxy behind it. The
    // redirect should therefore point at the bridge origin's /pair handler, not
    // the broken sandbox-id subdomain.
    const redirectUrl = pairingBody.data?.redirectUrl;
    expect(redirectUrl, `redirectUrl was ${redirectUrl}`).toBeDefined();
    const parsed = new URL(redirectUrl as string);
    expect(parsed.protocol === "http:" || parsed.protocol === "https:").toBe(
      true,
    );
    // Must point at the bridge origin, not the legacy <uuid>.<baseDomain>
    // subdomain that has no billing proxy behind it.
    expect(parsed.hostname).not.toBe(sandboxId);
    expect(redirectUrl?.startsWith(`https://${sandboxId}.`)).toBe(false);
    // When the agent advertises ELIZA_API_TOKEN the redirect carries the
    // one-time pairing token at /pair; otherwise it is the bare bridge origin.
    if (parsed.pathname === "/pair") {
      expect(parsed.searchParams.get("token")).toBeTruthy();
    }
  });

  test("coding-container API deploys populate the dashboard agent list", async ({
    stack,
    seededUser,
  }) => {
    const dockerImage = "ghcr.io/elizaos/eliza:e2e-coding-container";
    const deployRequest = fetch(`${stack.urls.api}/api/v1/coding-containers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${seededUser.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: "codex",
        workspacePath: "/workspace/api-created-agent",
        container: {
          name: "api-created-agent",
          image: dockerImage,
          environmentVars: {
            APP_ENV: "production",
            HTTP_PORT: "3000",
          },
        },
      }),
    });

    let deployDone = false;
    const deployResponsePromise = deployRequest.finally(() => {
      deployDone = true;
    });
    const deadline = Date.now() + 30_000;
    while (!deployDone && Date.now() < deadline) {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const deployResponse = await deployResponsePromise;
    expect(
      [201, 202],
      `coding container returned ${deployResponse.status}: ${await deployResponse.clone().text()}`,
    ).toContain(deployResponse.status);

    const deployBody = (await deployResponse.json()) as {
      data?: { containerId?: string; status?: string; url?: string | null };
    };
    const agentId = deployBody.data?.containerId;
    expect(agentId, "expected coding-container response id").toBeTruthy();

    const listResponse = await fetch(`${stack.urls.api}/api/v1/eliza/agents`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data?: Array<{
        id: string;
        agentName: string;
        dockerImage: string | null;
      }>;
    };
    const listed = listBody.data?.find((agent) => agent.id === agentId);

    expect(listed).toMatchObject({
      id: agentId,
      agentName: "api-created-agent",
      dockerImage,
    });
  });
});
