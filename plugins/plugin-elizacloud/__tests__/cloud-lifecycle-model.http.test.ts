import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import { CloudBridgeError, ElizaCloudClient } from "../src/cloud/bridge-client.js";
import { CloudRuntimeProxy } from "../src/cloud/cloud-proxy.js";
import { type CloudRouteState, handleCloudRoute } from "../src/routes/cloud-routes-autonomous.js";
import { CloudAuthService } from "../src/services/cloud-auth.js";

interface ModelCase {
  scenario: number;
  authenticated?: boolean;
  configKey?: boolean;
  response?: number;
  shown?: number;
  rejected?: boolean;
  completed?: boolean;
  fallbackRequests?: number;
}
const input: { model: string; cases: ModelCase[] } | undefined = process.env
  .ELIZA_CLOUD_LIFECYCLE_MODEL_CASES
  ? JSON.parse(readFileSync(process.env.ELIZA_CLOUD_LIFECYCLE_MODEL_CASES, "utf8"))
  : undefined;
if (input) assert(["CloudAuthClear", "CloudStreamCompletion"].includes(input.model));
const authCases = input
  ? input.model === "CloudAuthClear"
    ? input.cases
    : []
  : [0, 1, 2, 3].map((scenario) => ({
      scenario,
      authenticated: false,
      configKey: false,
      response: scenario >= 2 ? 500 : 200,
    }));
const streamCases = input
  ? input.model === "CloudStreamCompletion"
    ? input.cases
    : []
  : [0, 1, 2, 3, 4].map((scenario) => ({
      scenario,
      shown: scenario === 1 || scenario === 3 ? 1 : 0,
      rejected: scenario !== 1,
      completed: scenario === 1,
      fallbackRequests: 0,
    }));

async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

let fixture: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
let auth: CloudAuthService;
let authServer: http.Server | undefined;
let authUrl: string;
let routeState: CloudRouteState;
let output: string;
beforeAll(async () => {
  if (authCases.length === 0) return;
  const root = testOutputPath("quint-cloud-lifecycle", "auth-http");
  mkdirSync(root, { recursive: true });
  output = mkdtempSync(path.join(root, "run-"));
  authServer = http.createServer((request, response) => {
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: { models: [] } }));
      return;
    }
    void handleCloudRoute(request, response, "/api/cloud/disconnect", "POST", routeState).catch(
      (error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    );
  });
  authUrl = await listen(authServer);
  fixture = await createTestRuntime({
    characterName: "CloudAuthClearModel",
    settings: { ELIZAOS_CLOUD_BASE_URL: authUrl },
  });
  await fixture.runtime.registerService(CloudAuthService);
  auth = (await fixture.runtime.getServiceLoadPromise("CLOUD_AUTH")) as CloudAuthService;
}, 120_000);
afterAll(async () => {
  await auth?.stop();
  await fixture?.cleanup();
  if (authServer) await close(authServer);
}, 120_000);

it.each(authCases)(
  "matches auth-clear model scenario $scenario",
  async (model) => {
    assert(fixture);
    auth.clearAuth();
    if (model.scenario % 2 === 1) auth.authenticateWithApiKey({ apiKey: "local-key" });
    const target = path.join(output, `save-${model.scenario}`);
    if (model.scenario >= 2) mkdirSync(target);
    routeState = {
      runtime: fixture.runtime,
      cloudManager: null,
      config: {
        cloud: { enabled: true, ...(model.scenario % 2 === 1 ? { apiKey: "local-key" } : {}) },
      },
      saveConfig(config) {
        writeFileSync(target, JSON.stringify(config));
      },
    };
    const response = await fetch(`${authUrl}/api/cloud/disconnect`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(model.response);
    expect(auth.isAuthenticated()).toBe(model.authenticated);
    expect(Boolean(routeState.config.cloud?.apiKey)).toBe(model.configKey);
    expect(auth.getCredentials()).toBeNull();
    expect(auth.getClient().getApiKey()).toBeUndefined();
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(model.response === 200);
    if (model.response === 200) {
      expect(JSON.parse(readFileSync(target, "utf8")).cloud?.apiKey).toBeUndefined();
    }
  },
  60_000
);

it.each(streamCases)(
  "matches stream-completion model scenario $scenario",
  async (model) => {
    const frames = [
      'event: done\ndata: {"ok":true}\n\n',
      'event: done\ndata: {"fullText":"answer"}\n\n',
      'event: error\ndata: {"message":"upstream failed","type":"error"}\n\n',
      'event: chunk\ndata: {"text":"partial","fullText":"partial"}\n\nevent: error\ndata: {"message":"upstream failed","type":"error"}\n\n',
      'event: error\ndata: {"type":"error"}\n\n',
    ];
    let streamRequests = 0;
    let fallbackRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url?.endsWith("/stream")) {
        streamRequests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frames[model.scenario]);
      } else {
        fallbackRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: { text: "resend" } }));
      }
    });
    const url = await listen(server);
    try {
      const proxy = new CloudRuntimeProxy(
        new ElizaCloudClient(url, "local-key"),
        "model-agent",
        "Agent"
      );
      let shown = "";
      let completed = false;
      let rejected = false;
      try {
        for await (const text of proxy.handleChatMessageStream("read the fixture")) shown += text;
        if (!shown) shown = await proxy.handleChatMessage("read the fixture");
        completed = true;
      } catch (error) {
        expect(error).toBeInstanceOf(CloudBridgeError);
        const messages = [
          "Cloud stream ended without reply text",
          "",
          "upstream failed",
          "upstream failed",
          "Cloud stream failed",
        ];
        expect((error as Error).message).toBe(messages[model.scenario]);
        rejected = true;
      }
      expect(Number(shown.length > 0)).toBe(model.shown);
      expect(completed).toBe(model.completed);
      expect(rejected).toBe(model.rejected);
      expect(fallbackRequests).toBe(model.fallbackRequests);
      expect(streamRequests).toBe(1);
    } finally {
      await close(server);
    }
  },
  60_000
);
