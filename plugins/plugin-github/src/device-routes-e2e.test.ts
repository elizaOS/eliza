/**
 * Route-level e2e for the GitHub device sign-in setup step (#15796).
 *
 * Boots the plugin's declared device-flow routes (`POST
 * /api/github/device/start|poll`) plus the token status route through the real
 * production dispatcher (`tryHandleRuntimePluginRoute`) over a loopback
 * `http.createServer` — exercising the real auth gate, the dispatcher's JSON
 * body pre-parse, and handler dispatch. Only GitHub's two OAuth endpoints and
 * `/user` are stubbed (the thing under test is our flow logic, not GitHub's
 * server); everything else — flow state, credential persistence, per-agent
 * runtime settings — is real.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import http_ from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Route } from "@elizaos/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// Pin the credential store to an isolated temp dir BEFORE importing any module
// that resolves the state dir, so the real `loadMetadata`/`saveCredentials`/
// `clearCredentials` operate on throwaway disk state.
const stateDir = mkdtempSync(path.join(tmpdir(), "gh-device-e2e-"));
const priorStateDir = process.env.ELIZA_STATE_DIR;
process.env.ELIZA_STATE_DIR = stateDir;

const { tryHandleRuntimePluginRoute } = await import(
  "../../../packages/agent/src/api/runtime-plugin-routes.ts"
);
const { handleGitHubRoutes } = await import("./routes/github-routes.ts");
const { clearDeviceFlowsForTest } = await import("./device-flow.ts");
const { clearCredentials, loadMetadata } = await import(
  "./github-credentials.ts"
);

/**
 * Mirror the plugin's route wiring from src/index.ts exactly — including the
 * runtime-derived context (agent scoping, per-agent oauth client id
 * resolution, and live-runtime token apply/clear). Importing the full plugin
 * object instead would drag in the entire (unrelated) action graph; the route
 * declaration + adapter is what we exercise.
 */
function createGitHubRouteHandler(method: "GET" | "POST" | "DELETE") {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? "/api/github/token", "http://localhost");
    const agentRuntime = runtime as IAgentRuntime;
    await handleGitHubRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      agentKey: String(agentRuntime.agentId),
      getOauthClientId: () => {
        const clientId = agentRuntime.getSetting("GITHUB_OAUTH_CLIENT_ID");
        return typeof clientId === "string" ? clientId : undefined;
      },
      applyRuntimeToken: (token) =>
        agentRuntime.setSetting("GITHUB_TOKEN", token, true),
      clearRuntimeToken: () => {
        const secrets = agentRuntime.character.secrets;
        if (secrets && "GITHUB_TOKEN" in secrets) delete secrets.GITHUB_TOKEN;
      },
    });
  };
}

const githubRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/github/token",
    rawPath: true,
    handler: createGitHubRouteHandler("GET"),
  },
  {
    type: "POST",
    path: "/api/github/token",
    rawPath: true,
    handler: createGitHubRouteHandler("POST"),
  },
  {
    type: "DELETE",
    path: "/api/github/token",
    rawPath: true,
    handler: createGitHubRouteHandler("DELETE"),
  },
  {
    type: "POST",
    path: "/api/github/device/start",
    rawPath: true,
    handler: createGitHubRouteHandler("POST"),
  },
  {
    type: "POST",
    path: "/api/github/device/poll",
    rawPath: true,
    handler: createGitHubRouteHandler("POST"),
  },
];

/** Per-test runtime stub: a real settings map per agent, nothing shared. */
function makeRuntime(options: {
  agentId: string;
  oauthClientId?: string;
}): IAgentRuntime & { secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  return {
    agentId: options.agentId,
    routes: githubRoutes,
    character: { name: "test", secrets },
    secrets,
    getSetting: (key: string) => {
      if (key === "GITHUB_OAUTH_CLIENT_ID")
        return options.oauthClientId ?? null;
      return secrets[key] ?? null;
    },
    setSetting: (
      key: string,
      value: string | boolean | null,
      _secret?: boolean,
    ) => {
      if (value !== null && value !== undefined) secrets[key] = String(value);
    },
    getService: () => null,
  } as unknown as IAgentRuntime & { secrets: Record<string, string> };
}

const servers: http.Server[] = [];
const realFetch = globalThis.fetch;

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

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

interface GitHubStubScript {
  deviceCode?: () => Response;
  token?: () => Response;
  user?: () => Response;
}

/**
 * Stub ONLY GitHub's endpoints on the global fetch; every other request
 * (including the test client's own loopback calls) uses the real fetch.
 */
function stubGitHub(script: GitHubStubScript): { calls: string[] } {
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
  return { calls };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function deviceCodeOk(): Response {
  return jsonResponse({
    device_code: "secret-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  });
}

/**
 * JSON POST via real fetch. The dispatcher pre-reads `application/json`
 * bodies and hands the parsed object to the handler — this is the exact
 * request shape the dashboard card sends.
 */
async function postJson(
  base: string,
  pathName: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await realFetch(`${base}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  clearDeviceFlowsForTest();
  await clearCredentials();
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

afterAll(() => {
  if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("github device sign-in routes (real dispatch)", () => {
  it("enforces the auth gate on both device routes", async () => {
    const base = await startServer(
      makeRuntime({ agentId: "agent-a", oauthClientId: "client-1" }),
      () => false,
    );
    const start = await postJson(base, "/api/github/device/start", {});
    expect(start.status).toBe(401);
    const poll = await postJson(base, "/api/github/device/poll", {
      flowId: "x",
    });
    expect(poll.status).toBe(401);
  });

  it("reports deviceFlowAvailable on the status route from the per-agent setting", async () => {
    const withClient = await startServer(
      makeRuntime({ agentId: "agent-a", oauthClientId: "client-1" }),
    );
    const withRes = (await (
      await realFetch(`${withClient}/api/github/token`)
    ).json()) as {
      connected: boolean;
      deviceFlowAvailable: boolean;
    };
    expect(withRes).toMatchObject({
      connected: false,
      deviceFlowAvailable: true,
    });

    const withoutClient = await startServer(
      makeRuntime({ agentId: "agent-b" }),
    );
    const withoutRes = (await (
      await realFetch(`${withoutClient}/api/github/token`)
    ).json()) as { deviceFlowAvailable: boolean };
    expect(withoutRes.deviceFlowAvailable).toBe(false);
  });

  it("start without an oauth client id is an explicit owner-setup 409 that names the fix", async () => {
    const base = await startServer(makeRuntime({ agentId: "agent-a" }));
    const res = await postJson(base, "/api/github/device/start", {});
    expect(res.status).toBe(409);
    const error = res.json.error as string;
    expect(error).toContain("GITHUB_OAUTH_CLIENT_ID");
    expect(error.toLowerCase()).toContain("personal access token");
  });

  it("runs the guided flow end to end: start → pending → grant → validated, persisted, applied per-agent", async () => {
    const runtime = makeRuntime({
      agentId: "agent-a",
      oauthClientId: "client-1",
    });
    const base = await startServer(runtime);

    let tokenPolls = 0;
    stubGitHub({
      deviceCode: deviceCodeOk,
      token: () => {
        tokenPolls += 1;
        return tokenPolls === 1
          ? jsonResponse({ error: "authorization_pending" })
          : jsonResponse({
              access_token: "gho_device_grant",
              token_type: "bearer",
              scope: "repo,read:user",
            });
      },
      user: () =>
        jsonResponse({ login: "octocat" }, 200, {
          "x-oauth-scopes": "repo, read:user",
        }),
    });

    const started = await postJson(base, "/api/github/device/start", {});
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({
      status: "started",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
    });
    const flowId = started.json.flowId as string;
    expect(flowId.length).toBeGreaterThan(10);
    // The GitHub-side device code never crosses to the browser.
    expect(JSON.stringify(started.json)).not.toContain("secret-device-code");

    const pending = await postJson(base, "/api/github/device/poll", { flowId });
    expect(pending.status).toBe(200);
    expect(pending.json).toMatchObject({ status: "pending" });
    expect(typeof pending.json.retryAfterSeconds).toBe("number");

    // GitHub's polling interval is owned server-side; jump past it by waiting
    // out the recorded nextPollAt via repeated polls with real time is slow,
    // so poll again after the interval the server reported — the flow store
    // uses wall-clock time. Interval is 5s; instead of sleeping, poll through
    // the throttle: an early poll stays pending and never contacts GitHub.
    const early = await postJson(base, "/api/github/device/poll", { flowId });
    expect(early.json.status).toBe("pending");
    expect(tokenPolls).toBe(1);

    // Now legitimately elapse the interval (short real wait is unavoidable
    // without poking module internals; 5s is the GitHub-mandated minimum).
    await new Promise((resolve) => setTimeout(resolve, 5_100));

    const completed = await postJson(base, "/api/github/device/poll", {
      flowId,
    });
    expect(completed.status).toBe(200);
    expect(completed.json).toMatchObject({
      status: "complete",
      connected: true,
      deviceFlowAvailable: true,
      username: "octocat",
      scopes: ["repo", "read:user"],
    });
    // The granted token is never returned to the browser…
    expect(JSON.stringify(completed.json)).not.toContain("gho_device_grant");
    // …but it really landed on disk through the real save path…
    expect(await loadMetadata()).toMatchObject({ username: "octocat" });
    // …and in THIS runtime's per-agent settings (not process.env).
    expect(runtime.secrets.GITHUB_TOKEN).toBe("gho_device_grant");
    expect(process.env.GITHUB_TOKEN ?? "").not.toBe("gho_device_grant");

    // Status route now reports connected.
    const status = (await (
      await realFetch(`${base}/api/github/token`)
    ).json()) as {
      connected: boolean;
      username: string;
    };
    expect(status.connected).toBe(true);
    expect(status.username).toBe("octocat");
  }, 30_000);

  it("a denied grant resolves to a terminal denied outcome and persists nothing", async () => {
    const runtime = makeRuntime({
      agentId: "agent-a",
      oauthClientId: "client-1",
    });
    const base = await startServer(runtime);
    stubGitHub({
      deviceCode: deviceCodeOk,
      token: () => jsonResponse({ error: "access_denied" }),
    });
    const started = await postJson(base, "/api/github/device/start", {});
    const denied = await postJson(base, "/api/github/device/poll", {
      flowId: started.json.flowId,
    });
    expect(denied.status).toBe(200);
    expect(denied.json).toEqual({ status: "denied" });
    expect(await loadMetadata()).toBeNull();
    expect(runtime.secrets.GITHUB_TOKEN).toBeUndefined();
  });

  it("an expired grant resolves to a terminal expired outcome", async () => {
    const base = await startServer(
      makeRuntime({ agentId: "agent-a", oauthClientId: "client-1" }),
    );
    stubGitHub({
      deviceCode: deviceCodeOk,
      token: () => jsonResponse({ error: "expired_token" }),
    });
    const started = await postJson(base, "/api/github/device/start", {});
    const expired = await postJson(base, "/api/github/device/poll", {
      flowId: started.json.flowId,
    });
    expect(expired.status).toBe(200);
    expect(expired.json).toEqual({ status: "expired" });
  });

  it("rejects a poll with a missing flowId (400) and an unknown flowId (404)", async () => {
    const base = await startServer(
      makeRuntime({ agentId: "agent-a", oauthClientId: "client-1" }),
    );
    const missing = await postJson(base, "/api/github/device/poll", {});
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain("flowId");

    const unknown = await postJson(base, "/api/github/device/poll", {
      flowId: "never-started",
    });
    expect(unknown.status).toBe(404);
  });

  it("scopes flows per agent: agent B's runtime cannot poll agent A's flow", async () => {
    const runtimeA = makeRuntime({
      agentId: "agent-a",
      oauthClientId: "client-1",
    });
    const runtimeB = makeRuntime({
      agentId: "agent-b",
      oauthClientId: "client-1",
    });
    const baseA = await startServer(runtimeA);
    const baseB = await startServer(runtimeB);
    stubGitHub({
      deviceCode: deviceCodeOk,
      token: () => jsonResponse({ access_token: "gho_cross", scope: "" }),
    });

    const started = await postJson(baseA, "/api/github/device/start", {});
    const hijack = await postJson(baseB, "/api/github/device/poll", {
      flowId: started.json.flowId,
    });
    expect(hijack.status).toBe(404);
    expect(runtimeB.secrets.GITHUB_TOKEN).toBeUndefined();
  });

  it("a GitHub-side registration failure at start surfaces as owner-setup 409", async () => {
    const base = await startServer(
      makeRuntime({ agentId: "agent-a", oauthClientId: "client-1" }),
    );
    stubGitHub({
      deviceCode: () => jsonResponse({ error: "device_flow_disabled" }),
    });
    const res = await postJson(base, "/api/github/device/start", {});
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("device_flow_disabled");
  });

  it("an unreachable GitHub at start surfaces as upstream 502", async () => {
    const base = await startServer(
      makeRuntime({ agentId: "agent-a", oauthClientId: "client-1" }),
    );
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target === DEVICE_CODE_URL) throw new Error("ECONNREFUSED");
      return realFetch(input, init);
    }) as typeof fetch;
    const res = await postJson(base, "/api/github/device/start", {});
    expect(res.status).toBe(502);
  });

  it("a grant whose token GitHub then rejects at /user is surfaced, and nothing persists", async () => {
    const runtime = makeRuntime({
      agentId: "agent-a",
      oauthClientId: "client-1",
    });
    const base = await startServer(runtime);
    stubGitHub({
      deviceCode: deviceCodeOk,
      token: () => jsonResponse({ access_token: "gho_revoked", scope: "" }),
      user: () => jsonResponse({ message: "Bad credentials" }, 401),
    });
    const started = await postJson(base, "/api/github/device/start", {});
    const res = await postJson(base, "/api/github/device/poll", {
      flowId: started.json.flowId,
    });
    expect(res.status).toBe(400);
    expect(await loadMetadata()).toBeNull();
    expect(runtime.secrets.GITHUB_TOKEN).toBeUndefined();
  });

  it("PAT paste (application/json, the dashboard card's shape) validates, persists, and applies per-agent", async () => {
    const runtime = makeRuntime({ agentId: "agent-a" });
    const base = await startServer(runtime);
    stubGitHub({
      user: () =>
        jsonResponse({ login: "octocat" }, 200, {
          "x-oauth-scopes": "repo, read:user",
        }),
    });
    const res = await postJson(base, "/api/github/token", {
      token: "ghp_pasted",
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ connected: true, username: "octocat" });
    expect(runtime.secrets.GITHUB_TOKEN).toBe("ghp_pasted");

    // DELETE disconnects the live runtime too, not just the disk record.
    const del = await realFetch(`${base}/api/github/token`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await loadMetadata()).toBeNull();
    expect(runtime.secrets.GITHUB_TOKEN).toBeUndefined();
  });
});
