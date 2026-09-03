/** Verifies the sound-effect generation request boundary with deterministic provider mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const assertSafeForPublicUse = mock(async () => undefined);
let providerError: Error | null = null;
let dispatchReceiptError: Error | null = null;
let generationReceiptError: Error | null = null;
let billingError: Error | null = null;
let conservativeSettlementError: Error | null = null;
let captureBackgroundTasks = false;
const backgroundTasks: Promise<unknown>[] = [];
const events: string[] = [];
const generateAudio = mock(async () => {
  if (providerError) throw providerError;
  return {
    source: "hosted" as const,
    url: "https://example.test/sfx.mp3",
    fileName: "sfx.mp3",
    fileSize: 10,
    contentType: "audio/mpeg",
    requestId: "req-sfx",
    status: "completed",
    raw: {},
  };
});
const markProviderDispatched = mock(async () => {
  if (dispatchReceiptError) throw dispatchReceiptError;
});
const settle = mock(async (_cost: number) => undefined);
const settleUnknown = mock(async () => undefined);
const createGeneration = mock(async () => {
  events.push("generation-receipt");
  if (generationReceiptError) throw generationReceiptError;
  return { id: "gen-sfx" };
});
const billFlatUsage = mock(async () => {
  events.push("exact-settlement");
  if (billingError) throw billingError;
  return { totalCost: 0.1 };
});
const loggerError = mock(() => undefined);
const requireGenerativeRouteCaller = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKeyId: null,
  admissionSnapshot: null,
}));

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller,
  admitFlatGenerativeOperation: async () => ({
    reservation: { reconcile: async () => undefined },
    settle,
    settleUnknown,
    markProviderDispatched,
  }),
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () =>
    captureBackgroundTasks
      ? {
          waitUntil(task: Promise<unknown>) {
            backgroundTasks.push(task);
          },
        }
      : undefined,
  getGenerativePricingCacheOptions: () => ({}),
}));

mock.module("@/lib/services/content-safety", () => ({
  contentSafetyService: { assertSafeForPublicUse },
}));

mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage,
}));

mock.module("@/lib/services/ai-pricing", () => ({
  calculateSfxGenerationCostFromCatalog: async () => ({
    totalCost: 0.1,
    baseTotalCost: 0.1,
    platformMarkup: 0,
  }),
}));

mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

mock.module("@/lib/services/generations", () => ({
  generationsService: { create: createGeneration },
}));

mock.module("@/lib/providers/audio/registry", () => ({
  getAudioProvider: () => ({ generate: generateAudio }),
}));

mock.module("@/lib/storage/r2-public-object", () => ({
  putPublicObject: async () => ({ url: "https://example.test/s.mp3" }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: loggerError,
    debug: () => undefined,
  },
}));

const { default: app } = await import("./route");

const validBody = {
  model: "elevenlabs/sound_effects_v1",
  prompt: "glass clink",
};

describe("POST /api/v1/generate-sfx malformed JSON", () => {
  beforeEach(() => {
    providerError = null;
    dispatchReceiptError = null;
    generationReceiptError = null;
    billingError = null;
    conservativeSettlementError = null;
    captureBackgroundTasks = false;
    backgroundTasks.length = 0;
    events.length = 0;
    assertSafeForPublicUse.mockClear();
    generateAudio.mockClear();
    markProviderDispatched.mockClear();
    settle.mockClear();
    settleUnknown.mockClear();
    settleUnknown.mockImplementation(async () => {
      if (conservativeSettlementError) throw conservativeSettlementError;
    });
    createGeneration.mockClear();
    billFlatUsage.mockClear();
    loggerError.mockClear();
  });

  test("returns 400 instead of 500 and never admits generation", async () => {
    const response = await app.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
      { ELEVENLABS_API_KEY: "el-test-key" },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(assertSafeForPublicUse).not.toHaveBeenCalled();
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: false }),
    );
    expect(generateAudio).not.toHaveBeenCalled();
  });

  test("canonical JSON still generates sfx", async () => {
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );
    expect(response.status).toBe(200);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferStrongCredentialCheck: true }),
    );
    expect(generateAudio).toHaveBeenCalled();
  });

  test("conservatively settles an ambiguous provider failure after dispatch", async () => {
    providerError = new Error("provider transport closed after submit");
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );

    expect(response.status).toBe(500);
    expect(markProviderDispatched).toHaveBeenCalledTimes(1);
    expect(generateAudio).toHaveBeenCalledTimes(1);
    expect(settleUnknown).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  test("releases the reservation when the dispatch receipt fails before provider invocation", async () => {
    dispatchReceiptError = new Error("dispatch receipt unavailable");
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );

    expect(response.status).toBe(500);
    expect(generateAudio).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(0);
    expect(settleUnknown).not.toHaveBeenCalled();
  });

  test("persists the completed receipt before exact settlement and returning its id", async () => {
    captureBackgroundTasks = true;
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      id: expect.any(String),
    });
    await Promise.all(backgroundTasks);
    expect(events).toEqual(["generation-receipt", "exact-settlement"]);
  });

  test("fails the request and conservatively settles when the completed receipt cannot persist", async () => {
    generationReceiptError = new Error("generation receipt unavailable");
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );

    expect(response.status).toBe(500);
    expect(createGeneration).toHaveBeenCalledTimes(1);
    expect(billFlatUsage).not.toHaveBeenCalled();
    expect(settleUnknown).toHaveBeenCalledTimes(1);
  });

  test("retains both diagnostics and resolves the task when exact and conservative settlement fail", async () => {
    captureBackgroundTasks = true;
    billingError = new Error("exact settlement unavailable");
    conservativeSettlementError = new Error(
      "conservative settlement unavailable",
    );
    const response = await app.fetch(
      new Request("http://test.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      { ELEVENLABS_API_KEY: "el-test-key" },
    );

    expect(response.status).toBe(200);
    await expect(Promise.all(backgroundTasks)).resolves.toBeArray();
    expect(settleUnknown).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      "[GenerateSfx] Background exact settlement failed",
      expect.objectContaining({
        organizationId: "org-1",
        settlementMode: "unknown",
        error: "exact settlement unavailable",
      }),
    );
    expect(loggerError).toHaveBeenCalledWith(
      "[GenerateSfx] Conservative settlement also failed",
      expect.objectContaining({
        organizationId: "org-1",
        settlementMode: "unknown",
        error: "conservative settlement unavailable",
      }),
    );
  });
});
