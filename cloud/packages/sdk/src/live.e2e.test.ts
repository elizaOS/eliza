import { describe, expect, it } from "vitest";
import { CloudApiClient, createElizaCloudClient, ElizaCloudClient } from "./index.js";

const trimmed = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
};

const liveEnabled = process.env.ELIZA_CLOUD_SDK_LIVE === "1";
const baseUrl = trimmed(process.env.ELIZA_CLOUD_BASE_URL) ?? "https://www.elizacloud.ai";
const apiBaseUrl = trimmed(process.env.ELIZA_CLOUD_API_BASE_URL) ?? `${baseUrl}/api/v1`;
const apiKey =
  trimmed(process.env.ELIZAOS_CLOUD_API_KEY) ?? trimmed(process.env.ELIZA_CLOUD_API_KEY);
const sessionToken = trimmed(process.env.ELIZA_CLOUD_SESSION_TOKEN);
const generationEnabled = process.env.ELIZA_CLOUD_SDK_LIVE_GENERATION === "1";
const containerEnabled = process.env.ELIZA_CLOUD_SDK_LIVE_CONTAINERS === "1";
const agentEnabled = process.env.ELIZA_CLOUD_SDK_LIVE_AGENT === "1";
const relayEnabled = process.env.ELIZA_CLOUD_SDK_LIVE_RELAY === "1";
const destructiveEnabled = process.env.ELIZA_CLOUD_SDK_LIVE_DESTRUCTIVE === "1";
const profileWriteEnabled = process.env.ELIZA_CLOUD_SDK_LIVE_PROFILE_WRITE === "1";

const liveDescribe = liveEnabled ? describe : describe.skip;
const authedDescribe = liveEnabled && apiKey ? describe : describe.skip;
const sessionDescribe = liveEnabled && sessionToken ? describe : describe.skip;
const generationDescribe = liveEnabled && apiKey && generationEnabled ? describe : describe.skip;
const containerDescribe =
  liveEnabled && apiKey && containerEnabled && destructiveEnabled ? describe : describe.skip;
const agentDescribe =
  liveEnabled && apiKey && agentEnabled && destructiveEnabled ? describe : describe.skip;
const relayDescribe = liveEnabled && apiKey && relayEnabled ? describe : describe.skip;
const profileWriteDescribe =
  liveEnabled && apiKey && profileWriteEnabled && destructiveEnabled ? describe : describe.skip;

function publicClient() {
  return new ElizaCloudClient({ baseUrl, apiBaseUrl });
}

function clientWithApiKey() {
  return createElizaCloudClient({ baseUrl, apiBaseUrl, apiKey });
}

function clientWithSession() {
  return new ElizaCloudClient({ baseUrl, apiBaseUrl, bearerToken: sessionToken });
}

liveDescribe("ElizaCloudClient real API e2e: public, auth bootstrap, and raw access", () => {
  it.skipIf(!apiKey && process.env.ELIZA_CLOUD_SDK_LIVE_OPENAPI !== "1")(
    "fetches the live OpenAPI document through getOpenApiSpec, request, and requestRaw",
    async () => {
      const client = apiKey ? clientWithApiKey() : publicClient();

      const spec = await client.getOpenApiSpec();
      expect(spec.openapi).toMatch(/^3\./);
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0);

      await expect(client.request("GET", "/api/openapi.json")).resolves.toMatchObject({
        openapi: spec.openapi,
      });

      const raw = await client.requestRaw("GET", "/api/openapi.json");
      expect(raw.ok).toBe(true);
    },
  );

  it("starts a CLI login session and polls it with direct and templated endpoint calls", async () => {
    const client = publicClient();
    const started = await client.startCliLogin();
    expect(started.sessionId).toBeTruthy();
    expect(started.browserUrl).toContain("/auth/cli-login?session=");

    const polled = await client.pollCliLogin(started.sessionId);
    expect(polled.status).toBe("pending");

    const templated = await client.callEndpoint("GET", "/api/auth/cli-session/{sessionId}", {
      pathParams: { sessionId: started.sessionId },
      skipAuth: true,
    });
    expect(templated).toMatchObject({ status: "pending" });
  });

  it("lists public models through the high-level client and compatibility client", async () => {
    const client = publicClient();
    const models = await client.listModels();
    expect(Array.isArray(models.data)).toBe(true);

    const compatibility = new CloudApiClient(apiBaseUrl);
    await expect(compatibility.get("/models", { skipAuth: true })).resolves.toBeTruthy();
    expect(compatibility.buildWsUrl("/agent/gateway-relay")).toContain("/agent/gateway-relay");
  });
});

liveDescribe("ElizaCloudClient real API e2e: pairing token exchange", () => {
  it.skipIf(!process.env.ELIZA_CLOUD_PAIR_TOKEN)(
    "pairs with a supplied one-time pairing token",
    async () => {
      const paired = await publicClient().pairWithToken(
        process.env.ELIZA_CLOUD_PAIR_TOKEN as string,
        process.env.ELIZA_CLOUD_PAIR_ORIGIN ?? baseUrl,
      );
      expect(paired).toBeTruthy();
    },
  );
});

authedDescribe("ElizaCloudClient real API e2e: API-key read paths", () => {
  it("sets credentials after construction and gets the authenticated profile", async () => {
    const client = new ElizaCloudClient({ baseUrl, apiBaseUrl });
    client.setApiKey(apiKey);
    client.setBearerToken(undefined);

    await expect(client.getUser()).resolves.toMatchObject({ success: true });
  });

  it("gets credit balance and summary", async () => {
    const client = clientWithApiKey();
    await expect(client.getCreditsBalance({ fresh: true })).resolves.toHaveProperty("balance");
    await expect(client.getCreditsSummary()).resolves.toHaveProperty("success", true);
  });

  it("lists containers, container quota, and Eliza agents", async () => {
    const client = clientWithApiKey();
    await expect(client.listContainers()).resolves.toHaveProperty("success", true);
    await expect(client.getContainerQuota()).resolves.toBeTruthy();
    await expect(client.listAgents()).resolves.toHaveProperty("success", true);
  });
});

generationDescribe("ElizaCloudClient real API e2e: paid generation paths", () => {
  it("creates a responses API completion", async () => {
    const response = await clientWithApiKey().createResponse({
      model: process.env.ELIZA_CLOUD_SDK_TEXT_MODEL ?? "openai/gpt-5.4-mini",
      input: "Return the word ok.",
      max_output_tokens: 16,
    });
    expect(response).toBeTruthy();
  });

  it("creates a chat completion", async () => {
    const response = await clientWithApiKey().createChatCompletion({
      model: process.env.ELIZA_CLOUD_SDK_TEXT_MODEL ?? "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "Return the word ok." }],
      max_tokens: 16,
    });
    expect(response).toBeTruthy();
  });

  it("creates embeddings", async () => {
    const response = await clientWithApiKey().createEmbeddings({
      model: process.env.ELIZA_CLOUD_SDK_EMBEDDING_MODEL ?? "text-embedding-3-small",
      input: "Eliza Cloud SDK live e2e",
    });
    expect(response.data[0]?.embedding.length).toBeGreaterThan(0);
  });

  it("generates an image", async () => {
    const response = await clientWithApiKey().generateImage({
      prompt: "A simple orange circle on a white background",
      numImages: 1,
    });
    expect(response.images.length).toBeGreaterThan(0);
  });
});

relayDescribe("ElizaCloudClient real API e2e: gateway relay lifecycle", () => {
  it("registers, polls, optionally responds, and disconnects a relay session", async () => {
    const client = clientWithApiKey();
    const registered = await client.registerGatewayRelaySession({
      runtimeAgentId: `sdk-e2e-${Date.now()}`,
      agentName: "SDK e2e relay",
    });
    const sessionId = registered.data.session.id;
    expect(sessionId).toBeTruthy();

    const next = await client.pollGatewayRelayRequest(sessionId, 1);
    if (next.data.request) {
      await expect(
        client.submitGatewayRelayResponse(sessionId, next.data.request.requestId, {
          jsonrpc: "2.0",
          id: next.data.request.rpc.id,
          result: {},
        }),
      ).resolves.toHaveProperty("success", true);
    }

    await expect(client.disconnectGatewayRelaySession(sessionId)).resolves.toHaveProperty(
      "success",
      true,
    );
  });
});

authedDescribe("ElizaCloudClient real API e2e: job status", () => {
  it.skipIf(!process.env.ELIZA_CLOUD_SDK_JOB_ID)("gets and polls a supplied job id", async () => {
    const client = clientWithApiKey();
    const jobId = process.env.ELIZA_CLOUD_SDK_JOB_ID as string;
    await expect(client.getJob(jobId)).resolves.toHaveProperty("status");
    await expect(
      client.pollJob(jobId, { timeoutMs: 30_000, intervalMs: 1_000 }),
    ).resolves.toHaveProperty("status");
  });
});

containerDescribe("ElizaCloudClient real API e2e: container lifecycle", () => {
  it("creates, inspects, updates, reads operational endpoints, and deletes a container", async () => {
    const imageUri = process.env.ELIZA_CLOUD_SDK_CONTAINER_IMAGE_URI;
    if (!imageUri) {
      throw new Error("ELIZA_CLOUD_SDK_CONTAINER_IMAGE_URI is required for container live e2e");
    }

    const client = clientWithApiKey();
    await expect(client.createContainerCredentials()).resolves.toBeTruthy();

    const created = await client.createContainer({
      name: `sdk-e2e-${Date.now()}`,
      project_name: "sdk-e2e",
      image: imageUri,
    });
    const containerId = created.data.id;
    expect(containerId).toBeTruthy();

    try {
      await expect(client.getContainer(containerId)).resolves.toHaveProperty("success", true);
      await expect(client.updateContainer(containerId, { desired_count: 1 })).resolves.toBeTruthy();
      await expect(client.getContainerHealth(containerId)).resolves.toBeTruthy();
      await expect(client.getContainerMetrics(containerId)).resolves.toBeTruthy();
      await expect(client.getContainerDeployments(containerId)).resolves.toBeTruthy();
      await expect(client.getContainerLogs(containerId, 50)).resolves.toEqual(expect.any(String));
    } finally {
      await client.deleteContainer(containerId);
    }
  });
});

agentDescribe("ElizaCloudClient real API e2e: Eliza agent lifecycle", () => {
  it("creates, updates, snapshots, controls, inspects backups, and deletes an agent", async () => {
    const client = clientWithApiKey();
    const created = await client.createAgent({
      agentName: `sdk-e2e-${Date.now()}`,
      agentConfig: {},
    });
    const agentId = created.data.id;
    expect(agentId).toBeTruthy();

    try {
      await expect(client.getAgent(agentId)).resolves.toHaveProperty("success", true);
      await expect(
        client.updateAgent(agentId, {
          agentName: created.data.agentName ?? undefined,
        }),
      ).resolves.toBeTruthy();
      await expect(client.listAgentBackups(agentId)).resolves.toBeTruthy();
      await expect(
        client.createAgentSnapshot(agentId, "manual", { source: "sdk-e2e" }),
      ).resolves.toBeTruthy();
      await expect(client.provisionAgent(agentId)).resolves.toBeTruthy();
      await expect(client.suspendAgent(agentId)).resolves.toBeTruthy();
      await expect(client.resumeAgent(agentId)).resolves.toBeTruthy();

      await expect(client.getAgentPairingToken(agentId)).resolves.toBeTruthy();

      if (process.env.ELIZA_CLOUD_SDK_BACKUP_ID) {
        await expect(
          client.restoreAgentBackup(agentId, process.env.ELIZA_CLOUD_SDK_BACKUP_ID),
        ).resolves.toBeTruthy();
      }
    } finally {
      await client.deleteAgent(agentId);
    }
  });
});

sessionDescribe("ElizaCloudClient real API e2e: session-only API key management", () => {
  it("lists API keys with a browser session bearer token", async () => {
    await expect(clientWithSession().listApiKeys()).resolves.toHaveProperty("keys");
  });

  it("creates, regenerates, updates, and deletes an API key", async () => {
    const client = clientWithSession();
    const created = await client.createApiKey({
      name: `sdk-e2e-${Date.now()}`,
      description: "Created by @elizaos/cloud-sdk live e2e",
    });
    expect(created.plainKey).toMatch(/^eliza_/);

    try {
      await expect(client.regenerateApiKey(created.apiKey.id)).resolves.toHaveProperty("plainKey");
      await expect(
        client.updateApiKey(created.apiKey.id, { name: `${created.apiKey.name}-renamed` }),
      ).resolves.toBeTruthy();
    } finally {
      await client.deleteApiKey(created.apiKey.id);
    }
  });
});

profileWriteDescribe("ElizaCloudClient real API e2e: profile write path", () => {
  it("patches a caller-supplied profile field", async () => {
    const key = process.env.ELIZA_CLOUD_SDK_PROFILE_FIELD;
    const value = process.env.ELIZA_CLOUD_SDK_PROFILE_VALUE;
    if (!key || value === undefined) {
      throw new Error(
        "ELIZA_CLOUD_SDK_PROFILE_FIELD and ELIZA_CLOUD_SDK_PROFILE_VALUE are required",
      );
    }

    await expect(clientWithApiKey().updateUser({ [key]: value })).resolves.toBeTruthy();
  });
});
