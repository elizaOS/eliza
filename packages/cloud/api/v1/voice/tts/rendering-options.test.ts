/** Exercise the actual HTTP route with controlled auth, billing and provider ports. */
import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { corsMiddleware } from "../../../../shared/src/lib/cors/cloud-api-hono-cors";
import {
  hasTtsSynthesisOptions,
  TtsSynthesisOptions,
} from "../../../../shared/src/lib/services/tts-synthesis-options";

const events: string[] = [];
const syntheses: Record<string, unknown>[] = [];
const safetyTexts: string[] = [];
const prices: Record<string, unknown>[] = [];
const background: Promise<unknown>[] = [];
let signedIn = true;
let denyFunds = false;
let failProvider = false;
let safetyDenied = false;
let cacheHit = true;
const bytes = new Uint8Array([73, 68, 51, 1]);
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
class InsufficientCreditsError extends Error {
  required = 0.1;
}
mock.module("@elizaos/cloud-shared/lib/api/cloud-worker-errors", () => ({
  ApiError,
}));
mock.module("@elizaos/cloud-shared/lib/pricing-constants", () => ({
  CUSTOM_VOICE_TTS_MARKUP: 1.2,
}));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({
  InsufficientCreditsError,
}));
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  calculateTTSCostFromCatalog: async (options: Record<string, unknown>) => {
    events.push("price");
    prices.push(options);
    return { totalCost: 0.1, baseTotalCost: 0.08, platformMarkup: 0.02 };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/ai-billing", () => ({
  billFlatUsage: async () => {
    events.push("bill");
    return { totalCost: 0.1, baseTotalCost: 0.08, platformMarkup: 0.02 };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/content-safety", () => ({
  contentSafetyService: {
    assertSafeForPublicUse: async (input: { text: string }) => {
      events.push("safety");
      safetyTexts.push(input.text);
      if (safetyDenied) throw new ApiError("Disallowed context", 400);
    },
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/deferred-credential-admission-guard",
  () => ({
    deferredCredentialAdmissionGuard: () => ({
      credentialForAdmission: () => ({}),
      [Symbol.asyncDispose]: async () => {
        events.push("credential-dispose");
      },
    }),
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/elevenlabs", () => ({
  TtsSynthesisOptions,
  hasTtsSynthesisOptions,
  getElevenLabsService: () => ({
    textToSpeechWithTimestamps: async (
      options: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      events.push("timed-synthesize");
      syntheses.push(options);
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Response(
        '{"type":"audio","audioBase64":"AQID"}\n{"type":"done"}\n',
      ).body!;
    },
    textToSpeech: async (options: Record<string, unknown>) => {
      events.push("synthesize");
      syntheses.push(options);
      if (failProvider) throw new Error("controlled upstream failure");
      return new Response(bytes).body!;
    },
  }),
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/tts-custom-voice-usage",
  () => ({
    recordCustomVoiceUsage: async () => ({
      userVoiceId: null,
      voiceName: null,
    }),
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/usage", () => ({
  usageService: {
    create: async () => {
      events.push("usage");
    },
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/tts-first-line-cache", () => ({
  fingerprintCloudVoiceSettings: () => "legacy",
  shouldBypassCloudFirstLineCache: () => false,
  getCloudFirstLineCacheService: () => ({
    get: async () => {
      events.push("cache-get");
      return cacheHit
        ? { bytes, contentType: "audio/mpeg", byteSize: 4, hitCount: 1 }
        : null;
    },
    put: async () => {
      events.push("cache-put");
      return true;
    },
  }),
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {} },
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => {
    events.push("auth");
    if (!signedIn) throw new ApiError("Unauthorized", 401);
    return {
      user: { id: "user-test", organization_id: "org-test" },
      apiKeyId: "key-test",
      admissionSnapshot: {},
      credential: {},
    };
  },
  asGenerativeCacheApiError: () => undefined,
  getGenerativeExecutionContext: () => ({
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  }),
  getGenerativePricingCacheOptions: () => ({}),
  admitFlatGenerativeOperation: async () => {
    events.push("admit");
    if (denyFunds) throw new InsufficientCreditsError();
    return {
      reservation: {
        reconcile: async () => {
          events.push("release");
        },
      },
      settleUnknown: async () => {
        events.push("unknown");
      },
      markProviderDispatched: async () => {
        events.push("dispatch");
      },
    };
  },
}));
const { default: route } = await import("./route");
const base = { text: "Hello.", voiceId: "test-pinned-voice" };
async function post(body: unknown, env = {}) {
  const response = await route.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
  await Promise.all(background);
  return response;
}
beforeEach(() => {
  events.length =
    syntheses.length =
    safetyTexts.length =
    prices.length =
    background.length =
      0;
  signedIn = true;
  denyFunds = failProvider = safetyDenied = false;
  cacheHit = true;
});
test("rendering request screens all context, bypasses cache and bills one dispatch", async () => {
  const controls = {
    speed: 0.8,
    previousText: "Before.",
    nextText: "After.",
    applyTextNormalization: "on",
  };
  const response = await post({ ...base, ...controls });
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("X-Eliza-TTS-Provider")).toBe("elevenlabs");
  expect(response.headers.get("X-Eliza-TTS-Speed")).toBe("0.8");
  expect(syntheses).toEqual([
    { text: base.text, voiceId: base.voiceId, modelId: undefined, ...controls },
  ]);
  expect(safetyTexts).toEqual([
    "TTS text: Hello.\nPrevious context: Before.\nNext context: After.",
  ]);
  expect(prices[0]?.characterCount).toBe(base.text.length);
  expect(events.filter((e) => e === "dispatch" || e === "bill")).toEqual([
    "dispatch",
    "bill",
  ]);
  expect(events).not.toContain("cache-get");
  expect(events).not.toContain("cache-put");
  expect(events.indexOf("auth")).toBeLessThan(events.indexOf("safety"));
  expect(events.indexOf("admit")).toBeLessThan(events.indexOf("dispatch"));
});
test("legacy request retains cache hit without provider dispatch", async () => {
  expect((await post(base)).status).toBe(200);
  expect(events).toContain("cache-get");
  expect(events).not.toContain("admit");
  expect(syntheses).toHaveLength(0);
});
test("every explicit control avoids cache lookup and population", async () => {
  for (const controls of [
    { speed: 1 },
    { previousText: "" },
    { nextText: "" },
    { applyTextNormalization: "auto" },
    { applyTextNormalization: "off" },
  ]) {
    expect((await post({ ...base, ...controls })).status).toBe(200);
  }
  expect(syntheses).toHaveLength(5);
  expect(events).not.toContain("cache-get");
  expect(events).not.toContain("cache-put");
});
test("invalid controls and unsupported providers authenticate but never admit", async () => {
  for (const controls of [
    { speed: "1" },
    { speed: 2 },
    { previousText: "x".repeat(5001) },
    { applyTextNormalization: "bad" },
  ])
    expect((await post({ ...base, ...controls })).status).toBe(400);
  for (const env of [
    { CARTESIA_API_KEY: "test-key" },
    { KOKORO_TTS_URL: "https://kokoro.invalid" },
  ]) {
    const response = await post({ text: "Hello.", speed: 1 }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "unsupported_synthesis_options",
    });
  }
  expect(events.filter((e) => e === "auth")).toHaveLength(6);
  expect(events).not.toContain("admit");
  expect(syntheses).toHaveLength(0);
});
test("authentication, safety and funding failures prevent synthesis", async () => {
  signedIn = false;
  expect((await post({ ...base, speed: 1 })).status).toBe(401);
  signedIn = true;
  safetyDenied = true;
  expect((await post({ ...base, nextText: "Blocked context." })).status).toBe(
    400,
  );
  safetyDenied = false;
  denyFunds = true;
  expect((await post({ ...base, speed: 1 })).status).toBe(402);
  expect(syntheses).toHaveLength(0);
  expect(events).not.toContain("bill");
  expect(events).not.toContain("dispatch");
});
test("provider failure retains unknown settlement without retry or success billing", async () => {
  failProvider = true;
  expect((await post({ ...base, speed: 0.9 })).status).toBe(500);
  expect(syntheses).toHaveLength(1);
  expect(events.filter((e) => e === "unknown")).toHaveLength(1);
  expect(events).not.toContain("bill");
  expect(events).not.toContain("release");
});

test("WAV preserves rendering controls and reports provider speed", async () => {
  const response = await post({ ...base, format: "wav", speed: 1.1 });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("audio/wav");
  expect(response.headers.get("X-Eliza-TTS-Speed")).toBe("1.1");
  expect(
    new TextDecoder().decode((await response.arrayBuffer()).slice(0, 4)),
  ).toBe("RIFF");
  expect(syntheses[0]).toMatchObject({ speed: 1.1, outputFormat: "pcm_24000" });
  expect(events).not.toContain("cache-get");
});

test("timed route uses one admitted synthesis and never reads or populates raw audio cache", async () => {
  const response = await post({ ...base, withTimestamps: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
  expect(response.headers.get("X-Eliza-TTS-Timing")).toBe("character-v1");
  expect(
    (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type),
  ).toEqual(["audio", "done"]);
  expect(events).toContain("timed-synthesize");
  expect(events).not.toContain("synthesize");
  expect(events).not.toContain("cache-get");
  expect(events).not.toContain("cache-put");
  expect(events.filter((e) => e === "dispatch" || e === "bill")).toEqual([
    "dispatch",
    "bill",
  ]);
});

test("timing rejects unsupported formats, providers and nonboolean controls before admission", async () => {
  expect(
    (await post({ ...base, withTimestamps: true, format: "wav" })).status,
  ).toBe(400);
  expect((await post({ ...base, withTimestamps: "true" })).status).toBe(400);
  expect(
    (
      await post(
        { text: "Hi.", withTimestamps: true },
        { CARTESIA_API_KEY: "test" },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await post(
        { text: "Hi.", withTimestamps: true },
        { KOKORO_TTS_URL: "https://kokoro.invalid" },
      )
    ).status,
  ).toBe(400);
  expect(events.filter((e) => e === "auth")).toHaveLength(4);
  expect(events).not.toContain("admit");
});

test("cross-origin clients can read the rendered speed acknowledgment", async () => {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.route("/api/v1/voice/tts", route);
  const origin = "https://cloud.eliza.app";
  const response = await app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ ...base, speed: 0.8, withTimestamps: true }),
    },
    {},
  );
  await Promise.all(background);
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  expect(response.headers.get("X-Eliza-TTS-Speed")).toBe("0.8");
  expect(
    response.headers
      .get("Access-Control-Expose-Headers")
      ?.toLowerCase()
      .split(",")
      .map((header) => header.trim()),
  ).toEqual(
    expect.arrayContaining(["x-eliza-tts-speed", "x-eliza-tts-timing"]),
  );
  expect(response.headers.get("X-Eliza-TTS-Timing")).toBe("character-v1");
});
