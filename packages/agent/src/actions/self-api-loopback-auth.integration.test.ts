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
import { renderLiveStateForScope } from "../providers/page-scoped-live-state.ts";
import { buildTestHandler } from "../runtime/custom-actions.ts";
import { logsAction } from "./logs.ts";
import { pluginAction } from "./plugin.ts";
import { runtimeAction } from "./runtime.ts";

interface CapturedRequest {
  method: string;
  pathname: string;
  authorization: string | undefined;
  body: string;
}

const ENV_KEYS = [
  "API_PORT",
  "ELIZA_API_AUTH_TOKEN",
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

async function startProtectedSelfApi(expectedToken: string): Promise<{
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

      if (request.authorization !== `Bearer ${expectedToken}`) {
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
    process.env.API_PORT = String(server.port);
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
    process.env.API_PORT = String(server.port);
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
