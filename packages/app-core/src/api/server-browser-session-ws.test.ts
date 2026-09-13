/**
 * Exercises owner browser-cookie admission through the real app-core HTTP and
 * WebSocket server with PGlite-backed identities, sessions, expiry and revocation.
 * The transport must agree with the session authority without admitting ambient
 * cookies from missing or untrusted origins or granting owner streams to guests.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import {
  createDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import {
  BROWSER_SESSION_TTL_MS,
  createBrowserSession,
  createMachineSession,
} from "./auth/sessions";
import { startApiServer } from "./server";

type Probe =
  | { type: "pong" }
  | { code: number }
  | { httpStatus: number }
  | { error: string };

const API_TOKEN = "browser-cookie-ws-test-static-token";
let stateDir: string;
let adapter: ReturnType<typeof createDatabaseAdapter>;
let store: AuthStore;
let server: Awaited<ReturnType<typeof startApiServer>>;
let activeCookie: string;
let expiredCookie: string;
let revokedCookie: string;
let guestCookie: string;

function ping(headers: Record<string, string>): Promise<Probe> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers });
    let settled = false;
    const finish = (result: Probe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "timeout" }), 10_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ping" })));
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { type?: string };
      if (frame.type === "pong") finish({ type: "pong" });
    });
    ws.on("close", (code) => finish({ code }));
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      finish({ httpStatus: response.statusCode ?? 0 });
    });
    ws.on("error", (error) => finish({ error: error.message }));
  });
}

function cookieHeaders(sessionId: string): Record<string, string> {
  return {
    Origin: `http://127.0.0.1:${server.port}`,
    Cookie: `eliza_session=${encodeURIComponent(sessionId)}`,
  };
}

describe.sequential("owner browser session WebSocket admission", () => {
  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "eliza-cookie-ws-"));
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
    vi.stubEnv("ELIZA_API_BIND", "127.0.0.1");
    vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
    vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
    vi.stubEnv("ELIZA_API_TOKEN", API_TOKEN);
    vi.stubEnv("ELIZA_API_AUTH_TOKEN", "");
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
    vi.stubEnv("ELIZA_ALLOW_WS_QUERY_TOKEN", "0");
    const agentId = randomUUID();
    adapter = createDatabaseAdapter(
      { dataDir: path.join(stateDir, "db") },
      agentId,
    );
    await adapter.initialize();
    const db = adapter.db;
    if (!db) throw new Error("PGlite adapter did not expose its database");
    if (!adapter.runPluginMigrations) {
      throw new Error("PGlite adapter did not expose its migration runner");
    }
    await adapter.runPluginMigrations([sqlPlugin]);
    store = new AuthStore(db as DrizzleDatabase);
    const owner = await store.createIdentity({
      id: randomUUID(),
      kind: "owner",
      displayName: "Synthetic owner",
      createdAt: Date.now(),
    });
    const guest = await store.createIdentity({
      id: randomUUID(),
      kind: "machine",
      displayName: "Synthetic guest",
      createdAt: Date.now(),
    });
    const options = {
      identityId: owner.id,
      ip: null,
      userAgent: null,
      rememberDevice: false,
    };
    activeCookie = (await createBrowserSession(store, options)).session.id;
    expiredCookie = (
      await createBrowserSession(store, {
        ...options,
        now: Date.now() - 2 * BROWSER_SESSION_TTL_MS,
      })
    ).session.id;
    revokedCookie = (await createBrowserSession(store, options)).session.id;
    await store.revokeSession(revokedCookie, Date.now());
    guestCookie = (
      await createMachineSession(store, {
        identityId: guest.id,
        scopes: ["guest"],
        ip: null,
      })
    ).session.id;
    const runtime = new AgentRuntime({
      agentId,
      character: { name: "Cookie transport test" },
      adapter,
      disableBasicCapabilities: true,
    });
    server = await startApiServer({
      runtime,
      port: 0,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (adapter) await adapter.close();
    if (stateDir)
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
    vi.unstubAllEnvs();
  });

  it("returns a pong for the owner's browser cookie without a bearer", async () => {
    expect(await ping(cookieHeaders(activeCookie))).toEqual({ type: "pong" });
  });

  it("retains explicit bearer authentication without ambient cookies", async () => {
    expect(await ping({ Authorization: `Bearer ${API_TOKEN}` })).toEqual({
      type: "pong",
    });
  });

  it("rejects unknown, expired, revoked and non-owner cookie sessions", async () => {
    for (const cookie of [
      randomUUID(),
      expiredCookie,
      revokedCookie,
      guestCookie,
    ]) {
      expect(await ping(cookieHeaders(cookie))).toEqual({ code: 1008 });
    }
  });

  it("rejects malformed cookies and cookies without a browser origin", async () => {
    expect(
      await ping({ Origin: "http://localhost", Cookie: "eliza_session=%ZZ" }),
    ).toEqual({ code: 1008 });
    expect(await ping({ Cookie: `eliza_session=${activeCookie}` })).toEqual({
      code: 1008,
    });
  });

  it("keeps untrusted origins denied even when cloud CORS reflects them", async () => {
    expect(
      await ping({
        ...cookieHeaders(activeCookie),
        Origin: "https://untrusted.example",
      }),
    ).toEqual({ httpStatus: 403 });
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "1");
    try {
      expect(
        await ping({
          ...cookieHeaders(activeCookie),
          Origin: "https://untrusted.example",
        }),
      ).toEqual({ httpStatus: 401 });
    } finally {
      vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
    }
    vi.stubEnv("ELIZA_API_BIND", "0.0.0.0");
    vi.stubEnv("ELIZA_API_BIND_HOST", "0.0.0.0");
    try {
      expect(
        await ping({
          ...cookieHeaders(activeCookie),
          Origin: "https://untrusted.example",
        }),
      ).toEqual({ code: 1008 });
    } finally {
      vi.stubEnv("ELIZA_API_BIND", "127.0.0.1");
      vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
    }
  });

  it("denies the next connection immediately after owner session revocation", async () => {
    expect(await ping(cookieHeaders(activeCookie))).toEqual({ type: "pong" });
    await store.revokeSession(activeCookie, Date.now());
    expect(await ping(cookieHeaders(activeCookie))).toEqual({ code: 1008 });
  });
});
