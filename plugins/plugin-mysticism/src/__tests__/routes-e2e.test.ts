/**
 * Route-level e2e for plugin-mysticism (issue #8802).
 *
 * Boots the plugin's declared `Route[]` through the real production dispatcher
 * (`tryHandleRuntimePluginRoute`) over a loopback `http.createServer` — exercising
 * the real auth gate, JSON body parsing, query parsing, and handler dispatch —
 * with a faked `MysticismService` standing in for the only external dependency.
 * No mocked `json`/`error` functions: every assertion is on a real HTTP response.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createReadingRoutes } from "../routes/readings.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

interface FakeSession {
  id: string;
  type: string;
  phase: string;
  paymentStatus: string;
  createdAt: number;
  updatedAt: number;
}

function fakeSession(type: string): FakeSession {
  return {
    id: `session-${type}`,
    type,
    phase: "intro",
    paymentStatus: "unpaid",
    createdAt: 1,
    updatedAt: 1,
  };
}

interface FakeServiceState {
  session: FakeSession | null;
  calls: string[];
}

function makeRuntime(
  options: { withService?: boolean; state?: FakeServiceState } = {}
): AgentRuntime {
  const { withService = true, state } = options;
  const service = {
    startTarotReading: (entityId: string) => {
      state?.calls.push(`tarot:${entityId}`);
      return fakeSession("tarot");
    },
    startIChingReading: (entityId: string) => {
      state?.calls.push(`iching:${entityId}`);
      return fakeSession("iching");
    },
    startAstrologyReading: (entityId: string) => {
      state?.calls.push(`astrology:${entityId}`);
      return fakeSession("astrology");
    },
    getSession: () => state?.session ?? null,
  };
  return {
    routes: createReadingRoutes(),
    getService: (key: string) => (withService && key === "MYSTICISM" ? service : null),
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true
): Promise<string> {
  const server = http.createServer(async (req, res) => {
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

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_TAROT = {
  entityId: "entity-1",
  roomId: "room-1",
  question: "What awaits me?",
};

describe("plugin-mysticism routes (real dispatch)", () => {
  it("starts a tarot reading on valid input", async () => {
    const state: FakeServiceState = { session: null, calls: [] };
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/readings/tarot", VALID_TAROT);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      sessionId: string;
      type: string;
    };
    expect(body.success).toBe(true);
    expect(body.type).toBe("tarot");
    expect(body.sessionId).toBe("session-tarot");
    expect(state.calls).toContain("tarot:entity-1");
  });

  it("starts iching and astrology readings on valid input", async () => {
    const base = await startServer(makeRuntime());
    const iching = await postJson(base, "/api/readings/iching", VALID_TAROT);
    expect(iching.status).toBe(201);
    expect(((await iching.json()) as { type: string }).type).toBe("iching");

    const astrology = await postJson(base, "/api/readings/astrology", {
      entityId: "e",
      roomId: "r",
      birthYear: 1990,
      birthMonth: 6,
      birthDay: 15,
      birthHour: 12,
      birthMinute: 30,
      latitude: 40.7,
      longitude: -74,
      timezone: -5,
    });
    expect(astrology.status).toBe(201);
    expect(((await astrology.json()) as { type: string }).type).toBe("astrology");
  });

  it("rejects an invalid body with 400 from the real validator", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/readings/tarot", {
      entityId: "entity-1",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("roomId");
  });

  it("returns 503 when the mysticism service is unavailable", async () => {
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await postJson(base, "/api/readings/tarot", VALID_TAROT);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("service is not available");
  });

  it("enforces the auth gate on the default-auth reading routes", async () => {
    const base = await startServer(makeRuntime(), () => false);
    const res = await postJson(base, "/api/readings/tarot", VALID_TAROT);
    expect(res.status).toBe(401);
  });

  it("serves the public status route without auth and parses query params", async () => {
    const state: FakeServiceState = {
      session: fakeSession("tarot"),
      calls: [],
    };
    // Auth is denied, but the status route is public so it still serves.
    const base = await startServer(makeRuntime({ state }), () => false);

    const ok = await fetch(`${base}/api/readings/status?entityId=e&roomId=r`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { success: boolean; session: { id: string } };
    expect(body.success).toBe(true);
    expect(body.session.id).toBe("session-tarot");

    // Missing query params → 400 from the real handler.
    const missing = await fetch(`${base}/api/readings/status`);
    expect(missing.status).toBe(400);

    // No active session → 404.
    state.session = null;
    const notFound = await fetch(`${base}/api/readings/status?entityId=e&roomId=r`);
    expect(notFound.status).toBe(404);
  });
});
