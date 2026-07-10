// Exercises the /api/v1/imports route tree (#13432) with deterministic Worker route fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as conversationImportsActual from "@/lib/services/conversation-imports";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000bb";
const SESSION = "00000000-0000-4000-8000-0000000000dd";
const BATCH = "00000000-0000-4000-8000-0000000000ee";
const SHA = "a".repeat(64);

const requireUserOrApiKeyWithOrg = mock();
const requireCronSecret = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
  requireCronSecret,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: rateLimitActual.RateLimitPresets,
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const preflight = mock();
const initResumableUpload = mock();
const appendChunk = mock();
const getUploadStatus = mock();
const completeUpload = mock();
const abortUpload = mock();
const directUpload = mock();
const listBatches = mock();
const getBatch = mock();
const deleteBatch = mock();
const purgeExpired = mock();
mock.module("@/lib/services/conversation-imports", () => ({
  ...conversationImportsActual,
  conversationImportsService: {
    preflight,
    initResumableUpload,
    appendChunk,
    getUploadStatus,
    completeUpload,
    abortUpload,
    directUpload,
    listBatches,
    getBatch,
    deleteBatch,
    purgeExpired,
  },
}));

const preflightRoute = (await import("../v1/imports/preflight/route")).default;
const uploadsRoute = (await import("../v1/imports/uploads/route")).default;
const directRoute = (await import("../v1/imports/uploads/direct/route"))
  .default;
const sessionRoute = new Hono().route(
  "/:sessionId",
  (await import("../v1/imports/uploads/[sessionId]/route")).default,
);
const chunkRoute = new Hono().route(
  "/:sessionId/chunks/:chunkIndex",
  (await import("../v1/imports/uploads/[sessionId]/chunks/[chunkIndex]/route"))
    .default,
);
const completeRoute = new Hono().route(
  "/:sessionId/complete",
  (await import("../v1/imports/uploads/[sessionId]/complete/route")).default,
);
const batchesRoute = (await import("../v1/imports/batches/route")).default;
const batchRoute = new Hono().route(
  "/:batchId",
  (await import("../v1/imports/batches/[batchId]/route")).default,
);
const cronRoute = (await import("../cron/cleanup-expired-import-uploads/route"))
  .default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module(
    "@/lib/services/conversation-imports",
    () => conversationImportsActual,
  );
});

function env() {
  return {
    BLOB: {
      put: mock(async () => undefined),
      delete: mock(async () => undefined),
      get: mock(async () => null),
    },
  };
}

function sessionDto(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    batchId: BATCH,
    filename: "export.zip",
    contentType: "application/zip",
    declaredSha256: SHA,
    uploadBytes: 12_582_912,
    chunkSize: 5_242_880,
    chunkCount: 3,
    status: "open",
    expiresAt: "2026-07-16T00:00:00.000Z",
    progress: {
      receivedBytes: 0,
      uploadBytes: 12_582_912,
      receivedChunks: 0,
      chunkCount: 3,
      complete: false,
    },
    missingRanges: [],
    ...overrides,
  };
}

function batchDto(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH,
    appId: "default",
    source: "chatgpt",
    status: "uploading",
    uploadBytes: 12_582_912,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [
    requireUserOrApiKeyWithOrg,
    requireCronSecret,
    preflight,
    initResumableUpload,
    appendChunk,
    getUploadStatus,
    completeUpload,
    abortUpload,
    directUpload,
    listBatches,
    getBatch,
    deleteBatch,
    purgeExpired,
  ]) {
    fn.mockReset();
  }
  requireUserOrApiKeyWithOrg.mockImplementation(
    async (c: { set: (key: string, value: unknown) => void }) => {
      c.set("apiKeyId", "key-1");
      return {
        id: USER,
        organization_id: ORG,
        organization: { id: ORG, name: "Org", is_active: true },
        is_active: true,
      };
    },
  );
});

describe("POST /api/v1/imports/preflight", () => {
  test("returns the admit decision for the authenticated organization", async () => {
    preflight.mockResolvedValue({
      ok: true,
      requiresResumable: true,
      maxDirectUploadBytes: 26_214_400,
      maxResumableUploadBytes: 1_073_741_824,
      minChunkBytes: 5_242_880,
      maxChunkBytes: 94_371_840,
      recommendedChunkBytes: 16_777_216,
    });
    const res = await preflightRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadBytes: 300_000_000,
          conversationCount: 1200,
        }),
      },
      env() as never,
    );
    expect(res.status).toBe(200);
    expect(preflight).toHaveBeenCalledWith(expect.any(Object), {
      organizationId: ORG,
      uploadBytes: 300_000_000,
      conversationCount: 1200,
    });
    const body = (await res.json()) as {
      decision: { requiresResumable: boolean };
    };
    expect(body.decision.requiresResumable).toBe(true);
  });

  test("maps typed preflight rejections to 413 with the crossed limit", async () => {
    preflight.mockResolvedValue({
      ok: false,
      code: "upload_too_large",
      message: "too large",
      limit: 1_073_741_824,
      observed: 2_000_000_000,
    });
    const res = await preflightRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadBytes: 2_000_000_000 }),
      },
      env() as never,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      error: "too large",
      code: "upload_too_large",
      details: { limit: 1_073_741_824, observed: 2_000_000_000 },
    });
  });

  test("rejects malformed estimates before touching the service", async () => {
    const res = await preflightRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadBytes: -5 }),
      },
      env() as never,
    );
    expect(res.status).toBe(400);
    expect(preflight).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/imports/uploads", () => {
  test("opens a resumable session scoped to the caller", async () => {
    initResumableUpload.mockResolvedValue({
      ok: true,
      session: sessionDto(),
      batch: batchDto(),
    });
    const res = await uploadsRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "chatgpt",
          filename: "export.zip",
          contentType: "application/zip",
          uploadBytes: 12_582_912,
          chunkSize: 5_242_880,
          declaredSha256: SHA.toUpperCase(),
        }),
      },
      env() as never,
    );
    expect(res.status).toBe(201);
    const initArg = initResumableUpload.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(initArg.organizationId).toBe(ORG);
    expect(initArg.userId).toBe(USER);
    expect(initArg.apiKeyId).toBe("key-1");
    expect(initArg.declaredSha256).toBe(SHA);
    const body = (await res.json()) as { session: { sessionId: string } };
    expect(body.session.sessionId).toBe(SESSION);
  });

  test("maps quota rejections to 413 typed DTOs", async () => {
    initResumableUpload.mockResolvedValue({
      ok: false,
      code: "quota_storage_exceeded",
      message: "quota exceeded",
      limit: 1000,
      observed: 12_582_912,
    });
    const res = await uploadsRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "chatgpt",
          filename: "export.zip",
          contentType: "application/zip",
          uploadBytes: 12_582_912,
          chunkSize: 5_242_880,
          declaredSha256: SHA,
        }),
      },
      env() as never,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("quota_storage_exceeded");
  });

  test("rejects an invalid declared sha before the service runs", async () => {
    const res = await uploadsRoute.request(
      "/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "chatgpt",
          filename: "export.zip",
          contentType: "application/zip",
          uploadBytes: 12_582_912,
          chunkSize: 5_242_880,
          declaredSha256: "not-a-sha",
        }),
      },
      env() as never,
    );
    expect(res.status).toBe(400);
    expect(initResumableUpload).not.toHaveBeenCalled();
  });
});

describe("PUT /api/v1/imports/uploads/:sessionId/chunks/:chunkIndex", () => {
  test("forwards validated chunk bytes with the declared offset", async () => {
    appendChunk.mockResolvedValue({
      ok: true,
      status: "accepted",
      chunkIndex: 1,
      progress: {
        receivedBytes: 10,
        uploadBytes: 20,
        receivedChunks: 1,
        chunkCount: 2,
        complete: false,
      },
    });
    const res = await chunkRoute.request(
      `/${SESSION}/chunks/1`,
      {
        method: "PUT",
        headers: {
          "x-import-chunk-offset": "5242880",
          "x-import-chunk-sha256": SHA.toUpperCase(),
        },
        body: new Uint8Array([1, 2, 3]),
      },
      env() as never,
    );
    expect(res.status).toBe(200);
    const chunkArg = appendChunk.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(chunkArg.organizationId).toBe(ORG);
    expect(chunkArg.sessionId).toBe(SESSION);
    expect(chunkArg.chunkIndex).toBe(1);
    expect(chunkArg.offset).toBe(5_242_880);
    expect(chunkArg.sha256).toBe(SHA);
    expect(chunkArg.bytes).toEqual(new Uint8Array([1, 2, 3]));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("accepted");
  });

  test("requires the declared chunk offset header", async () => {
    const res = await chunkRoute.request(
      `/${SESSION}/chunks/1`,
      { method: "PUT", body: new Uint8Array([1, 2, 3]) },
      env() as never,
    );
    expect(res.status).toBe(400);
    expect(appendChunk).not.toHaveBeenCalled();
  });

  test("rejects empty chunk bodies", async () => {
    const res = await chunkRoute.request(
      `/${SESSION}/chunks/1`,
      {
        method: "PUT",
        headers: { "x-import-chunk-offset": "0" },
        body: new Uint8Array(0),
      },
      env() as never,
    );
    expect(res.status).toBe(400);
    expect(appendChunk).not.toHaveBeenCalled();
  });

  test("maps chunk conflicts to 409 and expired sessions to 410", async () => {
    appendChunk.mockResolvedValueOnce({
      ok: false,
      code: "upload_chunk_conflict",
      message: "conflict",
      chunkIndex: 1,
    });
    const conflict = await chunkRoute.request(
      `/${SESSION}/chunks/1`,
      {
        method: "PUT",
        headers: { "x-import-chunk-offset": "5242880" },
        body: new Uint8Array([1]),
      },
      env() as never,
    );
    expect(conflict.status).toBe(409);

    appendChunk.mockResolvedValueOnce({
      ok: false,
      code: "upload_session_expired",
      message: "expired",
      expiredAt: "2026-07-16T00:00:00.000Z",
    });
    const expired = await chunkRoute.request(
      `/${SESSION}/chunks/1`,
      {
        method: "PUT",
        headers: { "x-import-chunk-offset": "5242880" },
        body: new Uint8Array([1]),
      },
      env() as never,
    );
    expect(expired.status).toBe(410);
  });

  test("returns 404 when the session is not visible to the caller", async () => {
    appendChunk.mockResolvedValue(undefined);
    const res = await chunkRoute.request(
      `/${SESSION}/chunks/0`,
      {
        method: "PUT",
        headers: { "x-import-chunk-offset": "0" },
        body: new Uint8Array([1]),
      },
      env() as never,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET/DELETE /api/v1/imports/uploads/:sessionId", () => {
  test("returns resume state through the caller organization scope", async () => {
    getUploadStatus.mockImplementation(
      async (organizationId: string, sessionId: string) =>
        organizationId === ORG && sessionId === SESSION
          ? sessionDto({
              missingRanges: [
                { start: 5_242_880, endExclusive: 10_485_760, chunkIndex: 1 },
              ],
            })
          : undefined,
    );
    const res = await sessionRoute.request(`/${SESSION}`, {}, env() as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { missingRanges: unknown[] };
    };
    expect(body.session.missingRanges).toHaveLength(1);
  });

  test("cross-tenant status access fails with 404", async () => {
    requireUserOrApiKeyWithOrg.mockResolvedValueOnce({
      id: USER,
      organization_id: OTHER_ORG,
      is_active: true,
    });
    getUploadStatus.mockResolvedValue(undefined);
    const res = await sessionRoute.request(`/${SESSION}`, {}, env() as never);
    expect(res.status).toBe(404);
    expect(getUploadStatus).toHaveBeenCalledWith(OTHER_ORG, SESSION);
  });

  test("abort returns the terminal session state", async () => {
    abortUpload.mockResolvedValue({
      ok: true,
      sessionId: SESSION,
      status: "aborted",
    });
    const res = await sessionRoute.request(
      `/${SESSION}`,
      { method: "DELETE" },
      env() as never,
    );
    expect(res.status).toBe(200);
    const abortBody = (await res.json()) as Record<string, unknown>;
    expect(abortBody).toEqual({
      success: true,
      sessionId: SESSION,
      status: "aborted",
    });
  });

  test("rejects malformed session ids before service access", async () => {
    const res = await sessionRoute.request("/not-a-uuid", {}, env() as never);
    expect(res.status).toBe(400);
    expect(getUploadStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/imports/uploads/:sessionId/complete", () => {
  test("maps interrupted uploads to 409 with the exact missing ranges", async () => {
    completeUpload.mockResolvedValue({
      ok: false,
      code: "upload_interrupted",
      message: "missing chunks",
      receivedBytes: 5_242_880,
      uploadBytes: 12_582_912,
      missingRanges: [
        { start: 5_242_880, endExclusive: 10_485_760, chunkIndex: 1 },
        { start: 10_485_760, endExclusive: 12_582_912, chunkIndex: 2 },
      ],
    });
    const res = await completeRoute.request(
      `/${SESSION}/complete`,
      { method: "POST" },
      env() as never,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      details: { missingRanges: unknown[] };
    };
    expect(body.code).toBe("upload_interrupted");
    expect(body.details.missingRanges).toHaveLength(2);
  });

  test("returns the batch and retention-tracked raw artifact on success", async () => {
    completeUpload.mockResolvedValue({
      ok: true,
      batch: batchDto({ status: "uploaded" }),
      artifact: {
        id: "00000000-0000-4000-8000-0000000000ff",
        batchId: BATCH,
        kind: "raw-upload",
        sha256: SHA,
        byteLength: 12_582_912,
        contentType: "application/zip",
        storageKey: `conversation-imports/${ORG}/apps/default/batches/${BATCH}/raw-upload/${SHA}.zip`,
        retention: {
          mode: "short-lived",
          expiresAt: "2026-07-16T00:00:00.000Z",
        },
        status: "active",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    });
    const res = await completeRoute.request(
      `/${SESSION}/complete`,
      { method: "POST" },
      env() as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { retention: { mode: string } };
      batch: { status: string };
    };
    expect(body.batch.status).toBe("uploaded");
    expect(body.artifact.retention.mode).toBe("short-lived");
  });
});

describe("POST /api/v1/imports/uploads/direct", () => {
  test("uploads a small export and returns the content-addressed artifact", async () => {
    directUpload.mockResolvedValue({
      ok: true,
      batch: batchDto({ status: "uploaded" }),
      artifact: {
        id: "00000000-0000-4000-8000-0000000000ff",
        batchId: BATCH,
        kind: "raw-upload",
        sha256: SHA,
        byteLength: 11,
        contentType: "application/json",
        storageKey: `conversation-imports/${ORG}/apps/default/batches/${BATCH}/raw-upload/${SHA}.json`,
        retention: {
          mode: "short-lived",
          expiresAt: "2026-07-16T00:00:00.000Z",
        },
        status: "active",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    });
    const form = new FormData();
    form.append(
      "file",
      new File(['{"a": true}'], "conversations.json", {
        type: "application/json",
      }),
    );
    form.append("source", "chatgpt");
    const res = await directRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );
    expect(res.status).toBe(201);
    const directArg = directUpload.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(directArg.organizationId).toBe(ORG);
    expect(directArg.source).toBe("chatgpt");
    expect((directArg.bytes as Uint8Array).byteLength).toBe(11);
  });

  test("maps resumable_required to 413 so clients switch transports", async () => {
    directUpload.mockResolvedValue({
      ok: false,
      code: "resumable_required",
      message: "use resumable",
      limit: 26_214_400,
      observed: 100_000_000,
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["x"], "big.json", { type: "application/json" }),
    );
    form.append("source", "chatgpt");
    const res = await directRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("resumable_required");
  });

  test("requires a file field", async () => {
    const form = new FormData();
    form.append("source", "chatgpt");
    const res = await directRoute.request(
      "/",
      { method: "POST", body: form },
      env() as never,
    );
    expect(res.status).toBe(400);
    expect(directUpload).not.toHaveBeenCalled();
  });
});

describe("/api/v1/imports/batches", () => {
  test("lists batches scoped to the authenticated organization", async () => {
    listBatches.mockResolvedValue({
      items: [batchDto()],
      hasMore: true,
      limit: 1,
      offset: 0,
    });
    const res = await batchesRoute.request("/?limit=1", {}, env() as never);
    expect(res.status).toBe(200);
    expect(listBatches).toHaveBeenCalledWith(ORG, { limit: 1, offset: 0 });
    const body = (await res.json()) as {
      batches: unknown[];
      pagination: { nextOffset: number | null };
    };
    expect(body.batches).toHaveLength(1);
    expect(body.pagination.nextOffset).toBe(1);
  });

  test("returns batch details with artifacts, 404 across tenants", async () => {
    getBatch.mockImplementation(
      async (organizationId: string, batchId: string) =>
        organizationId === ORG && batchId === BATCH
          ? { batch: batchDto(), artifacts: [] }
          : undefined,
    );
    const found = await batchRoute.request(`/${BATCH}`, {}, env() as never);
    expect(found.status).toBe(200);

    requireUserOrApiKeyWithOrg.mockResolvedValueOnce({
      id: USER,
      organization_id: OTHER_ORG,
      is_active: true,
    });
    const missing = await batchRoute.request(`/${BATCH}`, {}, env() as never);
    expect(missing.status).toBe(404);
    expect(getBatch).toHaveBeenLastCalledWith(OTHER_ORG, BATCH);
  });

  test("delete returns the per-artifact report and surfaces failures", async () => {
    deleteBatch.mockResolvedValue({
      batchId: BATCH,
      deleted: [{ artifactId: "a1", storageKey: "k1" }],
      failed: [{ artifactId: "a2", storageKey: "k2", error: "boom" }],
      sessionsAborted: 1,
      batchDeleted: false,
    });
    const res = await batchRoute.request(
      `/${BATCH}`,
      { method: "DELETE" },
      env() as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      report: { failed: unknown[] };
    };
    expect(body.success).toBe(false);
    expect(body.report.failed).toHaveLength(1);
  });
});

describe("GET /api/cron/cleanup-expired-import-uploads", () => {
  test("runs the retention sweep behind the cron secret", async () => {
    purgeExpired.mockResolvedValue({
      purgedArtifacts: 3,
      abortedSessions: 1,
      failures: [],
    });
    const res = await cronRoute.request("/", {}, env() as never);
    expect(res.status).toBe(200);
    expect(requireCronSecret).toHaveBeenCalled();
    const body = (await res.json()) as {
      stats: { purgedArtifacts: number; abortedSessions: number };
    };
    expect(body.stats.purgedArtifacts).toBe(3);
    expect(body.stats.abortedSessions).toBe(1);
  });
});
