/**
 * Real TCP coverage for agent-side callers crossing the bearer-protected
 * elizaOS self-API boundary. The server rejects missing or incorrect tokens;
 * the tests invoke the production actions, live-state renderer, and custom
 * shell handler rather than substituting fetch mocks.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRuntimeSwitchRoutes } from "../api/runtime-switch-routes.ts";
import { isAuthorized } from "../api/server-helpers-auth.ts";
import { renderLiveStateForScope } from "../providers/page-scoped-live-state.ts";
import { buildTestHandler } from "../runtime/custom-actions.ts";
import { logsAction } from "./logs.ts";
import { pluginAction } from "./plugin.ts";
import { runtimeAction } from "./runtime.ts";

/** The server process's own credential env, pinned per fixture. */
interface ServerCredentialEnv {
  canonical?: string;
  legacy?: string;
}

/**
 * Run the production authorization path with the server's own configured
 * credential env, independent of whatever the caller side currently has in
 * env. Accepts the raw env shape (canonical `ELIZA_API_TOKEN` and/or legacy
 * `ELIZA_API_AUTH_TOKEN`) so fixtures can exercise Bearer-prefixed and
 * legacy-only server configurations, not just a clean canonical value.
 */
function authorizeAsServer(
  req: http.IncomingMessage,
  serverEnv: ServerCredentialEnv,
): boolean {
  const savedCanonical = process.env.ELIZA_API_TOKEN;
  const savedLegacy = process.env.ELIZA_API_AUTH_TOKEN;
  if (serverEnv.canonical === undefined) delete process.env.ELIZA_API_TOKEN;
  else process.env.ELIZA_API_TOKEN = serverEnv.canonical;
  if (serverEnv.legacy === undefined) delete process.env.ELIZA_API_AUTH_TOKEN;
  else process.env.ELIZA_API_AUTH_TOKEN = serverEnv.legacy;
  try {
    return isAuthorized(req);
  } finally {
    if (savedCanonical === undefined) delete process.env.ELIZA_API_TOKEN;
    else process.env.ELIZA_API_TOKEN = savedCanonical;
    if (savedLegacy === undefined) delete process.env.ELIZA_API_AUTH_TOKEN;
    else process.env.ELIZA_API_AUTH_TOKEN = savedLegacy;
  }
}

interface CapturedRequest {
  method: string;
  pathname: string;
  authorization: string | undefined;
  body: string;
}

const ENV_KEYS = [
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
] as const;
const servers: http.Server[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function startProtectedSelfApi(
  serverEnv: string | ServerCredentialEnv,
): Promise<{
  port: number;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const request: CapturedRequest = {
        method: req.method ?? "GET",
        pathname: url.pathname,
        authorization: req.headers.authorization,
        body: await readBody(req),
      };
      requests.push(request);

      // Authorize with the REAL server helper, not a local string compare.
      // A fixture that checks `authorization === \`Bearer ${expected}\`` defines
      // the server to agree with the client and therefore cannot detect drift
      // between `createSelfApiRequestHeaders` and the credential the server
      // actually resolves (#17043). `isAuthorized` runs the production
      // `getConfiguredApiToken` -> `extractAuthToken` -> timing-safe compare.
      //
      // The server's configured credential env is pinned to `serverEnv` for the
      // duration of the check so a caller configured differently is a real
      // disagreement between two sides, not an identity comparison against the
      // same live env the caller just read.
      const pinnedServerEnv: ServerCredentialEnv =
        typeof serverEnv === "string" ? { canonical: serverEnv } : serverEnv;
      if (!authorizeAsServer(req, pinnedServerEnv)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      if (request.method === "GET" && request.pathname === "/api/plugins") {
        sendJson(res, 200, {
          plugins: [
            {
              id: "test-plugin",
              name: "Test Plugin",
              description: "A real loopback fixture response.",
              category: "plugin",
              enabled: true,
              configured: true,
              isActive: true,
              parameters: [],
              configKeys: [],
            },
          ],
        });
        return;
      }
      if (request.method === "GET" && request.pathname === "/api/logs") {
        sendJson(res, 200, { entries: [], sources: [], tags: [] });
        return;
      }
      if (request.method === "DELETE" && request.pathname === "/api/logs") {
        sendJson(res, 200, { cleared: 0 });
        return;
      }
      if (
        request.method === "POST" &&
        request.pathname === "/api/config/reload"
      ) {
        sendJson(res, 200, {
          reloaded: true,
          applied: [],
          requiresRestart: [],
        });
        return;
      }
      if (
        request.method === "POST" &&
        (request.pathname === "/api/local-inference/routing/preferred" ||
          request.pathname === "/api/local-inference/routing/policy")
      ) {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (
        request.method === "GET" &&
        request.pathname === "/api/browser-bridge/companions"
      ) {
        sendJson(res, 200, { companions: [] });
        return;
      }
      if (
        request.method === "POST" &&
        request.pathname === "/api/terminal/run"
      ) {
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    })().catch((error: unknown) => {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

const message = {
  agentId: "agent-1",
  entityId: "owner-1",
  roomId: "room-1",
  content: { text: "inspect the local runtime" },
} as never;

async function runProductionCallers(): Promise<boolean[]> {
  const pluginResult = await pluginAction.handler?.(
    {} as never,
    message,
    undefined,
    { parameters: { action: "list", type: "plugin" } } as never,
  );
  const searchResult = await logsAction.handler?.(
    {} as never,
    message,
    undefined,
    { parameters: { action: "search" } } as never,
  );
  const deleteResult = await logsAction.handler?.(
    {} as never,
    message,
    undefined,
    { parameters: { action: "delete" } } as never,
  );
  const reloadResult = await runtimeAction.handler?.(
    {} as never,
    message,
    undefined,
    { parameters: { action: "reload_config" } } as never,
  );
  const browserState = await renderLiveStateForScope(
    {
      getService: () => ({
        getWorkspaceSnapshot: async () => ({ mode: "extension", tabs: [] }),
      }),
      reportError: () => undefined,
    } as never,
    "page-browser",
  );
  const customShell = buildTestHandler({
    id: "self-api-shell",
    name: "Self API shell",
    description: "Exercises the runtime custom-action shell boundary.",
    parameters: [],
    handler: { type: "shell", command: "echo self-api-auth" },
    enabled: true,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  });
  const shellResult = await customShell({});
  let runtimeSwitchSucceeded = false;
  const runtimeSwitchRequest = Readable.from([
    Buffer.from(JSON.stringify({ target: "cloud" })),
  ]) as unknown as http.IncomingMessage;
  const runtimeSwitchHandled = await handleRuntimeSwitchRoutes({
    req: runtimeSwitchRequest,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/runtime/model-switch",
    json: (_res, data) => {
      runtimeSwitchSucceeded =
        typeof data === "object" &&
        data !== null &&
        (data as Record<string, unknown>).ok === true;
    },
    error: () => undefined,
  });

  return [
    pluginResult?.success === true,
    searchResult?.success === true,
    deleteResult?.success === true,
    reloadResult?.success === true,
    browserState?.includes("Agent Browser Bridge companion") === true,
    shellResult.ok,
    runtimeSwitchHandled && runtimeSwitchSucceeded,
  ];
}

beforeEach(() => {
  previousEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("authenticated agent self-API callers", () => {
  it("uses one normalized canonical bearer across the real TCP boundary", async () => {
    const token = "canonical-self-api-token";
    const server = await startProtectedSelfApi(token);
    process.env.ELIZA_PORT = String(server.port);
    process.env.ELIZA_API_PORT = String(server.port);
    process.env.ELIZA_API_TOKEN = ` bearer    ${token} `;
    process.env.ELIZA_API_AUTH_TOKEN = "wrong-legacy-token";

    const unauthenticated = await fetch(
      `http://127.0.0.1:${server.port}/api/logs`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(await runProductionCallers()).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);

    const authenticated = server.requests.slice(1);
    expect(authenticated.map((request) => request.pathname)).toEqual([
      "/api/plugins",
      "/api/logs",
      "/api/logs",
      "/api/config/reload",
      "/api/browser-bridge/companions",
      "/api/terminal/run",
      "/api/local-inference/routing/preferred",
      "/api/local-inference/routing/policy",
      "/api/local-inference/routing/preferred",
      "/api/local-inference/routing/policy",
    ]);
    expect(
      authenticated.every(
        (request) => request.authorization === `Bearer ${token}`,
      ),
    ).toBe(true);
    for (const request of authenticated) {
      expect(`${request.pathname}\n${request.body}`).not.toContain(token);
    }
  });

  it("uses the legacy compatibility token when the canonical key is absent", async () => {
    const token = "legacy-self-api-token";
    const server = await startProtectedSelfApi(token);
    process.env.ELIZA_PORT = String(server.port);
    process.env.ELIZA_API_PORT = String(server.port);
    process.env.ELIZA_API_AUTH_TOKEN = ` ${token} `;

    expect(await runProductionCallers()).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      server.requests.every(
        (request) => request.authorization === `Bearer ${token}`,
      ),
    ).toBe(true);
  });

  it("agrees with a server whose configured value carries a Bearer prefix", async () => {
    const token = "prefixed-server-side-token";
    // The operator pasted the whole header value into the server's env. The
    // server normalizes at `resolveApiSecurityConfig` and expects the bare
    // token; the caller resolves the identical credential, so both sides agree
    // by construction rather than by both happening to carry the prefix.
    const server = await startProtectedSelfApi({
      canonical: `Bearer ${token}`,
    });
    process.env.ELIZA_PORT = String(server.port);
    process.env.ELIZA_API_PORT = String(server.port);
    process.env.ELIZA_API_TOKEN = `Bearer ${token}`;

    expect(await runProductionCallers()).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      server.requests.every(
        (request) => request.authorization === `Bearer ${token}`,
      ),
    ).toBe(true);
  });

  it("never promotes a legacy-only server config into an inbound credential", async () => {
    const token = "legacy-only-server-token";
    // The server env carries ONLY the plugin-level compat key. The inbound
    // boundary is canonical-only (`getConfiguredApiToken` -> `resolveApiToken`),
    // so with local trust off the server has no credential that admits anyone —
    // a caller presenting the legacy value must still be rejected, exactly as
    // on develop. This is the regression guard for the credential-widening the
    // review flagged: the legacy key must stay caller-side.
    const server = await startProtectedSelfApi({ legacy: token });
    process.env.ELIZA_PORT = String(server.port);
    process.env.ELIZA_API_PORT = String(server.port);
    process.env.ELIZA_API_AUTH_TOKEN = token;

    const result = await logsAction.handler?.({} as never, message, undefined, {
      parameters: { action: "search" },
    } as never);

    expect(result).toMatchObject({
      success: false,
      values: { error: "LOGS_SEARCH_FAILED" },
    });
    expect(result?.text).toContain("HTTP 401");
    // The caller-side compat fallback still sent the legacy value as a bearer;
    // the server simply refuses to treat it as its own inbound credential.
    expect(server.requests[0]?.authorization).toBe(`Bearer ${token}`);
  });

  it.each([
    ["missing", undefined],
    ["incorrect", "wrong-self-api-token"],
  ])(
    "keeps %s credentials observable as structured action failures",
    async (_, token) => {
      const server = await startProtectedSelfApi("expected-self-api-token");
      process.env.ELIZA_PORT = String(server.port);
      if (token) process.env.ELIZA_API_TOKEN = token;

      const result = await logsAction.handler?.(
        {} as never,
        message,
        undefined,
        { parameters: { action: "search" } } as never,
      );

      expect(result).toMatchObject({
        success: false,
        values: { error: "LOGS_SEARCH_FAILED" },
      });
      expect(result?.text).toContain("HTTP 401");
      expect(server.requests[0]?.authorization).toBe(
        token ? `Bearer ${token}` : undefined,
      );
    },
  );
});
