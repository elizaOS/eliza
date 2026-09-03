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

class InsufficientCreditsError extends Error {
  constructor(readonly required: number) {
    super("Insufficient balance");
  }
}

const requireGenerativeRouteCaller = mock<
  (
    context?: unknown,
    options?: { deferStrongCredentialCheck?: boolean },
  ) => Promise<unknown>
>(async () => {
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
const createOrReadCloningJob = mock<(input: unknown) => Promise<unknown>>(
  async () => {
    throw new Error("storage must not run after standing denial");
  },
);
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
const recordCloningJobProviderReceipt = mock<
  (input: {
    jobId: string;
    step: "create" | "samples" | "train";
    state: "submitted" | "accepted" | "rejected" | "submission_unknown";
    elevenlabsVoiceId?: string;
    errorMessage?: string;
  }) => Promise<void>
>(async () => undefined);
const deleteSamplesByJobId = mock(async () => undefined);
const markCloningJobFailed = mock(async () => undefined);
const markCloningJobReconciliationRequired = mock(async () => undefined);
const markProviderDispatched = mock(async () => undefined);
const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const billFlatUsage = mock(async () => ({
  totalCost: 1,
  baseTotalCost: 0.8,
  platformMarkup: 0.2,
}));
const createUsage = mock(async () => undefined);
const loggerError = mock(() => undefined);

mock.module("@/api-app/lib/generative-route-auth", () => ({
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError: (error: unknown) =>
    error instanceof ApiError ? error : null,
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
  InsufficientCreditsError,
}));
mock.module("@/db/repositories/user-voices", () => ({
  userVoicesRepository: {
    createOrReadCloningJob,
    createSamples,
    createVoice,
    attachSamplesToVoice,
    completeCloningJob,
    recordCloningJobProviderReceipt,
    deleteSamplesByJobId,
    markCloningJobFailed,
    markCloningJobReconciliationRequired,
  },
}));
mock.module("@/lib/services/usage", () => ({
  usageService: { create: createUsage },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: loggerError,
    info: mock(() => undefined),
  },
}));

const { default: voiceCloneRoute } = await import("./route");
const app = new Hono().route("/v1/voice/clone", voiceCloneRoute);

test("invalid form performs one standalone strong check without admission", async () => {
  requireGenerativeRouteCaller.mockClear();
  admitFlatGenerativeOperation.mockClear();
  calculateVoiceCloneCostFromCatalog.mockClear();
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
  }));

  const response = await app.request(
    "/v1/voice/clone",
    { method: "POST", body: new FormData() },
    { ELEVENLABS_API_KEY: "configured" },
  );

  expect(response.status).toBe(400);
  expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
  expect(requireGenerativeRouteCaller.mock.calls[0]?.[1]).toMatchObject({
    deferStrongCredentialCheck: false,
  });
  expect(calculateVoiceCloneCostFromCatalog).not.toHaveBeenCalled();
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
});

test("cached bad standing denies before pricing, admission, provider, or storage", async () => {
  requireGenerativeRouteCaller.mockClear();
  const providerFetch = mock(async () => new Response("provider"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const blobPut = mock(async () => undefined);

  try {
    const form = new FormData();
    form.set("name", "Denied Voice");
    form.set("cloneType", "instant");
    form.set(
      "file0",
      new File([new Uint8Array([1])], "sample.wav", { type: "audio/wav" }),
    );
    const response = await app.request(
      "/v1/voice/clone",
      { method: "POST", body: form },
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
    expect(createOrReadCloningJob).not.toHaveBeenCalled();
    expect(blobPut).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("combined credential denial is sanitized before ElevenLabs dispatch", async () => {
  createOrReadCloningJob.mockImplementationOnce(async () => ({
    created: true,
    job: { id: "job-credential-denial", startedAt: new Date() },
  }));
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    credential: {
      kind: "api_key",
      credentialId: "key-1",
      userId: "user-1",
    },
  }));
  calculateVoiceCloneCostFromCatalog.mockImplementationOnce(async () => ({
    totalCost: 1,
    baseTotalCost: 0.8,
    platformMarkup: 0.2,
    pricingSource: "catalog",
  }));
  admitFlatGenerativeOperation.mockImplementationOnce(async () => {
    throw new ApiError(
      401,
      "authentication_required",
      "Authentication required",
      { reason: "credential_inactive" },
    );
  });
  const providerFetch = mock(async () => new Response("provider"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const form = new FormData();
  form.set("name", "Revoked Voice");
  form.set("cloneType", "instant");
  form.set(
    "file0",
    new File([new Uint8Array([1])], "sample.wav", { type: "audio/wav" }),
  );

  try {
    const response = await app.request(
      "/v1/voice/clone",
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "voice-credential-denial-1" },
      },
      { ELEVENLABS_API_KEY: "configured", BLOB: { put: mock() } },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "authentication_required",
      error: "Authentication required",
      details: { reason: "credential_inactive" },
    });
    expect(createOrReadCloningJob).toHaveBeenCalledTimes(1);
    expect(markCloningJobFailed).toHaveBeenCalledWith(
      "job-credential-denial",
      "voice_clone_request_failed",
    );
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admits before ElevenLabs and settles the flat charge without a readback", async () => {
  admitFlatGenerativeOperation.mockClear();
  createUsage.mockClear();
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
  createOrReadCloningJob.mockImplementationOnce(async () => ({
    created: true,
    job: { id: "job-1", startedAt: new Date() },
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
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "voice-success-1" },
      },
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

test("rejects a reused key with a different payload before billing or provider work", async () => {
  admitFlatGenerativeOperation.mockClear();
  calculateVoiceCloneCostFromCatalog.mockClear();
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balanceUsd: 10, revision: "2" },
  }));
  createOrReadCloningJob.mockImplementationOnce(async () => ({
    created: false,
    job: {
      id: "job-conflict",
      requestDigest: "digest-for-a-different-payload",
      status: "processing",
      progress: 0,
      responsePayload: null,
    },
  }));
  const providerFetch = mock(async () =>
    Response.json({ voice_id: "duplicate" }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const form = new FormData();
  form.set("name", "Different Voice");
  form.set("cloneType", "instant");
  form.set(
    "file0",
    new File([new Uint8Array([9])], "different.wav", { type: "audio/wav" }),
  );

  try {
    const response = await app.request(
      "/v1/voice/clone",
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "voice-success-1" },
      },
      { ELEVENLABS_API_KEY: "configured", BLOB: { put: mock() } },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(calculateVoiceCloneCostFromCatalog).not.toHaveBeenCalled();
    expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("durably replays insufficient-credit denial without a stranded processing job", async () => {
  admitFlatGenerativeOperation.mockClear();
  markCloningJobFailed.mockClear();
  requireGenerativeRouteCaller
    .mockImplementationOnce(async () => ({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "key-1",
      admissionSnapshot: { balanceUsd: 0, revision: "3" },
    }))
    .mockImplementationOnce(async () => ({
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: "key-1",
      admissionSnapshot: { balanceUsd: 0, revision: "3" },
    }));
  calculateVoiceCloneCostFromCatalog.mockImplementationOnce(async () => ({
    totalCost: 1,
    baseTotalCost: 0.8,
    platformMarkup: 0.2,
    pricingSource: "catalog",
  }));
  admitFlatGenerativeOperation.mockImplementationOnce(async () => {
    throw new InsufficientCreditsError(1);
  });
  let requestDigest = "";
  createOrReadCloningJob
    .mockImplementationOnce(async (input: unknown) => {
      requestDigest = (input as { requestDigest: string }).requestDigest;
      return {
        created: true,
        job: { id: "job-insufficient", startedAt: new Date() },
      };
    })
    .mockImplementationOnce(async () => ({
      created: false,
      job: {
        id: "job-insufficient",
        status: "failed",
        progress: 0,
        requestDigest,
        responsePayload: {
          status: 402,
          body: {
            success: false,
            error: "Insufficient balance",
            code: "insufficient_credits",
            details: { required: 1, cloneType: "instant" },
          },
        },
      },
    }));
  const providerFetch = mock(async () =>
    Response.json({ voice_id: "duplicate" }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;

  try {
    const request = () => {
      const form = new FormData();
      form.set("name", "No Credits Voice");
      form.set("cloneType", "instant");
      form.set(
        "file0",
        new File([new Uint8Array([4])], "sample.wav", { type: "audio/wav" }),
      );
      return app.request(
        "/v1/voice/clone",
        {
          method: "POST",
          body: form,
          headers: { "Idempotency-Key": "voice-insufficient-1" },
        },
        { ELEVENLABS_API_KEY: "configured", BLOB: { put: mock() } },
      );
    };

    const first = await request();
    const retry = await request();
    expect(first.status).toBe(402);
    expect(retry.status).toBe(402);
    await expect(retry.json()).resolves.toMatchObject({
      code: "insufficient_credits",
      details: { required: 1 },
    });
    expect(markCloningJobFailed).toHaveBeenCalledWith(
      "job-insufficient",
      "Insufficient balance",
      expect.any(Date),
      expect.objectContaining({ status: 402 }),
    );
    expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("timeout after provider submission retains evidence and settles unknown", async () => {
  admitFlatGenerativeOperation.mockClear();
  settle.mockClear();
  settleUnknown.mockClear();
  loggerError.mockClear();
  recordCloningJobProviderReceipt.mockClear();
  deleteSamplesByJobId.mockClear();
  markCloningJobFailed.mockClear();
  markCloningJobReconciliationRequired.mockClear();
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balanceUsd: 10, revision: "3" },
  }));
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balanceUsd: 10, revision: "3" },
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
  createOrReadCloningJob
    .mockImplementationOnce(async () => ({
      created: true,
      job: { id: "job-timeout", startedAt: new Date() },
    }))
    .mockImplementationOnce(async (input: unknown) => ({
      created: false,
      job: {
        id: "job-timeout",
        status: "reconciliation_required",
        progress: 0,
        requestDigest: (input as { requestDigest: string }).requestDigest,
        responsePayload: null,
      },
    }));
  const providerFetch = mock(async () => {
    throw new DOMException("The operation timed out", "TimeoutError");
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const blobDelete = mock(async () => undefined);
  const form = new FormData();
  form.set("name", "Ambiguous Voice");
  form.set("cloneType", "instant");
  form.set(
    "file0",
    new File([new Uint8Array([1])], "sample.wav", { type: "audio/wav" }),
  );

  try {
    const response = await app.request(
      "/v1/voice/clone",
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "voice-timeout-1" },
      },
      {
        ELEVENLABS_API_KEY: "configured",
        BLOB: { put: mock(async () => undefined), delete: blobDelete },
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Voice clone provider work could not be completed. It is retained for reconciliation.",
      details: {
        outcome: "provider_submission_unknown",
        jobId: "job-timeout",
      },
    });
    expect(recordCloningJobProviderReceipt.mock.calls).toEqual([
      [
        {
          jobId: "job-timeout",
          step: "create",
          state: "submitted",
        },
      ],
      [
        {
          jobId: "job-timeout",
          step: "create",
          state: "submission_unknown",
          errorMessage: "provider_transport_uncertain",
        },
      ],
    ]);
    expect(deleteSamplesByJobId).not.toHaveBeenCalled();
    expect(blobDelete).not.toHaveBeenCalled();
    expect(markCloningJobFailed).not.toHaveBeenCalled();
    expect(markCloningJobReconciliationRequired).toHaveBeenCalledWith(
      "job-timeout",
      "provider_submission_unknown",
    );
    expect(settleUnknown).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[Voice Clone API] Provider work requires reconciliation",
      expect.objectContaining({
        jobId: "job-timeout",
        organizationId: "org-1",
        provider: "elevenlabs",
        providerState: "submission_unknown",
        providerStep: "create",
      }),
    );

    const retryForm = new FormData();
    retryForm.set("name", "Ambiguous Voice");
    retryForm.set("cloneType", "instant");
    retryForm.set(
      "file0",
      new File([new Uint8Array([1])], "sample.wav", { type: "audio/wav" }),
    );
    const retry = await app.request(
      "/v1/voice/clone",
      {
        method: "POST",
        body: retryForm,
        headers: { "Idempotency-Key": "voice-timeout-1" },
      },
      {
        ELEVENLABS_API_KEY: "configured",
        BLOB: { put: mock(async () => undefined), delete: blobDelete },
      },
    );
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      code: "idempotency_replay",
      reconciliationRequired: true,
      job: { id: "job-timeout", status: "reconciliation_required" },
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("professional later-step failure retains the voice id and evidence", async () => {
  settle.mockClear();
  settleUnknown.mockClear();
  loggerError.mockClear();
  recordCloningJobProviderReceipt.mockClear();
  deleteSamplesByJobId.mockClear();
  markCloningJobFailed.mockClear();
  markCloningJobReconciliationRequired.mockClear();
  createVoice.mockClear();
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balanceUsd: 10, revision: "4" },
  }));
  calculateVoiceCloneCostFromCatalog.mockImplementationOnce(async () => ({
    totalCost: 5,
    baseTotalCost: 4,
    platformMarkup: 1,
    pricingSource: "catalog",
  }));
  admitFlatGenerativeOperation.mockImplementationOnce(async () => ({
    mode: "synchronous_db_ledger",
    markProviderDispatched,
    settle,
    settleUnknown,
  }));
  createOrReadCloningJob.mockImplementationOnce(async () => ({
    created: true,
    job: { id: "job-professional", startedAt: new Date() },
  }));
  const providerFetch = mock(async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.endsWith("/v1/voices/pvc")) {
      return Response.json({ voice_id: "pvc-accepted-1" });
    }
    return new Response("sample rejected", { status: 422 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const blobDelete = mock(async () => undefined);
  const form = new FormData();
  form.set("name", "Professional Voice");
  form.set("cloneType", "professional");
  form.set(
    "file0",
    new File([new Uint8Array([1])], "sample.wav", { type: "audio/wav" }),
  );

  try {
    const response = await app.request(
      "/v1/voice/clone",
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "test-key-0001" },
      },
      {
        ELEVENLABS_API_KEY: "configured",
        BLOB: { put: mock(async () => undefined), delete: blobDelete },
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      details: {
        outcome: "provider_work_reconciliation_required",
        jobId: "job-professional",
      },
    });
    expect(recordCloningJobProviderReceipt).toHaveBeenCalledWith({
      jobId: "job-professional",
      step: "create",
      state: "accepted",
      elevenlabsVoiceId: "pvc-accepted-1",
    });
    expect(recordCloningJobProviderReceipt).toHaveBeenLastCalledWith({
      jobId: "job-professional",
      step: "samples",
      state: "rejected",
      elevenlabsVoiceId: "pvc-accepted-1",
    });
    expect(createVoice).not.toHaveBeenCalled();
    expect(deleteSamplesByJobId).not.toHaveBeenCalled();
    expect(blobDelete).not.toHaveBeenCalled();
    expect(markCloningJobFailed).not.toHaveBeenCalled();
    expect(markCloningJobReconciliationRequired).toHaveBeenCalledWith(
      "job-professional",
      "provider_work_reconciliation_required",
    );
    expect(settleUnknown).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[Voice Clone API] Provider work requires reconciliation",
      expect.objectContaining({
        jobId: "job-professional",
        providerState: "rejected",
        providerStep: "samples",
        providerVoiceId: "pvc-accepted-1",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("definitive provider rejection exposes and persists only a typed safe reason", async () => {
  settle.mockClear();
  settleUnknown.mockClear();
  loggerError.mockClear();
  recordCloningJobProviderReceipt.mockClear();
  markCloningJobFailed.mockClear();
  createUsage.mockClear();
  requireGenerativeRouteCaller.mockImplementationOnce(async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    admissionSnapshot: { balanceUsd: 10, revision: "5" },
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
  createOrReadCloningJob.mockImplementationOnce(async () => ({
    created: true,
    job: { id: "job-provider-rejected", startedAt: new Date() },
  }));
  const privateProviderError =
    "subscription account acct_private_123 rejected the request";
  const providerFetch = mock(
    async () => new Response(privateProviderError, { status: 422 }),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch as unknown as typeof fetch;
  const form = new FormData();
  form.set("name", "Rejected Voice");
  form.set("cloneType", "instant");
  form.set(
    "file0",
    new File([new Uint8Array([1])], "sample.wav", { type: "audio/wav" }),
  );

  try {
    const response = await app.request(
      "/v1/voice/clone",
      {
        method: "POST",
        body: form,
        headers: { "Idempotency-Key": "voice-provider-rejected-1" },
      },
      {
        ELEVENLABS_API_KEY: "configured",
        BLOB: {
          put: mock(async () => undefined),
          delete: mock(async () => undefined),
        },
      },
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "Failed to create voice clone. Credits have been refunded.",
      details: {
        outcome: "provider_request_rejected",
        jobId: "job-provider-rejected",
      },
    });
    expect(JSON.stringify(body)).not.toContain(privateProviderError);
    expect(markCloningJobFailed).toHaveBeenCalledWith(
      "job-provider-rejected",
      "provider_request_rejected",
    );
    expect(createUsage).toHaveBeenCalledWith(
      expect.objectContaining({ error_message: "provider_request_rejected" }),
    );
    expect(settle).toHaveBeenCalledWith(0);
    expect(settleUnknown).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[Voice Clone API] Unhandled error",
      expect.objectContaining({
        error: expect.stringContaining(privateProviderError),
        safeFailureReason: "provider_request_rejected",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
