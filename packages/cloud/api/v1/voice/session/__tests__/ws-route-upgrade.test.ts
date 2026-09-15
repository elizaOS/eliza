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
import * as realCore from "@elizaos/core";
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
let durableStoreValue: unknown = { kind: "durable" };
let binaryTypeWritable = true;

mock.module("@elizaos/core", () => ({
  ...realCore,
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

// Each built client gets a sequence id and `get` records which INSTANCE served
// the read (always answering "1" = revoked). This mock is process-wide, so
// jwt.ts's module-level fallback client comes from the same factory — only the
// instance id distinguishes the route's request-scoped client (built during
// the upgrade request) from any earlier/lazier fallback, which is exactly the
// #16663 forwarding contract.
let redisClientSeq = 0;
const redisGetCalls: Array<{ client: number; key: string }> = [];
const redisFactoryStub = () => ({
  ...realRedisFactoryExports,
  buildRedisClient: () => {
    const id = ++redisClientSeq;
    return {
      eval: () => undefined,
      get: async (key: string) => {
        redisGetCalls.push({ client: id, key });
        return "1";
      },
    };
  },
});
mock.module("@/lib/cache/redis-factory", redisFactoryStub);
mock.module(`${sharedRoot}/lib/cache/redis-factory.ts`, redisFactoryStub);

// NOTE: we do NOT mock `../lib/session`. Mocking VoiceSession would clobber it
// for ws-lifecycle.test.ts (which constructs the REAL VoiceSession and runs
// earlier in the shared, non-isolated coverage lane). We therefore also do NOT
// invoke the route's `buildSession` closure below because constructing a real
// VoiceSession requires live providers that are outside this route contract.
const wsRoute = (await import("../ws/route")).default;

const baseEnv = {
  VOICE_REALTIME_WS_ENABLED: "true",
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
  redisGetCalls.length = 0;
  registrySize = 0;
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

function buildCapturedSession(): { config: Record<string, unknown> } {
  const deps = attachCalls[0].deps as {
    buildSession: (args: Record<string, unknown>) => unknown;
  };
  return deps.buildSession({
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
  }) as { config: Record<string, unknown> };
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

  test("prefers the durable usage store when the factory provides one", async () => {
    durableStoreValue = { kind: "durable" };
    const res = await upgrade();
    expect(res.status).toBe(101);
    expect(buildCapturedSession().config.usageStore).toBe(durableStoreValue);
  });

  test("uses the in-memory store only for an explicit mock runtime", async () => {
    durableStoreValue = null;
    const res = await upgrade({ MOCK_REDIS: "1" });
    expect(res.status).toBe(101);
    expect(buildCapturedSession().config.usageStore).not.toBeNull();
  });

  test("denies production provider startup when atomic metering is unavailable", async () => {
    durableStoreValue = null;
    const res = await upgrade();
    expect(res.status).toBe(503);
    expect(attachCalls).toHaveLength(0);
  });

  test("still upgrades when the live registry is under the ceiling; admitSession reflects it", async () => {
    registrySize = 0;
    const res = await upgrade();
    expect(res.status).toBe(101);
    expect(attachCalls.length).toBe(1);
  });

  test("the revocation poll consults the route's request-scoped Redis client (#16663)", async () => {
    const beforeUpgrade = redisClientSeq;
    const res = await upgrade();
    const afterUpgrade = redisClientSeq;
    expect(res.status).toBe(101);
    expect(afterUpgrade).toBeGreaterThan(beforeUpgrade);
    const deps = attachCalls[0].deps as unknown as {
      buildSession: (args: {
        claims: Record<string, string>;
        jti: string;
        tokenExpSeconds: number;
        downlink: Record<string, unknown>;
      }) => { config: { isRevoked?: (jti: string) => Promise<boolean> } };
    };
    const session = deps.buildSession({
      claims: {
        sessionId: "sess-revocation-wire",
        organizationId: "org-1",
        userId: "user-1",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      jti: "jti-16663-forwarding",
      tokenExpSeconds: Math.floor(Date.now() / 1000) + 60,
      downlink: {
        sendControl: () => undefined,
        sendAudio: () => undefined,
        close: () => undefined,
      },
    });
    await expect(
      session.config.isRevoked?.("jti-16663-forwarding"),
    ).resolves.toBe(true);
    // The read must land on the client built DURING the upgrade request (the
    // route's request-scoped one). An unforwarded check would fall back to
    // jwt.ts's module client — an instance cached earlier or built lazily
    // inside the isRevoked call, in either case outside the upgrade window.
    const read = redisGetCalls.find((r) =>
      r.key.includes("jti-16663-forwarding"),
    );
    expect(read).toBeDefined();
    expect(read?.client).toBeGreaterThan(beforeUpgrade);
    expect(read?.client).toBeLessThanOrEqual(afterUpgrade);
  });

  test("buildSession wires a prewarm-capable scoped Eliza fetch", async () => {
    const res = await upgrade();
    expect(res.status).toBe(101);
    // Construct a REAL VoiceSession through the route's closure. No providers
    // are dialed at construction time (start() is never called here).
    const session = buildCapturedSession();
    expect(typeof session.config.fetchImpl).toBe("function");
    expect(typeof session.config.prewarmElizaContext).toBe("function");
    expect(session.config.prewarmElizaContext).toBe(
      (session.config.fetchImpl as { prewarm?: unknown }).prewarm,
    );
  });

  test("leaves Fish realtime TTS off by default", async () => {
    const res = await upgrade();
    expect(res.status).toBe(101);
    const session = buildCapturedSession();
    expect(session.config.fishAudioEnabled).toBe(false);
    expect(session.config.fishAudioApiKey).toBeUndefined();
  });

  test("injects Fish realtime TTS config when the Fish flag is enabled", async () => {
    const res = await upgrade({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
      FISH_AUDIO_API_KEY: "fish-key",
      FISH_AUDIO_REFERENCE_ID: "fish-voice",
      FISH_AUDIO_MODEL: "s2.1-pro-free",
      FISH_AUDIO_SAMPLE_RATE: "16000",
      FISH_AUDIO_FIRST_AUDIO_TIMEOUT_MS: "25",
    });
    expect(res.status).toBe(101);
    const session = buildCapturedSession();
    expect(session.config.fishAudioEnabled).toBe(true);
    expect(session.config.fishAudioApiKey).toBe("fish-key");
    expect(session.config.fishAudioReferenceId).toBe("fish-voice");
    expect(session.config.fishAudioModel).toBe("s2.1-pro-free");
    expect(session.config.fishAudioSampleRate).toBe(16000);
    expect(session.config.fishAudioFirstAudioTimeoutMs).toBe(25);
    expect(typeof session.config.fishAudioWebSocketFactory).toBe("function");
  });

  test("refuses Fish egress when data-governance approval is absent", async () => {
    const res = await upgrade({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "fish-key",
      FISH_AUDIO_REFERENCE_ID: "fish-voice",
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({
      error: "Fish Audio is unavailable pending data-governance approval",
      code: "fish_audio_data_governance_unapproved",
    });
    expect(attachCalls).toHaveLength(0);
  });

  test("refuses the upgrade when Fish config would violate the voice PCM contract", async () => {
    const res = await upgrade({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
      FISH_AUDIO_API_KEY: "fish-key",
      FISH_AUDIO_REFERENCE_ID: "fish-voice",
      FISH_AUDIO_SAMPLE_RATE: "24000",
    });

    expect(res.status).toBe(503);
    expect(attachCalls).toHaveLength(0);
  });

  test("refuses the upgrade when the configured Fish model is unsupported", async () => {
    const res = await upgrade({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_DATA_GOVERNANCE_APPROVED: "true",
      FISH_AUDIO_API_KEY: "fish-key",
      FISH_AUDIO_REFERENCE_ID: "fish-voice",
      FISH_AUDIO_MODEL: "s2.1",
    });

    expect(res.status).toBe(503);
    expect(attachCalls).toHaveLength(0);
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
