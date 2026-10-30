/**
 * The managed gateway relay polls Eliza Cloud with the CloudAuth key. A
 * disconnect clears that key, and a login with another account replaces it;
 * the relay must follow both instead of polling the old session forever.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime, initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultMessageService } from "../../../plugin-assistant/src/services/message";
import { handleCloudRoute } from "../routes/cloud-routes";
import { CloudAuthService } from "./cloud-auth";
import { CloudManagedGatewayRelayService } from "./cloud-managed-gateway-relay";

interface RelayCall {
  method: string;
  path: string;
  apiKey: string | null;
  status: number;
}

/** Eliza Cloud stand-in: each relay session belongs to the key that registered it. */
function startCloud(): Promise<{ server: Server; baseUrl: string; calls: RelayCall[] }> {
  const calls: RelayCall[] = [];
  const owners = new Map<string, string>();
  const server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", "http://cloud.test");
    const apiKey =
      (request.headers["x-api-key"] as string | undefined) ??
      request.headers.authorization?.replace(/^Bearer\s+/i, "") ??
      null;
    const reply = (status: number, body: unknown) => {
      if (url.pathname.includes("/gateway-relay/")) {
        calls.push({ method: request.method ?? "GET", path: url.pathname, apiKey, status });
      }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on("end", () => {
      if (!apiKey) return reply(401, { success: false, error: "Unauthorized" });
      if (url.pathname === "/api/v1/models") return reply(200, { data: [] });
      if (request.method === "POST" && url.pathname === "/api/v1/eliza/gateway-relay/sessions") {
        const id = `session-${owners.size + 1}`;
        owners.set(id, apiKey);
        return reply(200, { success: true, data: { session: { id } } });
      }
      const match = /^\/api\/v1\/eliza\/gateway-relay\/sessions\/([^/]+)(\/next)?$/.exec(
        url.pathname
      );
      const owner = match ? owners.get(match[1]) : undefined;
      if (!match || !owner) return reply(404, { success: false, error: "Session not found" });
      if (owner !== apiKey) return reply(403, { success: false, error: "Forbidden" });
      if (request.method === "DELETE") return reply(200, { success: true });
      // An empty long poll.
      setTimeout(() => reply(200, { success: true, data: { request: null } }), 100);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/api/v1`, calls });
    });
  });
}

function req(method: string, url: string, body?: unknown): IncomingMessage {
  const r = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  ) as unknown as IncomingMessage;
  Object.assign(r, { method, url, headers: { host: "localhost" } });
  return r;
}

function res(): { r: ServerResponse; out: { status?: number } } {
  const out: { status?: number } = {};
  const r = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    getHeader() {},
    writeHead(s: number) {
      out.status = s;
      return r;
    },
    end() {
      if (out.status === undefined) out.status = r.statusCode;
    },
    write() {
      return true;
    },
  } as unknown as ServerResponse;
  return { r, out };
}

describe("managed gateway relay after a Cloud sign-out", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let cloud: Awaited<ReturnType<typeof startCloud>>;
  let runtime: AgentRuntime;
  let relay: CloudManagedGatewayRelayService;
  let state: Parameters<typeof handleCloudRoute>[4];

  async function route(method: string, pathname: string, body?: unknown): Promise<void> {
    const out = res();
    await handleCloudRoute(req(method, pathname, body), out.r, pathname, method, state);
    expect(out.out.status).toBe(200);
  }

  beforeEach(async () => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ELIZAOS_CLOUD") || key.startsWith("ELIZA_DEV_CLOUD")) {
        delete process.env[key];
      }
    }
    cloud = await startCloud();
    runtime = createSQLiteTestRuntime({
      character: { name: "Relay fixture", bio: ["tests"] },
      settings: { ELIZAOS_CLOUD_BASE_URL: cloud.baseUrl },
      logLevel: "fatal",
    });
    runtime.messageService = new DefaultMessageService();
    await runtime.registerService(CloudAuthService);
    await runtime.registerService(CloudManagedGatewayRelayService);
    await initializeTestRuntime(runtime, { skipMigrations: true });
    await runtime.getServiceLoadPromise(CloudAuthService.serviceType);
    relay = (await runtime.getServiceLoadPromise(
      CloudManagedGatewayRelayService.serviceType
    )) as CloudManagedGatewayRelayService;
    state = {
      config: {} as never,
      cloudManager: null,
      runtime: runtime as never,
      services: { saveElizaConfig: () => {} },
    } as never;
  });

  afterEach(async () => {
    await relay.stop();
    await runtime.stop();
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
    process.env = savedEnv;
  });

  it("stops polling Cloud once the user disconnects", async () => {
    await route("POST", "/api/cloud/login/persist", { apiKey: "eliza_key_a" });
    await vi.waitFor(() =>
      expect(cloud.calls.some((c) => c.path.endsWith("/next") && c.apiKey === "eliza_key_a")).toBe(
        true
      )
    );

    await route("POST", "/api/cloud/disconnect");

    await vi.waitFor(() => expect(relay.getSessionInfo().sessionId).toBeNull(), {
      timeout: 3_000,
    });
    const settled = cloud.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(cloud.calls.slice(settled)).toEqual([]);
    expect(cloud.calls.filter((c) => c.apiKey === null)).toEqual([]);
    expect(relay.getSessionInfo().status).toBe("idle");
  });

  it("registers a new session when another account signs in", async () => {
    await route("POST", "/api/cloud/login/persist", { apiKey: "eliza_key_a" });
    await vi.waitFor(() =>
      expect(cloud.calls.some((c) => c.path.endsWith("/next") && c.apiKey === "eliza_key_a")).toBe(
        true
      )
    );

    await route("POST", "/api/cloud/login/persist", { apiKey: "eliza_key_b" });

    await vi.waitFor(
      () =>
        expect(
          cloud.calls.some(
            (c) => c.path.endsWith("/next") && c.apiKey === "eliza_key_b" && c.status === 200
          )
        ).toBe(true),
      { timeout: 3_000 }
    );
    expect(cloud.calls.filter((c) => c.status === 401 || c.status === 403)).toEqual([]);
    expect(relay.getSessionInfo().sessionId).toBe("session-2");
  });
});
