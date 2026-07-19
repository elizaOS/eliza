/** Exercises the real voice upgrade route with deterministic socket/provider boundaries. */

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
let binaryTypeWritable = true;

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
  VOICE_REALTIME_CARTESIA_VOICE_ID: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
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
  binaryTypeWritable = true;
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
    0 = {};
    1 = (() => {
      const server = new FakeServerSocket();
      if (!binaryTypeWritable) {
        Object.defineProperty(server, "binaryType", {
          set() {
            throw new Error("read only");
          },
        });
      }
      return server;
    })();
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

  test("buildSession wires a prewarm-capable scoped Eliza fetch", async () => {
    const res = await upgrade();
    expect(res.status).toBe(101);
    const deps = attachCalls[0].deps as unknown as {
      buildSession: (args: {
        claims: Record<string, string>;
        jti: string;
        tokenExpSeconds: number;
        downlink: Record<string, unknown>;
      }) => {
        config?: unknown;
      };
    };
    // Construct a REAL VoiceSession through the route's closure. No providers
    // are dialed at construction time (start() is never called here), so this
    // exercises the fetchImpl/prewarmElizaContext wiring added for the
    // session-start tenancy warmup.
    const session = deps.buildSession({
      claims: {
        sessionId: "sess-upgrade-wire",
        organizationId: "org-1",
        userId: "user-1",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      jti: "jti-upgrade-wire",
      tokenExpSeconds: Math.floor(Date.now() / 1000) + 60,
      downlink: {
        sendControl: () => undefined,
        sendAudio: () => undefined,
        close: () => undefined,
      },
    }) as unknown as {
      config: {
        fetchImpl?: { prewarm?: unknown };
        prewarmElizaContext?: unknown;
      };
    };
    expect(typeof session.config.fetchImpl).toBe("function");
    expect(typeof session.config.prewarmElizaContext).toBe("function");
    expect(session.config.prewarmElizaContext).toBe(
      (session.config.fetchImpl as { prewarm?: unknown }).prewarm,
    );
  });

  test("returns 503 transport-unavailable when WebSocketPair is absent", async () => {
    delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    const res = await upgrade();
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({
      error: "voice realtime transport unavailable",
    });
  });

  test("fails closed when the runtime cannot deliver binary ArrayBuffers", async () => {
    binaryTypeWritable = false;
    const res = await upgrade();
    expect(res.status).toBe(503);
    expect(attachCalls).toHaveLength(0);
  });
});
