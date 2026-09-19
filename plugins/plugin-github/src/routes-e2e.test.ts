/**
 * Exercises the shipped GitHub routes through a real runtime, host registry and
 * loopback HTTP dispatcher. Credentials use isolated temporary storage; GitHub
 * fetch responses are deterministic and no external requests are sent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import http_ from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type IAgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/shared/api/http-plugin-runtime";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// Pin the credential store to an isolated temp dir BEFORE importing any module
// that resolves the state dir, so the real `loadMetadata`/`saveCredentials`/
// `clearCredentials` operate on throwaway disk state.
const stateDir = mkdtempSync(path.join(tmpdir(), "gh-routes-e2e-"));
const priorStateDir = process.env.ELIZA_STATE_DIR;
process.env.ELIZA_STATE_DIR = stateDir;

const { tryHandleRuntimePluginRoute } = await import(
  "../../../packages/agent/src/api/runtime-plugin-routes.ts"
);
const { githubPlugin } = await import("./index.ts");
const {
  clearCredentials,
  loadMetadata,
  buildCredentialsFromUserResponse,
  saveCredentials,
} = await import("./github-credentials.ts");

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

function makeRuntime(): IAgentRuntime {
  const runtime = new AgentRuntime({
    character: { name: "GitHub route fixture" },
    logLevel: "fatal",
  });
  registerHttpPluginRoutes(runtime, githubPlugin);
  return runtime;
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

  it("maps a GitHub upstream failure to 502, not a client 400", async () => {
    // A 5xx from GitHub means GitHub is failing, not that the token is invalid.
    // The route must surface that as an upstream error (502) so the client is
    // told to retry rather than being blamed for a bad token.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target !== "https://api.github.com/user") {
        return realFetch(input, init);
      }
      return new Response("upstream boom", { status: 503 });
    }) as typeof fetch;

    const base = await startServer();
    const res = await rawPost(
      base,
      "text/plain",
      JSON.stringify({ token: "ghp_upstream_down" }),
    );
    expect(res.status).toBe(502);
    // A transient upstream failure never persists a credential.
    expect(await loadMetadata()).toBeNull();
  });

  it("maps a 2xx GitHub response with an unparseable body to 502, not 500", async () => {
    // GitHub returning 200 with a non-JSON body is the same upstream-defect
    // class as a missing login field — an upstream error (502), not an internal
    // server error (500) and not a bad-token 400.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target !== "https://api.github.com/user") {
        return realFetch(input, init);
      }
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    const base = await startServer();
    const res = await rawPost(
      base,
      "text/plain",
      JSON.stringify({ token: "ghp_bad_body" }),
    );
    expect(res.status).toBe(502);
    expect(await loadMetadata()).toBeNull();
  });

  it("maps a network failure reaching GitHub to 502, not a client 400", async () => {
    // A thrown fetch (DNS/connection failure) is an upstream-reachability
    // problem; it must not be reported as a 400 bad token.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const target = typeof input === "string" ? input : String(input);
      if (target !== "https://api.github.com/user") {
        return realFetch(input, init);
      }
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const base = await startServer();
    const res = await rawPost(
      base,
      "text/plain",
      JSON.stringify({ token: "ghp_no_route" }),
    );
    expect(res.status).toBe(502);
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
