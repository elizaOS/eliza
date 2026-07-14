/**
 * Loopback end-to-end coverage for the production GitHub route adapters.
 * Requests cross the real runtime-plugin dispatcher and encrypted vault; only
 * GitHub's public OAuth and user endpoints are scripted at the network edge.
 */

import type http from "node:http";
import http_ from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { createTestVault } from "@elizaos/vault";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../packages/agent/src/api/runtime-plugin-routes.js";
import { clearDeviceFlowsForTest } from "./device-flow.js";
import {
  githubCredentialVaultKey,
  VaultGitHubCredentialStore,
} from "./github-credentials.js";
import { createGitHubRoutes } from "./github-route-adapter.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const realFetch = globalThis.fetch;
const testVault = await createTestVault();
const credentialStore = new VaultGitHubCredentialStore(testVault.vault);
const routes = createGitHubRoutes(credentialStore);
const servers: http.Server[] = [];
const agentKeys = ["agent-a", "agent-b"];

interface TestRuntime extends IAgentRuntime {
  testSecrets: Record<string, string>;
  githubRefreshes: number;
  workspaceRefreshes: number;
}

function makeRuntime(
  agentId: string,
  oauthClientId = "device-client-id",
): TestRuntime {
  const testSecrets: Record<string, string> = {};
  const runtime = {
    agentId,
    routes,
    character: { name: agentId, secrets: testSecrets, settings: {} },
    testSecrets,
    githubRefreshes: 0,
    workspaceRefreshes: 0,
    getSetting: (key: string) => {
      if (key === "GITHUB_OAUTH_CLIENT_ID") return oauthClientId || null;
      return testSecrets[key] ?? null;
    },
    setSetting: (key: string, value: string | boolean | null) => {
      if (value !== null) testSecrets[key] = String(value);
    },
    getService: (serviceType: string) => {
      if (serviceType === "github") {
        return {
          refreshCredentials: async () => {
            runtime.githubRefreshes += 1;
          },
        };
      }
      if (serviceType === "CODING_WORKSPACE_SERVICE") {
        return {
          refreshGitHubCredential: () => {
            runtime.workspaceRefreshes += 1;
          },
        };
      }
      return null;
    },
  } as unknown as TestRuntime;
  return runtime;
}

async function startServer(
  runtime: IAgentRuntime,
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const server = http_.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface GitHubScript {
  deviceCode?: () => Response;
  token?: () => Response;
  user?: () => Response;
}

function scriptGitHub(script: GitHubScript): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : String(input);
    if (target === DEVICE_CODE_URL && script.deviceCode) {
      calls.push(target);
      return script.deviceCode();
    }
    if (target === ACCESS_TOKEN_URL && script.token) {
      calls.push(target);
      return script.token();
    }
    if (target === USER_URL && script.user) {
      calls.push(target);
      return script.user();
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return calls;
}

function deviceCodeResponse(): Response {
  return jsonResponse({
    device_code: "server-only-device-code",
    user_code: "ELIZ-A159",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 0.01,
  });
}

function validUser(login: string): Response {
  return jsonResponse({ login }, 200, {
    "x-oauth-scopes": "repo, read:user",
  });
}

async function requestJson(
  base: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function savePat(
  base: string,
  token: string,
  login: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  scriptGitHub({ user: () => validUser(login) });
  return requestJson(base, "/api/github/token", "POST", { token });
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearDeviceFlowsForTest();
  await Promise.all(agentKeys.map((agent) => credentialStore.clear(agent)));
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

afterAll(async () => {
  await testVault.dispose();
});

describe("GitHub guided-auth production routes", () => {
  it("declares and authenticates the complete route lifecycle", async () => {
    expect(routes.map((route) => `${route.type} ${route.path}`)).toEqual([
      "GET /api/github/token",
      "POST /api/github/token",
      "DELETE /api/github/token",
      "POST /api/github/device/start",
      "POST /api/github/device/poll",
      "POST /api/github/device/cancel",
      "POST /api/github/device/reconnect",
    ]);
    const base = await startServer(makeRuntime("agent-a"), () => false);
    for (const [method, path] of routes.map((route) => [
      route.type,
      route.path,
    ])) {
      const response = await requestJson(
        base,
        path,
        method,
        method === "POST" ? {} : undefined,
      );
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("persists PATs per agent, refreshes only that runtime, and never uses host env", async () => {
    const priorHostToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_host_must_not_be_used";
    try {
      const runtimeA = makeRuntime("agent-a");
      const runtimeB = makeRuntime("agent-b");
      const baseA = await startServer(runtimeA);
      const baseB = await startServer(runtimeB);

      const connectedA = await savePat(baseA, "ghp_agent_a", "octocat-a");
      expect(connectedA).toMatchObject({
        status: 200,
        body: { connected: true, username: "octocat-a" },
      });
      expect(JSON.stringify(connectedA.body)).not.toContain("ghp_agent_a");
      expect(runtimeA.testSecrets.GITHUB_TOKEN).toBe("ghp_agent_a");
      expect(runtimeB.testSecrets.GITHUB_TOKEN).toBeUndefined();
      expect(runtimeA.githubRefreshes).toBe(1);
      expect(runtimeA.workspaceRefreshes).toBe(1);
      expect(process.env.GITHUB_TOKEN).toBe("ghp_host_must_not_be_used");

      const statusB = await requestJson(baseB, "/api/github/token");
      expect(statusB.body).toMatchObject({ connected: false });
      await savePat(baseB, "ghp_agent_b", "octocat-b");
      await expect(credentialStore.load("agent-a")).resolves.toMatchObject({
        token: "ghp_agent_a",
      });
      await expect(credentialStore.load("agent-b")).resolves.toMatchObject({
        token: "ghp_agent_b",
      });

      await requestJson(baseA, "/api/github/token", "DELETE");
      await expect(credentialStore.load("agent-a")).resolves.toBeNull();
      await expect(credentialStore.load("agent-b")).resolves.toMatchObject({
        token: "ghp_agent_b",
      });
      expect(runtimeB.testSecrets.GITHUB_TOKEN).toBe("ghp_agent_b");
    } finally {
      if (priorHostToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = priorHostToken;
    }
  });

  it("runs start → poll → grant through GitHub and stores no browser-visible secret", async () => {
    const runtime = makeRuntime("agent-a");
    const base = await startServer(runtime);
    let tokenPoll = 0;
    scriptGitHub({
      deviceCode: deviceCodeResponse,
      token: () => {
        tokenPoll += 1;
        return tokenPoll === 1
          ? jsonResponse({ error: "authorization_pending" })
          : jsonResponse({
              access_token: "gho_real_protocol_grant",
              token_type: "bearer",
              scope: "repo,read:user",
            });
      },
      user: () => validUser("device-user"),
    });

    const started = await requestJson(
      base,
      "/api/github/device/start",
      "POST",
      {},
    );
    expect(started).toMatchObject({
      status: 200,
      body: {
        status: "started",
        mode: "connect",
        userCode: "ELIZ-A159",
      },
    });
    expect(JSON.stringify(started.body)).not.toContain(
      "server-only-device-code",
    );
    const flowId = String(started.body.flowId);
    const pending = await requestJson(base, "/api/github/device/poll", "POST", {
      flowId,
    });
    expect(pending.body.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const completed = await requestJson(
      base,
      "/api/github/device/poll",
      "POST",
      { flowId },
    );
    expect(completed).toMatchObject({
      status: 200,
      body: { status: "complete", connected: true, username: "device-user" },
    });
    expect(JSON.stringify(completed.body)).not.toContain(
      "gho_real_protocol_grant",
    );
    await expect(credentialStore.load("agent-a")).resolves.toMatchObject({
      token: "gho_real_protocol_grant",
    });
    expect(runtime.testSecrets.GITHUB_TOKEN).toBe("gho_real_protocol_grant");
  });

  it("cancels on the server and exposes no cross-agent flow oracle", async () => {
    const baseA = await startServer(makeRuntime("agent-a"));
    const baseB = await startServer(makeRuntime("agent-b"));
    const calls = scriptGitHub({
      deviceCode: deviceCodeResponse,
      token: () => jsonResponse({ access_token: "gho_should_not_mint" }),
    });
    const started = await requestJson(
      baseA,
      "/api/github/device/start",
      "POST",
      {},
    );
    const flowId = String(started.body.flowId);
    const foreignCancel = await requestJson(
      baseB,
      "/api/github/device/cancel",
      "POST",
      { flowId },
    );
    expect(foreignCancel).toMatchObject({
      status: 404,
      body: { code: "GITHUB_DEVICE_FLOW_NOT_FOUND" },
    });
    const cancelled = await requestJson(
      baseA,
      "/api/github/device/cancel",
      "POST",
      { flowId },
    );
    expect(cancelled.body).toEqual({ status: "cancelled" });
    const replay = await requestJson(baseA, "/api/github/device/poll", "POST", {
      flowId,
    });
    expect(replay).toMatchObject({
      status: 404,
      body: { code: "GITHUB_DEVICE_FLOW_NOT_FOUND" },
    });
    expect(calls.filter((url) => url === ACCESS_TOKEN_URL)).toHaveLength(0);
  });

  it("keeps the old credential across denied reconnect and atomically replaces it on grant", async () => {
    const runtime = makeRuntime("agent-a");
    const base = await startServer(runtime);
    await savePat(base, "ghp_original", "original-user");

    scriptGitHub({
      deviceCode: deviceCodeResponse,
      token: () => jsonResponse({ error: "access_denied" }),
    });
    const deniedStart = await requestJson(
      base,
      "/api/github/device/reconnect",
      "POST",
      {},
    );
    const denied = await requestJson(base, "/api/github/device/poll", "POST", {
      flowId: deniedStart.body.flowId,
    });
    expect(denied.body).toEqual({ status: "denied" });
    await expect(credentialStore.load("agent-a")).resolves.toMatchObject({
      token: "ghp_original",
    });

    scriptGitHub({
      deviceCode: deviceCodeResponse,
      token: () => jsonResponse({ access_token: "gho_replacement" }),
      user: () => validUser("replacement-user"),
    });
    const replacementStart = await requestJson(
      base,
      "/api/github/device/reconnect",
      "POST",
      {},
    );
    const replaced = await requestJson(
      base,
      "/api/github/device/poll",
      "POST",
      { flowId: replacementStart.body.flowId },
    );
    expect(replaced.body).toMatchObject({
      status: "complete",
      username: "replacement-user",
    });
    await expect(credentialStore.load("agent-a")).resolves.toMatchObject({
      token: "gho_replacement",
    });
  });

  it("returns typed client, owner-setup, rejection, and upstream errors", async () => {
    const base = await startServer(makeRuntime("agent-a", ""));
    const missingFlow = await requestJson(
      base,
      "/api/github/device/poll",
      "POST",
      {},
    );
    expect(missingFlow).toMatchObject({
      status: 400,
      body: { code: "GITHUB_INVALID_REQUEST", retryable: false },
    });
    const noClient = await requestJson(
      base,
      "/api/github/device/start",
      "POST",
      {},
    );
    expect(noClient).toMatchObject({
      status: 409,
      body: { code: "GITHUB_DEVICE_OWNER_SETUP_REQUIRED" },
    });

    scriptGitHub({
      user: () => jsonResponse({ message: "Bad credentials" }, 401),
    });
    const rejected = await requestJson(base, "/api/github/token", "POST", {
      token: "ghp_bad",
    });
    expect(rejected).toMatchObject({
      status: 400,
      body: { code: "GITHUB_CREDENTIAL_REJECTED", retryable: false },
    });

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target === USER_URL) throw new Error("ECONNREFUSED");
      return realFetch(input, init);
    }) as typeof fetch;
    const upstream = await requestJson(base, "/api/github/token", "POST", {
      token: "ghp_network",
    });
    expect(upstream).toMatchObject({
      status: 502,
      body: { code: "GITHUB_UPSTREAM_UNAVAILABLE", retryable: true },
    });
  });

  it("returns a typed storage error instead of healthy-disconnected", async () => {
    const failingStore = {
      load: async () => {
        throw new Error("vault offline");
      },
      loadMetadata: async () => {
        throw new Error("vault offline");
      },
      save: async () => {
        throw new Error("vault offline");
      },
      clear: async () => {
        throw new Error("vault offline");
      },
    };
    const failingRoutes = createGitHubRoutes(failingStore);
    const runtime = makeRuntime("agent-a");
    runtime.routes = failingRoutes;
    const base = await startServer(runtime);
    const response = await requestJson(base, "/api/github/token");
    expect(response).toMatchObject({
      status: 500,
      body: { code: "GITHUB_CONNECTION_FAILED", retryable: false },
    });
  });

  it("stores only agent-specific vault keys", async () => {
    const baseA = await startServer(makeRuntime("agent-a"));
    const baseB = await startServer(makeRuntime("agent-b"));
    await savePat(baseA, "ghp_a", "a");
    await savePat(baseB, "ghp_b", "b");
    const keys = await testVault.vault.list("connector");
    expect(keys).toEqual(
      expect.arrayContaining([
        githubCredentialVaultKey("agent-a"),
        githubCredentialVaultKey("agent-b"),
      ]),
    );
  });
});
