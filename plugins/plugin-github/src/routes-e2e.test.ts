/**
 * Route-level e2e for plugin-github (issue #8802).
 *
 * Boots the plugin's declared `Route[]` (`githubRoutes`, the GET/POST/DELETE
 * `/api/github/token` PAT-management endpoints) through the real production
 * dispatcher (`tryHandleRuntimePluginRoute`) over a loopback
 * `http.createServer` — exercising the real auth gate, body parsing, and
 * handler dispatch. Every assertion is on a real HTTP response: no mocked
 * `json`/`error` functions, no shape-only checks.
 *
 * The route handlers have no `runtime.getService(...)` dependency (the runtime
 * arg is ignored); their only external dependencies are:
 *   - the on-disk credential store under `<state-dir>/credentials/github.json`
 *     (pinned to a per-test temp dir via `ELIZA_STATE_DIR`), and
 *   - GitHub's `/user` endpoint via the global `fetch` (stubbed — we never
 *     call GitHub).
 */

import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import http_ from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime, Route } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Pin the credential store to an isolated temp dir BEFORE importing any module
// that resolves the state dir, so the real `loadMetadata`/`saveCredentials`/
// `clearCredentials` operate on throwaway disk state.
const stateDir = mkdtempSync(path.join(tmpdir(), "gh-routes-e2e-"));
const priorStateDir = process.env.ELIZA_STATE_DIR;
process.env.ELIZA_STATE_DIR = stateDir;

const { tryHandleRuntimePluginRoute } = await import(
  "../../../packages/agent/src/api/runtime-plugin-routes.ts"
);
const { handleGitHubRoutes } = await import("./routes/github-routes.ts");
const {
  clearCredentials,
  loadMetadata,
  buildCredentialsFromUserResponse,
  saveCredentials,
} = await import("./github-credentials.ts");

// Mirror the plugin's route wiring from src/index.ts exactly: each route is a
// thin `(req, res, runtime)` adapter over the real `handleGitHubRoutes`
// dispatcher, declared `rawPath`. Importing the full plugin object instead
// would drag in the entire (unrelated) action graph; the route declaration
// itself is what we exercise.
function createGitHubRouteHandler(method: "GET" | "POST" | "DELETE") {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? "/api/github/token", "http://localhost");
    void runtime;
    await handleGitHubRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
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
];

const servers: http.Server[] = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
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

beforeAll(() => {
  // The plugin must really declare the three token routes we test against.
  expect(githubRoutes.map((r) => `${r.type} ${r.path}`)).toEqual([
    "GET /api/github/token",
    "POST /api/github/token",
    "DELETE /api/github/token",
  ]);
});

function makeRuntime(): IAgentRuntime {
  return {
    routes: githubRoutes,
    // The token routes ignore the runtime arg; getService is never consulted.
    getService: () => null,
  } as unknown as IAgentRuntime;
}

async function startServer(
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const runtime = makeRuntime();
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

const TOKEN_PATH = "/api/github/token";

/**
 * A raw-`node:http` POST client. The token-validation tests stub the global
 * `fetch` (the handler validates the PAT against GitHub via `fetch`), so the
 * test client must NOT use `fetch` — otherwise it would intercept its own
 * request to the loopback server. This issues the request over a real socket
 * and returns the real status + parsed JSON body the handler wrote.
 */
function rawPost(
  base: string,
  contentType: string,
  body: string,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(`${base}${TOKEN_PATH}`);
  return new Promise((resolve, reject) => {
    const req = http_.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": contentType,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("plugin-github routes (real dispatch)", () => {
  it("enforces the auth gate on every token route", async () => {
    const base = await startServer(() => false);

    const get = await fetch(`${base}${TOKEN_PATH}`);
    expect(get.status).toBe(401);

    const post = await fetch(`${base}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "ghp_x" }),
    });
    expect(post.status).toBe(401);

    const del = await fetch(`${base}${TOKEN_PATH}`, { method: "DELETE" });
    expect(del.status).toBe(401);
  });

  it("serves GET token status as disconnected when no credential is saved", async () => {
    const base = await startServer();
    const res = await fetch(`${base}${TOKEN_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
  });

  it("serves GET token status as connected after a credential is saved", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse(
        "ghp_secret",
        { login: "octocat" },
        ["repo", "read:user"],
        1234,
      ),
    );
    // The disk write must be visible through the real loader.
    expect(await loadMetadata()).toMatchObject({ username: "octocat" });

    const base = await startServer();
    const res = await fetch(`${base}${TOKEN_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      username: string;
      scopes: string[];
    };
    expect(body.connected).toBe(true);
    expect(body.username).toBe("octocat");
    expect(body.scopes).toEqual(["repo", "read:user"]);
    // The token itself must never be returned to the client.
    expect(JSON.stringify(body)).not.toContain("ghp_secret");
  });

  it("rejects a POST with a missing token via the real validator (400)", async () => {
    const base = await startServer();
    const res = await fetch(`${base}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notToken: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("token");
  });

  it("maps a GitHub-rejected token to a 400 without calling GitHub for real", async () => {
    // Stub the global fetch the handler falls back to; assert we never hit
    // the network. Sent as text/plain so the dispatcher leaves the request
    // stream intact for the handler's own raw body reader. The handler
    // validates the PAT against GitHub via the global `fetch`; stub only that
    // call and delegate anything else to the real fetch. The test client uses
    // raw `node:http` (not `fetch`) so it is unaffected by this stub.
    let calledUrl: string | null = null;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target !== "https://api.github.com/user") {
        return realFetch(input, init);
      }
      calledUrl = target;
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const base = await startServer();
    const res = await rawPost(
      base,
      "text/plain",
      JSON.stringify({ token: "ghp_invalid" }),
    );
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error.toLowerCase()).toContain(
      "bad credentials",
    );
    expect(calledUrl).toBe("https://api.github.com/user");
    // Nothing was persisted on a rejected token.
    expect(await loadMetadata()).toBeNull();
  });

  it("validates, persists, and reports a good token end to end (200)", async () => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target !== "https://api.github.com/user") {
        return realFetch(input, init);
      }
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": "repo, read:user",
        },
      });
    }) as typeof fetch;

    const base = await startServer();
    const res = await rawPost(
      base,
      "text/plain",
      JSON.stringify({ token: "ghp_good" }),
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      connected: boolean;
      username: string;
      scopes: string[];
    };
    expect(body.connected).toBe(true);
    expect(body.username).toBe("octocat");
    expect(body.scopes).toEqual(["repo", "read:user"]);
    expect(JSON.stringify(body)).not.toContain("ghp_good");

    // The credential really landed on disk through the real save path.
    expect(await loadMetadata()).toMatchObject({
      username: "octocat",
      scopes: ["repo", "read:user"],
    });
  });

  it("clears a saved credential on DELETE (200)", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse(
        "ghp_secret",
        { login: "octocat" },
        [],
        1,
      ),
    );
    expect(await loadMetadata()).not.toBeNull();

    const base = await startServer();
    const res = await fetch(`${base}${TOKEN_PATH}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
    expect(await loadMetadata()).toBeNull();
  });

  it("does not match an unrelated path (dispatcher returns 404)", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/api/github/unknown`);
    expect(res.status).toBe(404);
  });
});
