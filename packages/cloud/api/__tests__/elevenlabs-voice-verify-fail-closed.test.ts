/**
 * Guard tests for #12787 (cloud API fallback-slop sweep, elevenlabs slice).
 *
 * `GET /api/elevenlabs/voices/verify/[id]` used to catch EVERY upstream
 * ElevenLabs error inside the handler and return
 * `200 { success: true, status: { isReady: false, message: "Voice not found
 * in ElevenLabs or still processing" } }`. That collapsed two distinct
 * outcomes into one fabricated "still processing" verdict:
 *   - a voice that genuinely isn't materialized upstream yet (a real 404 for a
 *     fresh professional voice), which SHOULD degrade to a not-ready state, and
 *   - ElevenLabs being broken (transport failure / 401 bad key / 429 / 5xx),
 *     which is a service fault the caller must see so it stops polling a dead
 *     service forever believing the voice just isn't done baking.
 *
 * The TTS readiness probe additionally only caught THROWN fetches, so a non-2xx
 * HTTP response (401/429/5xx from ElevenLabs) counted as `canGenerateTTS: true`
 * — a fabricated-ready voice in the other direction.
 *
 * These tests drive the REAL Hono route handler; only the deep service
 * boundaries (auth, voice-cloning DB lookup, ElevenLabs SDK client) and
 * `global.fetch` (the TTS probe) are stubbed.
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
import {
  ElevenLabsError,
  ElevenLabsTimeoutError,
} from "@elevenlabs/elevenlabs-js";
import * as authActual from "@/lib/auth";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.ELEVENLABS_API_KEY ||= "test-elevenlabs-key";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";

// Per-test knobs.
let dbVoice: {
  id: string;
  name: string;
  elevenlabsVoiceId: string;
  cloneType: "instant" | "professional";
} | null = null;
let getVoiceByIdImpl: () => Promise<unknown> = async () => ({
  category: "cloned",
  samples: [{}, {}],
  fineTuning: { state: { model_a: "fine_tuned" } },
});

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: { id: "api-key-id" },
  }),
}));

mock.module("@/lib/services/voice-cloning", () => ({
  voiceCloningService: {
    getVoiceById: async () => dbVoice,
  },
}));

mock.module("@/lib/services/elevenlabs", () => ({
  getElevenLabsService: () => ({
    getVoiceById: () => getVoiceByIdImpl(),
  }),
}));

// Import AFTER the mocks are registered so the route binds the stubs.
const { default: app } = await import("../elevenlabs/voices/verify/[id]/route");

const ENV = {} as unknown as Record<string, unknown>;
const EXEC_CTX = {
  waitUntil: (_p: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function verify() {
  return app.request(
    `/`,
    {
      method: "GET",
      headers: { authorization: "Bearer test-key" },
    },
    ENV,
    EXEC_CTX,
  );
}

const realFetch = globalThis.fetch;

// Bun's `mock()` lacks the `preconnect` member of the DOM `fetch` type; the TTS
// probe only calls `fetch(url, init)`, so a thin cast keeps the assignment
// type-safe without pulling in a full fetch polyfill.
function stubFetch(impl: () => Promise<Response>): void {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}

describe("#12787 elevenlabs voices/verify — fail closed on upstream failure", () => {
  beforeEach(() => {
    dbVoice = {
      id: "voice-1",
      name: "My Voice",
      elevenlabsVoiceId: "el-voice-1",
      cloneType: "instant",
    };
    getVoiceByIdImpl = async () => ({
      category: "cloned",
      samples: [{}, {}],
      fineTuning: {},
    });
    // Default: TTS probe succeeds.
    stubFetch(async () => new Response(null, { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    mock.module("@/lib/auth", () => authActual);
  });

  test("ElevenLabs 5xx surfaces a structured failure, never a fabricated 'still processing' success", async () => {
    getVoiceByIdImpl = async () => {
      throw new ElevenLabsError({
        message: "upstream boom",
        statusCode: 503,
      });
    };

    const res = await verify();

    // The old handler returned 200 { success: true } here. Upstream 5xx now maps
    // to a retryable 503 (the provider faulted, not our worker).
    expect(res.status).toBe(503);
    const json = (await res.json()) as { success?: boolean; status?: unknown };
    expect(json.success).not.toBe(true);
    // No fabricated readiness verdict handed back.
    expect(json.status).toBeUndefined();
  });

  test("ElevenLabs 429 rate limit keeps the canonical rate_limit_exceeded code (not internal_error)", async () => {
    getVoiceByIdImpl = async () => {
      throw new ElevenLabsError({ message: "slow down", statusCode: 429 });
    };

    const res = await verify();

    // 4xx client errors pass through verbatim so callers can branch on the code.
    expect(res.status).toBe(429);
    const json = (await res.json()) as { success?: boolean; code?: string };
    expect(json.success).not.toBe(true);
    expect(json.code).toBe("rate_limit_exceeded");
  });

  test("ElevenLabs transport timeout maps to a retryable 503, not a generic 500", async () => {
    getVoiceByIdImpl = async () => {
      throw new ElevenLabsTimeoutError(
        "Timeout exceeded when calling GET /voices.",
      );
    };

    const res = await verify();

    // A provider timeout means the upstream is unavailable, not our worker.
    expect(res.status).toBe(503);
    const json = (await res.json()) as { success?: boolean; status?: unknown };
    expect(json.success).not.toBe(true);
    expect(json.status).toBeUndefined();
  });

  test("ElevenLabs 401 (bad key) surfaces as an auth failure, not a healthy 'still processing' body", async () => {
    getVoiceByIdImpl = async () => {
      throw new ElevenLabsError({
        message: "invalid api key",
        statusCode: 401,
      });
    };

    const res = await verify();

    expect(res.status).toBe(401);
    const json = (await res.json()) as { success?: boolean };
    expect(json.success).not.toBe(true);
  });

  test("ElevenLabs 404 (voice not materialized yet) degrades to a distinct not-ready verdict", async () => {
    dbVoice = {
      id: "voice-1",
      name: "My Voice",
      elevenlabsVoiceId: "el-voice-1",
      cloneType: "professional",
    };
    getVoiceByIdImpl = async () => {
      throw new ElevenLabsError({ message: "not found", statusCode: 404 });
    };

    const res = await verify();

    // A genuinely-absent upstream voice is an EXPECTED not-ready state, not a 5xx.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      status: { isReady: boolean; canGenerateTTS: boolean; message: string };
    };
    expect(json.success).toBe(true);
    expect(json.status.isReady).toBe(false);
    expect(json.status.canGenerateTTS).toBe(false);
    expect(json.status.message).toContain("still being processed");
  });

  test("TTS probe non-2xx counts as canGenerateTTS:false (not a fabricated ready voice)", async () => {
    // getVoiceById succeeds; the TTS smoke call returns 429.
    stubFetch(async () => new Response(null, { status: 429 }));

    const res = await verify();

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: { isReady: boolean; canGenerateTTS: boolean };
    };
    // Instant voice is "ready" per fine-tune status but the probe failed, so
    // it must not report generatable. Old code only caught THROWS, so a 429
    // HTTP response used to set canGenerateTTS=true.
    expect(json.status.canGenerateTTS).toBe(false);
    expect(json.status.isReady).toBe(false);
  });

  test("TTS probe thrown fetch degrades to canGenerateTTS:false observably", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });

    const res = await verify();

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: { canGenerateTTS: boolean };
    };
    expect(json.status.canGenerateTTS).toBe(false);
  });

  test("happy path: upstream ok + TTS probe 2xx => ready", async () => {
    const res = await verify();

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      status: { isReady: boolean; canGenerateTTS: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.status.canGenerateTTS).toBe(true);
    expect(json.status.isReady).toBe(true);
  });

  test("voice missing from DB is a 404, unaffected by the fix", async () => {
    dbVoice = null;

    const res = await verify();

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: string; success?: boolean };
    expect(json.success).not.toBe(true);
    expect(json.error).toBe("Voice not found");
  });
});
