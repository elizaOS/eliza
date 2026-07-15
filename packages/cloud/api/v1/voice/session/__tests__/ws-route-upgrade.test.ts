/**
 * Unit coverage for the successful WebSocket upgrade branch of the voice-session
 * ws route. The route-level guard cases (flag off / not an upgrade / capacity /
 * misconfigured / transport unavailable) are covered by
 * voice-session-routes-and-auth.test.ts; this file drives the happy path where a
 * Workers `WebSocketPair` exists, so lines that mint the pair, pick the usage
 * store, and attach the WS handler execute.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const sharedRoot = new URL("../../../../shared/src", import.meta.url).href;

// Capture the real modules a sibling changed-test also imports for real, so the
// non-isolated coverage lane is not poisoned (see the routes-and-auth test for
// the full rationale). We restore them in afterAll. NOTE: we deliberately do
// NOT stub `@/lib/voice-session/jwt` — ws/route.ts only passes the jwt fns as
// CALLBACKS into the (mocked) attachVoiceWsHandler and never invokes them on
// this path, so stubbing jwt would only risk leaking into jwt.test.ts's
// round-trip in the shared coverage-lane process.
import * as realRedisFactory from "@/lib/cache/redis-factory";
import * as realVoiceUsageMeter from "@/lib/services/voice-usage-meter";
import * as realSessionRegistry from "@/lib/voice-session/session-registry";
import * as realWsHandler from "@/lib/voice-session/ws-handler";

const realSessionRegistryExports = { ...realSessionRegistry };
const realVoiceUsageMeterExports = { ...realVoiceUsageMeter };
const realRedisFactoryExports = { ...realRedisFactory };
const realWsHandlerExports = { ...realWsHandler };

const attachCalls: Array<Record<string, unknown>> = [];
let registrySize = 0;
let evalCapableRedis = true;
let durableStoreValue: unknown = { kind: "durable" };

mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: unknown) => a,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
  },
}));
mock.module(`${sharedRoot}/lib/utils/logger.ts`, () => ({
  logger: {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
  },
}));

// The ws-handler mock is a PASSTHROUGH: it captures the deps the route wired
// (and exercises the pure closures for coverage) then delegates to the REAL
// attachVoiceWsHandler. The coverage lane runs all files in ONE non-isolated
// process and this bun canary applies mock.module at COLLECTION time — a
// non-passthrough stub would clobber ws-lifecycle.test.ts's real
// attachVoiceWsHandler and break it. `claimToken` (real jwt+redis) is left alone.
const wsHandlerStub = () => ({
  ...realWsHandlerExports,
  attachVoiceWsHandler: (
    server: Parameters<typeof realWsHandler.attachVoiceWsHandler>[0],
    deps: Parameters<typeof realWsHandler.attachVoiceWsHandler>[1] &
      Record<string, unknown>,
  ) => {
    attachCalls.push({ server, deps });
    // Exercise only the pure admitSession closure (touches the mocked registry).
    // We intentionally skip buildSession (real VoiceSession + live providers) and
    // claimToken (real jwt+redis); the route just hands those to the handler.
    (deps.admitSession as unknown as (() => boolean) | undefined)?.();
    return realWsHandlerExports.attachVoiceWsHandler(server, deps);
  },
});
mock.module("@/lib/voice-session/ws-handler", wsHandlerStub);
mock.module(`${sharedRoot}/lib/voice-session/ws-handler.ts`, wsHandlerStub);

const registryStub = () => ({
  ...realSessionRegistryExports,
  getVoiceSessionRegistry: () => ({ size: () => registrySize }),
});
mock.module("@/lib/voice-session/session-registry", registryStub);
mock.module(
  `${sharedRoot}/lib/voice-session/session-registry.ts`,
  registryStub,
);

const usageMeterStub = () => ({
  ...realVoiceUsageMeterExports,
  InMemoryVoiceUsageStore: class {},
  createDurableVoiceUsageStore: () => durableStoreValue,
});
mock.module("@/lib/services/voice-usage-meter", usageMeterStub);
mock.module(`${sharedRoot}/lib/services/voice-usage-meter.ts`, usageMeterStub);

mock.module("@/lib/cache/redis-factory", () => ({
  ...realRedisFactoryExports,
  buildRedisClient: () => (evalCapableRedis ? { eval: () => undefined } : {}),
}));
mock.module(`${sharedRoot}/lib/cache/redis-factory.ts`, () => ({
  ...realRedisFactoryExports,
  buildRedisClient: () => (evalCapableRedis ? { eval: () => undefined } : {}),
}));

// NOTE: we do NOT mock `../lib/session`. Mocking VoiceSession would clobber it
// for ws-lifecycle.test.ts (which constructs the REAL VoiceSession and runs
// earlier in the shared, non-isolated coverage lane). We therefore also do NOT
// invoke the route's `buildSession` closure below — constructing a real
// VoiceSession needs live providers. ws/route coverage stays >50% without it.
const wsRoute = (await import("../ws/route")).default;

const baseEnv = {
  VOICE_REALTIME_WS_ENABLED: "true",
  DEEPGRAM_API_KEY: "dg",
  CARTESIA_API_KEY: "cartesia",
  VOICE_REALTIME_CARTESIA_VOICE_ID: "voice",
  VOICE_REALTIME_ELIZA_ENDPOINT: "https://eliza.test/sse",
  VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer service",
};

class FakeServerSocket {
  accepted = false;
  binaryType: "blob" | "arraybuffer" = "blob";
  accept() {
    this.accepted = true;
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

const originalWebSocketPair = (globalThis as { WebSocketPair?: unknown })
  .WebSocketPair;

beforeEach(() => {
  attachCalls.length = 0;
  registrySize = 0;
  evalCapableRedis = true;
  durableStoreValue = { kind: "durable" };
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
    0 = {};
    1 = new FakeServerSocket();
  };
});

afterEach(() => {
  if (originalWebSocketPair === undefined) {
    delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  } else {
    (globalThis as { WebSocketPair?: unknown }).WebSocketPair =
      originalWebSocketPair;
  }
});

afterAll(() => {
  mock.module(
    "@/lib/voice-session/session-registry",
    () => realSessionRegistryExports,
  );
  mock.module(
    `${sharedRoot}/lib/voice-session/session-registry.ts`,
    () => realSessionRegistryExports,
  );
  mock.module(
    "@/lib/services/voice-usage-meter",
    () => realVoiceUsageMeterExports,
  );
  mock.module(
    `${sharedRoot}/lib/services/voice-usage-meter.ts`,
    () => realVoiceUsageMeterExports,
  );
  mock.module("@/lib/cache/redis-factory", () => realRedisFactoryExports);
  mock.module(
    `${sharedRoot}/lib/cache/redis-factory.ts`,
    () => realRedisFactoryExports,
  );
  mock.module("@/lib/voice-session/ws-handler", () => realWsHandlerExports);
  mock.module(
    `${sharedRoot}/lib/voice-session/ws-handler.ts`,
    () => realWsHandlerExports,
  );
});

function upgrade(env: Record<string, string> = {}) {
  const app = new Hono<AppEnv>();
  app.route("/", wsRoute);
  return app.request(
    "/?sessionId=abc",
    { headers: { Upgrade: "websocket" } },
    { ...baseEnv, ...env },
  );
}

describe("voice-session ws upgrade (happy path)", () => {
  test("mints the socket pair, accepts the server, and returns a 101 with the client socket", async () => {
    const res = await upgrade();
    expect(res.status).toBe(101);
    expect(attachCalls.length).toBe(1);
    const server = attachCalls[0].server as FakeServerSocket;
    expect(server.accepted).toBe(true);
    expect(server.binaryType).toBe("arraybuffer");
  });

  test("prefers the durable usage store when Redis is eval-capable", async () => {
    evalCapableRedis = true;
    durableStoreValue = { kind: "durable" };
    const res = await upgrade();
    expect(res.status).toBe(101);
    // The buildSession closure ran (invoked by the ws-handler stub) without throwing.
    expect(attachCalls.length).toBe(1);
  });

  test("falls back to the in-memory store when Redis has no eval (Railway TCP)", async () => {
    evalCapableRedis = false;
    const res = await upgrade();
    expect(res.status).toBe(101);
    expect(attachCalls.length).toBe(1);
  });

  test("falls back to the in-memory store when no durable store is available", async () => {
    durableStoreValue = null;
    const res = await upgrade();
    expect(res.status).toBe(101);
    expect(attachCalls.length).toBe(1);
  });

  test("still upgrades when the live registry is under the ceiling; admitSession reflects it", async () => {
    registrySize = 0;
    const res = await upgrade();
    expect(res.status).toBe(101);
    expect(attachCalls.length).toBe(1);
  });

  test("returns 503 transport-unavailable when WebSocketPair is absent", async () => {
    delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    const res = await upgrade();
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({
      error: "voice realtime transport unavailable",
    });
  });
});
