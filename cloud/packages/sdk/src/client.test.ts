import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApiClient, CloudApiError, ElizaCloudClient, InsufficientCreditsError } from "./index";

let server: Server;
let baseUrl: string;
const requests: Array<{
  method: string;
  path: string;
  auth: string | null;
  apiKey: string | null;
}> = [];

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, init);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handleNodeRequest(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  async function handle(request: Request) {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      auth: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
    });

    if (url.pathname === "/api/openapi.json") {
      return json({
        openapi: "3.1.0",
        info: { title: "Eliza Cloud API", version: "1" },
        paths: {},
      });
    }
    if (url.pathname === "/api/auth/cli-session" && request.method === "POST") {
      const body = await readJson(request);
      return json(
        { sessionId: body.sessionId, status: "pending", expiresAt: "2030-01-01T00:00:00Z" },
        { status: 201 },
      );
    }
    if (url.pathname.startsWith("/api/auth/cli-session/")) {
      return json({ status: "pending" });
    }
    if (url.pathname === "/api/auth/pair") {
      return json({ message: "Paired successfully", apiKey: "agent-key", agentName: "Agent" });
    }
    if (url.pathname === "/api/v1/models") {
      return json({
        object: "list",
        data: [{ id: "openai/gpt-test", object: "model", created: 1, owned_by: "openai" }],
      });
    }
    if (url.pathname === "/api/v1/responses") {
      return json({ id: "resp_1", output_text: "ok", usage: { total_tokens: 1 } });
    }
    if (url.pathname === "/api/v1/chat/completions") {
      return json({ choices: [{ message: { content: "ok" } }] });
    }
    if (url.pathname === "/api/v1/embeddings") {
      return json({ data: [{ embedding: [0.1, 0.2], index: 0 }] });
    }
    if (url.pathname === "/api/v1/generate-image") {
      return json({ images: [{ url: "https://example.test/image.png" }], numImages: 1 });
    }
    if (url.pathname === "/api/v1/credits/balance") {
      return json({ balance: 42 });
    }
    if (url.pathname === "/api/v1/credits/summary") {
      return json({ success: true, organization: { id: "org", name: "Org", creditBalance: 42 } });
    }
    if (url.pathname === "/api/v1/containers") {
      if (request.method === "GET") return json({ success: true, data: [] });
      return json({ success: true, data: container("container-1") }, { status: 201 });
    }
    if (url.pathname === "/api/v1/containers/quota") {
      return json({ success: true, used: 0, max: 5 });
    }
    if (url.pathname === "/api/v1/containers/credentials") {
      return json({ success: true, repositoryUri: "example.dkr.ecr/repo" });
    }
    if (url.pathname === "/api/v1/containers/container-1/logs") {
      return new Response("hello log", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/api/v1/containers/container-1/health") {
      return json({
        success: true,
        data: { status: "ok", healthy: true, lastCheck: null, uptime: 1 },
      });
    }
    if (url.pathname === "/api/v1/containers/container-1/metrics") {
      return json({ cpu: 1 });
    }
    if (url.pathname === "/api/v1/containers/container-1/deployments") {
      return json({ deployments: [] });
    }
    if (url.pathname === "/api/v1/containers/container-1") {
      if (request.method === "DELETE") return json({ success: true });
      return json({ success: true, data: container("container-1") });
    }
    if (url.pathname === "/api/v1/eliza/agents") {
      if (request.method === "GET") return json({ success: true, data: [] });
      return json(
        { success: true, data: { id: "agent-1", agentName: "Agent", status: "pending" } },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/v1/eliza/agents/agent-1/pairing-token") {
      return json({ data: { token: "pair", redirectUrl: "https://agent.test", expiresIn: 60 } });
    }
    if (url.pathname === "/api/v1/eliza/agents/agent-1/backups") {
      return json({ success: true, data: [] });
    }
    if (url.pathname.startsWith("/api/v1/eliza/agents/agent-1/")) {
      return json({ success: true, data: { jobId: "job-1" } });
    }
    if (url.pathname === "/api/v1/eliza/agents/agent-1") {
      if (request.method === "DELETE") return json({ success: true, data: { jobId: "job-1" } });
      return json({
        success: true,
        data: { id: "agent-1", agentName: "Agent", status: "running" },
      });
    }
    if (url.pathname === "/api/v1/eliza/gateway-relay/sessions") {
      return json({ success: true, data: { session: gatewaySession("session-1") } });
    }
    if (url.pathname === "/api/v1/eliza/gateway-relay/sessions/session-1/next") {
      return json({ success: true, data: { request: null } });
    }
    if (url.pathname === "/api/v1/eliza/gateway-relay/sessions/session-1/responses") {
      return json({ success: true });
    }
    if (url.pathname === "/api/v1/eliza/gateway-relay/sessions/session-1") {
      return json({ success: true });
    }
    if (url.pathname === "/api/v1/jobs/job-1") {
      return json({ id: "job-1", status: "completed" });
    }
    if (url.pathname === "/api/v1/user") {
      return json({ success: true, data: { id: "user-1" } });
    }
    if (url.pathname === "/api/v1/api-keys") {
      if (request.method === "GET") return json({ keys: [] });
      return json({ apiKey: apiKeySummary("key-1"), plainKey: "eliza_plain" }, { status: 201 });
    }
    if (url.pathname === "/api/v1/api-keys/key-1/regenerate") {
      return json({ apiKey: apiKeySummary("key-1"), plainKey: "eliza_new" });
    }
    if (url.pathname === "/api/v1/api-keys/key-1") {
      if (request.method === "DELETE") return json({ success: true });
      return json({ apiKey: apiKeySummary("key-1") });
    }
    if (url.pathname === "/api/v1/needs-credits") {
      return json({ success: false, error: "Need credits", requiredCredits: 10 }, { status: 402 });
    }
    if (url.pathname === "/api/v1/fails") {
      return json({ error: { message: "Broken" } }, { status: 500 });
    }

    return json({ error: `Unhandled ${request.method} ${url.pathname}` }, { status: 404 });
  }

  async function handleNodeRequest(request: IncomingMessage, response: ServerResponse) {
    const body = await readNodeBody(request);
    const webRequest = new Request(`http://${request.headers.host}${request.url}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: body.length > 0 ? body : undefined,
    });
    const webResponse = await handle(webRequest);

    response.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => response.setHeader(key, value));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("ElizaCloudClient", () => {
  it("starts and polls CLI login", async () => {
    const client = new ElizaCloudClient({ baseUrl, apiBaseUrl: `${baseUrl}/api/v1` });
    const started = await client.startCliLogin({ sessionId: "session-test" });
    expect(started.browserUrl).toContain("/auth/cli-login?session=session-test");

    const poll = await client.pollCliLogin("session-test");
    expect(poll.status).toBe("pending");
  });

  it("calls auth pairing and OpenAPI endpoints without credentials", async () => {
    const client = new ElizaCloudClient({ baseUrl, apiBaseUrl: `${baseUrl}/api/v1` });
    await expect(client.getOpenApiSpec()).resolves.toMatchObject({ openapi: "3.1.0" });
    await expect(client.pairWithToken("pair", "https://agent.test")).resolves.toMatchObject({
      apiKey: "agent-key",
    });
  });

  it("sends API-key auth headers and calls all typed SDK helpers", async () => {
    const client = new ElizaCloudClient({
      baseUrl,
      apiBaseUrl: `${baseUrl}/api/v1`,
      apiKey: "eliza_test",
    });

    await expect(client.listModels()).resolves.toMatchObject({ data: [{ id: "openai/gpt-test" }] });
    await expect(
      client.createResponse({ model: "openai/gpt-test", input: "hi" }),
    ).resolves.toMatchObject({ id: "resp_1" });
    await expect(
      client.createChatCompletion({ model: "openai/gpt-test", messages: [] }),
    ).resolves.toMatchObject({ choices: [{ message: { content: "ok" } }] });
    await expect(
      client.createEmbeddings({ model: "text-embedding-3-small", input: "hi" }),
    ).resolves.toMatchObject({ data: [{ embedding: [0.1, 0.2] }] });
    await expect(client.generateImage({ prompt: "hi" })).resolves.toMatchObject({
      images: [{ url: "https://example.test/image.png" }],
    });
    await expect(client.getCreditsBalance({ fresh: true })).resolves.toMatchObject({ balance: 42 });
    await expect(client.getCreditsSummary()).resolves.toMatchObject({
      organization: { creditBalance: 42 },
    });
    await expect(client.listContainers()).resolves.toMatchObject({ data: [] });
    await expect(client.createContainer(containerRequest())).resolves.toMatchObject({
      data: { id: "container-1" },
    });
    await expect(client.getContainer("container-1")).resolves.toMatchObject({
      data: { id: "container-1" },
    });
    await expect(
      client.updateContainer("container-1", { status: "stopped" }),
    ).resolves.toMatchObject({ data: { id: "container-1" } });
    await expect(client.getContainerHealth("container-1")).resolves.toMatchObject({
      data: { healthy: true },
    });
    await expect(client.getContainerMetrics("container-1")).resolves.toMatchObject({ cpu: 1 });
    await expect(client.getContainerLogs("container-1")).resolves.toBe("hello log");
    await expect(client.getContainerDeployments("container-1")).resolves.toMatchObject({
      deployments: [],
    });
    await expect(client.getContainerQuota()).resolves.toMatchObject({ success: true });
    await expect(client.createContainerCredentials()).resolves.toMatchObject({ success: true });
    await expect(client.deleteContainer("container-1")).resolves.toMatchObject({ success: true });
    await expect(client.listAgents()).resolves.toMatchObject({ data: [] });
    await expect(client.createAgent({ agentName: "Agent" })).resolves.toMatchObject({
      data: { id: "agent-1" },
    });
    await expect(client.getAgent("agent-1")).resolves.toMatchObject({
      data: { id: "agent-1" },
    });
    await expect(client.updateAgent("agent-1", { agentName: "M" })).resolves.toMatchObject({
      data: { id: "agent-1" },
    });
    await expect(client.provisionAgent("agent-1")).resolves.toMatchObject({ success: true });
    await expect(client.suspendAgent("agent-1")).resolves.toMatchObject({ success: true });
    await expect(client.resumeAgent("agent-1")).resolves.toMatchObject({ success: true });
    await expect(client.createAgentSnapshot("agent-1")).resolves.toMatchObject({
      success: true,
    });
    await expect(client.listAgentBackups("agent-1")).resolves.toMatchObject({ data: [] });
    await expect(client.restoreAgentBackup("agent-1", "backup-1")).resolves.toMatchObject({
      success: true,
    });
    await expect(client.getAgentPairingToken("agent-1")).resolves.toMatchObject({
      token: "pair",
    });
    await expect(client.deleteAgent("agent-1")).resolves.toMatchObject({ success: true });
    await expect(
      client.registerGatewayRelaySession({ runtimeAgentId: "runtime-1" }),
    ).resolves.toMatchObject({ data: { session: { id: "session-1" } } });
    await expect(client.pollGatewayRelayRequest("session-1", 1)).resolves.toMatchObject({
      data: { request: null },
    });
    await expect(
      client.submitGatewayRelayResponse("session-1", "req-1", { jsonrpc: "2.0", result: {} }),
    ).resolves.toMatchObject({ success: true });
    await expect(client.disconnectGatewayRelaySession("session-1")).resolves.toMatchObject({
      success: true,
    });
    await expect(client.getJob("job-1")).resolves.toMatchObject({ status: "completed" });
    await expect(client.pollJob("job-1", { timeoutMs: 10, intervalMs: 1 })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(client.getUser()).resolves.toMatchObject({ data: { id: "user-1" } });
    await expect(client.updateUser({ name: "Agent" })).resolves.toMatchObject({
      data: { id: "user-1" },
    });
    await expect(client.listApiKeys()).resolves.toMatchObject({ keys: [] });
    await expect(client.createApiKey({ name: "test" })).resolves.toMatchObject({
      plainKey: "eliza_plain",
    });
    await expect(client.updateApiKey("key-1", { name: "renamed" })).resolves.toMatchObject({
      apiKey: { id: "key-1" },
    });
    await expect(client.regenerateApiKey("key-1")).resolves.toMatchObject({
      plainKey: "eliza_new",
    });
    await expect(client.deleteApiKey("key-1")).resolves.toMatchObject({ success: true });
    await expect(client.callEndpoint("GET", "/api/v1/models")).resolves.toMatchObject({
      object: "list",
    });

    const lastAuthed = requests.findLast((entry) => entry.path === "/api/v1/user");
    expect(lastAuthed?.auth).toBe("Bearer eliza_test");
    expect(lastAuthed?.apiKey).toBe("eliza_test");
  });
});

describe("CloudApiClient compatibility", () => {
  it("keeps the plugin-compatible /api/v1-relative client behavior", async () => {
    const client = new CloudApiClient(`${baseUrl}/api/v1`, "eliza_test");
    await expect(client.get("/models")).resolves.toMatchObject({ object: "list" });
    expect(client.buildWsUrl("/bridge")).toBe(`${baseUrl.replace(/^http/, "ws")}/api/v1/bridge`);
  });

  it("throws structured errors", async () => {
    const client = new CloudApiClient(`${baseUrl}/api/v1`, "eliza_test");
    await expect(client.get("/needs-credits")).rejects.toBeInstanceOf(InsufficientCreditsError);

    const error = await client.get("/fails").catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudApiError);
    expect((error as CloudApiError).statusCode).toBe(500);
    expect((error as CloudApiError).message).toBe("Broken");
  });
});

function container(id: string) {
  return {
    id,
    name: "Agent",
    project_name: "agent",
    description: null,
    organization_id: "org",
    user_id: "user",
    status: "running",
    image_tag: null,
    port: 3000,
    desired_count: 1,
    cpu: 256,
    memory: 512,
    architecture: "arm64",
    environment_vars: {},
    health_check_path: "/health",
    load_balancer_url: null,
    billing_status: "active",
    total_billed: "0",
    last_deployed_at: null,
    last_health_check: null,
    deployment_log: null,
    error_message: null,
    metadata: {},
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
  };
}

function containerRequest() {
  return {
    name: "Agent",
    project_name: "agent",
    image: "ghcr.io/agent-ai/agent:latest",
  };
}

function gatewaySession(id: string) {
  return {
    id,
    organizationId: "org",
    userId: "user",
    runtimeAgentId: "runtime-1",
    agentName: "Agent",
    platform: "local-runtime",
    createdAt: "2030-01-01T00:00:00Z",
    lastSeenAt: "2030-01-01T00:00:00Z",
  };
}

function apiKeySummary(id: string) {
  return {
    id,
    name: "test",
    key_prefix: "eliza",
    created_at: "2030-01-01T00:00:00Z",
  };
}

async function readNodeBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
