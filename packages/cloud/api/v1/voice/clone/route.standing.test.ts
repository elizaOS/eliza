/** Proves voice-clone standing denial stops all priced and irreversible work. */

import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const requireGenerativeRouteCaller = mock<() => Promise<unknown>>(async () => {
  throw new ApiError(403, "access_denied", "Account is inactive", {
    reason: "account_inactive",
  });
});
const admitFlatGenerativeOperation = mock<() => Promise<unknown>>(async () => {
  throw new Error("admission must not run after standing denial");
});
const calculateVoiceCloneCostFromCatalog = mock<() => Promise<unknown>>(
  async () => {
    throw new Error("pricing must not run after standing denial");
  },
);
const createCloningJob = mock<() => Promise<unknown>>(async () => {
  throw new Error("storage must not run after standing denial");
});
const createSamples = mock(async () => undefined);
const createVoice = mock(async () => ({
  id: "voice-row-1",
  elevenlabsVoiceId: "eleven-voice-1",
  name: "Test Voice",
  description: null,
  cloneType: "instant",
  sampleCount: 1,
  createdAt: new Date("2026-08-29T00:00:00.000Z"),
}));
const attachSamplesToVoice = mock(async () => undefined);
const completeCloningJob = mock(async () => ({
  id: "job-1",
  status: "completed",
  progress: 100,
}));
const markProviderDispatched = mock(async () => undefined);
const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const billFlatUsage = mock(async () => ({
  totalCost: 1,
  baseTotalCost: 0.8,
  platformMarkup: 0.2,
}));
const createUsage = mock(async () => undefined);

mock.module("@/api-app/lib/generative-route-auth", () => ({
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError: () => null,
  getGenerativeExecutionContext: () => undefined,
  requireGenerativeRouteCaller,
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError,
  ValidationError: (message: string) =>
    new ApiError(400, "bad_request", message),
  failureResponse: (
    c: { json(body: unknown, status: number): Response },
    error: ApiError,
  ) =>
    c.json(
      { error: error.message, code: error.code, details: error.details },
      error.status,
    ),
  jsonError: (
    c: { json(body: unknown, status: number): Response },
    status: number,
    error: string,
    code = "internal_error",
  ) => c.json({ error, code }, status),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/services/ai-pricing", () => ({
  calculateVoiceCloneCostFromCatalog,
}));
mock.module("@/lib/services/ai-billing", () => ({
  billFlatUsage,
}));
mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: {
    createCloningJob,
    createSamples,
    createVoice,
    attachSamplesToVoice,
    completeCloningJob,
    deleteSamplesByJobId: mock(async () => undefined),
    markCloningJobFailed: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/usage", () => ({
  usageService: { create: createUsage },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { default: voiceCloneRoute } = await import("./route");
const app = new Hono().route("/v1/voice/clone", voiceCloneRoute);

test("cached bad standing denies before pricing, admission, provider, or storage", async () => {
  const providerFetch = mock(async () => new Response("provider"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const blobPut = mock(async () => undefined);

  try {
    const response = await app.request(
      "/v1/voice/clone",
      { method: "POST" },
      { ELEVENLABS_API_KEY: "configured", BLOB: { put: blobPut } },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "access_denied",
      error: "Account is inactive",
      details: { reason: "account_inactive" },
    });
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(calculateVoiceCloneCostFromCatalog).not.toHaveBeenCalled();
    expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
    expect(createCloningJob).not.toHaveBeenCalled();
    expect(blobPut).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admits before ElevenLabs and settles the flat charge without a readback", async () => {
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balanceUsd: 10, revision: "2" },
  }));
  calculateVoiceCloneCostFromCatalog.mockImplementationOnce(async () => ({
    totalCost: 1,
    baseTotalCost: 0.8,
    platformMarkup: 0.2,
    pricingSource: "catalog",
  }));
  admitFlatGenerativeOperation.mockImplementationOnce(async () => ({
    mode: "synchronous_db_ledger",
    markProviderDispatched,
    settle,
    settleUnknown,
  }));
  createCloningJob.mockImplementationOnce(async () => ({
    id: "job-1",
    startedAt: new Date(),
  }));
  const providerFetch = mock(async () =>
    Response.json({ voice_id: "eleven-voice-1" }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const blobPut = mock(async () => undefined);
  const form = new FormData();
  form.set("name", "Test Voice");
  form.set("cloneType", "instant");
  form.set(
    "file0",
    new File([new Uint8Array([1, 2, 3])], "sample.wav", {
      type: "audio/wav",
    }),
  );

  try {
    const response = await app.request(
      "/v1/voice/clone",
      { method: "POST", body: form },
      {
        ELEVENLABS_API_KEY: "configured",
        R2_PUBLIC_HOST: "blob.example.test",
        BLOB: { put: blobPut },
      },
    );

    expect(response.status).toBe(201);
    expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
    expect(markProviderDispatched).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(billFlatUsage).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(1);
    expect(settleUnknown).not.toHaveBeenCalled();
    expect(createUsage).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
