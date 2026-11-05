/**
 * The app compat chain proxies /api/cloud/billing/* with the owner's Cloud
 * key. A paired machine session is USER, so it must not reach that proxy.
 * Real dispatcher, real SQLite sessions, stand-in Cloud via fetch.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { __resetRuntimeModeSnapshotCacheForTests } from "@elizaos/agent/api/runtime-mode/runtime-mode";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AuthRepository } from "../services/auth-repository";
import { authStoreForRuntime } from "../services/auth-store";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute } from "./server";

const OWNER_CLOUD_KEY = "eliza_owner_cloud_key_0123456789abcdef";
const CLOUD_BASE = "https://cloud.billing.test";
const OWNER_SESSION = "private-owner-session";
const GUEST_SESSION = "machine";

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEV",
  "ELIZA_DEV_CLOUD_API_KEY",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_RUNTIME_MODE",
  "ELIZA_STATE_DIR",
  "ELIZAOS_CLOUD_API_KEY",
] as const;

let saved: Record<string, string | undefined>;
let directory: string;
let adapter: SQLiteDatabaseAdapter;
let state: CompatRuntimeState;
const cloudCalls: Array<{ path: string; authorization: string }> = [];

beforeEach(async () => {
  __resetRuntimeModeSnapshotCacheForTests();
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  cloudCalls.length = 0;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-app-billing-"));
  fs.writeFileSync(
    path.join(directory, "eliza.json"),
    JSON.stringify({
      cloud: { apiKey: OWNER_CLOUD_KEY, baseUrl: CLOUD_BASE },
      logging: { level: "error" },
      meta: { firstRunComplete: true },
    }),
  );
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ELIZA_STATE_DIR = directory;
  process.env.ELIZA_DEV = "1";

  const agentId = randomUUID() as UUID;
  adapter = SQLiteDatabaseAdapter.create(
    path.join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
  const runtime = {
    agentId,
    adapter,
    getService: () => null,
  } as unknown as AgentRuntime;
  const store = authStoreForRuntime(runtime);
  if (!store) throw new Error("Missing test auth store");
  const clock = Date.now();
  await seedSession(store, "owner", "owner", OWNER_SESSION, clock);
  await seedSession(store, "machine", "machine", GUEST_SESSION, clock);
  state = {
    current: runtime,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    if (url.origin !== CLOUD_BASE) return realFetch(input, init);
    cloudCalls.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    });
    return Response.json({ success: true, organization: {} });
  });
});

afterEach(async () => {
  await adapter?.close();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  __resetRuntimeModeSnapshotCacheForTests();
});

async function seedSession(
  store: AuthRepository,
  id: string,
  kind: "owner" | "machine",
  sessionId: string,
  clock: number,
): Promise<void> {
  await store.createIdentity({
    id,
    kind,
    displayName: id,
    createdAt: clock,
  });
  await store.createSession({
    id: sessionId,
    identityId: id,
    kind: "machine",
    createdAt: clock,
    lastSeenAt: clock,
    expiresAt: clock + 3_600_000,
    rememberDevice: false,
    csrfSecret: "private-csrf-key",
    ip: null,
    userAgent: null,
    scopes: [],
  });
}

function remoteReq(
  method: string,
  pathname: string,
  token: string,
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = {
    host: "example.test:2138",
    authorization: `Bearer ${token}`,
  };
  if (method === "POST") {
    req.push(JSON.stringify({ code: "GUESTCODE" }));
    req.push(null);
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

function captureRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  const socket = new Socket();
  res.assignSocket(socket);
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    socket.destroy();
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? (JSON.parse(body) as unknown) : null),
  };
}

async function dispatch(method: string, pathname: string, token: string) {
  const captured = captureRes();
  const handled = await handleElizaCompatRoute(
    remoteReq(method, pathname, token),
    captured.res,
    state,
  );
  return { handled, status: captured.status(), body: captured.json() };
}

it("refuses a paired USER session the owner's Cloud billing proxy", async () => {
  const paymentMethods = await dispatch(
    "GET",
    "/api/cloud/billing/payment-methods",
    GUEST_SESSION,
  );
  const affiliateLink = await dispatch(
    "POST",
    "/api/cloud/billing/affiliates/link",
    GUEST_SESSION,
  );

  expect(paymentMethods.handled).toBe(true);
  expect(cloudCalls).toEqual([]);
  expect(paymentMethods.status).toBe(403);
  expect(affiliateLink.handled).toBe(true);
  expect(affiliateLink.status).toBe(403);

  const ownerLink = await dispatch(
    "POST",
    "/api/cloud/billing/affiliates/link",
    OWNER_SESSION,
  );
  expect(ownerLink.handled).toBe(true);
  expect(ownerLink.status).toBe(200);
  expect(cloudCalls).toEqual([
    {
      path: "/api/v1/affiliates/link",
      authorization: `Bearer ${OWNER_CLOUD_KEY}`,
    },
  ]);
});
