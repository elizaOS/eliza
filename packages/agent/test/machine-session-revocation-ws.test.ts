/** Real SQLite auth, owner-revoke HTTP, and agent WebSockets prove targeted revocation and bounded external-store invalidation. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createMachineSession,
  revokeAllSessionsForIdentity,
  subscribeSessionRevocations,
} from "../../app/src/api/auth/sessions.ts";
import { resolveSessionTokenRole } from "../../app/src/api/auth.ts";
import { handleAuthSessionRoutes } from "../../app/src/api/auth-session-routes.ts";
import type { AuthRepository } from "../../app/src/services/auth-repository.ts";
import { authStoreForRuntime } from "../../app/src/services/auth-store.ts";
import { startApiServer } from "../src/api/server.ts";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";

let directory: string;
let runtime: AgentRuntime;
let server: Awaited<ReturnType<typeof startApiServer>>;
let store: AuthRepository;
let ownerToken: string;
const ownerId = randomUUID();
const oldBridge = getAgentHostBridge();
const sockets = new Set<WebSocket>();
async function mint(identityId = ownerId) {
  return (
    await createMachineSession(store, {
      identityId,
      label: "acceptance fixture",
      scopes: [],
    })
  ).session.id;
}
function connect(token: string, inBand = false): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: {
        Origin: `http://127.0.0.1:${server.port}`,
        ...(!inBand ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    sockets.add(ws);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Socket authentication timed out"));
    }, 10_000);
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Socket rejected"));
    });
    ws.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.type === "status") {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    if (inBand)
      ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token })));
  });
}
function closed(ws: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Revoked socket remained connected")),
      8_000,
    );
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    });
  });
}
function ping(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Surviving socket lost authorization")),
      3_000,
    );
    const onMessage = (bytes: WebSocket.RawData) => {
      if (JSON.parse(String(bytes)).type === "pong") {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "ping" }));
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "session-revocation-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_API_TOKEN", randomUUID());
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  runtime = new AgentRuntime({
    character: { name: "Session revocation", bio: [] },
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "auth.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.initialize({ skipMigrations: true });
  const selected = authStoreForRuntime(runtime);
  if (!selected) throw new Error("Missing auth repository");
  store = selected;
  await store.createIdentity({
    id: ownerId,
    kind: "owner",
    displayName: "Owner",
    createdAt: Date.now(),
  });
  ownerToken = await mint();
  setAgentHostBridge({
    ...oldBridge,
    subscribeSessionRevocations,
    resolveSessionTokenAuthorization: async (token) =>
      (await resolveSessionTokenRole(token, { store })) ?? {
        ok: false,
        role: "NONE",
      },
  });
  server = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
    requestMiddleware: async (req, res, next) => {
      if (
        !(await handleAuthSessionRoutes(req, res, {
          current: runtime,
          pendingAgentName: "",
          pendingRestartReasons: [],
        }))
      )
        await next();
    },
  });
}, 60_000);
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  if (server) await server.close();
  if (runtime) await runtime.stop();
  setAgentHostBridge(oldBridge);
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 60_000);

it.each([false, true])(
  "owner revoke closes the existing session immediately (in-band=%s) and preserves another session",
  async (inBand) => {
    const target = await mint();
    const other = await mint();
    const ws = await connect(target, inBand);
    const survivor = await connect(other);
    const closure = closed(ws);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/auth/sessions/${target}/revoke`,
      { method: "POST", headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(response.status).toBe(200);
    expect(await closure).toEqual({ code: 1008, reason: "session_revoked" });
    const rejected = await fetch(
      `http://127.0.0.1:${server.port}/api/auth/me`,
      { headers: { Authorization: `Bearer ${target}` } },
    );
    expect(rejected.status).toBe(401);
    await ping(survivor);
    survivor.close();
  },
);

it("detects a revocation written outside the process notification path on the status cadence", async () => {
  const token = await mint();
  const ws = await connect(token);
  const closure = closed(ws);
  await store.revokeSession(token);
  expect(await closure).toEqual({ code: 1008, reason: "session_invalid" });
}, 12_000);

it("denies machine identities the owner event stream", async () => {
  const guest = randomUUID();
  await store.createIdentity({
    id: guest,
    kind: "machine",
    displayName: "Guest",
    createdAt: Date.now(),
  });
  await expect(connect(await mint(guest))).rejects.toThrow();
});

it("bulk revocation preserves the excepted owner device", async () => {
  const dropped = await mint();
  const retained = await mint();
  const revokedSocket = await connect(dropped);
  const retainedSocket = await connect(retained);
  const closure = closed(revokedSocket);
  await revokeAllSessionsForIdentity({
    store,
    identityId: ownerId,
    exceptSessionId: retained,
    reason: "acceptance",
    ip: null,
    userAgent: null,
  });
  expect(await closure).toEqual({ code: 1008, reason: "session_invalid" });
  await ping(retainedSocket);
  retainedSocket.close();
});

it("commits a revoke even when one live notification subscriber fails", async () => {
  const target = await mint();
  const actor = await mint();
  const unsubscribe = subscribeSessionRevocations(() => {
    throw new Error("disconnected socket observer");
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/auth/sessions/${target}/revoke`,
      { method: "POST", headers: { Authorization: `Bearer ${actor}` } },
    );
    expect(response.status).toBe(200);
    const rejected = await fetch(
      `http://127.0.0.1:${server.port}/api/auth/me`,
      { headers: { Authorization: `Bearer ${target}` } },
    );
    expect(rejected.status).toBe(401);
  } finally {
    unsubscribe();
  }
});
