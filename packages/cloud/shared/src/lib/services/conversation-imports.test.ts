// Exercises the conversation-import cloud path (#13432) with deterministic in-memory storage/repo fixtures.

import { beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type {
  ImportArtifactRow,
  ImportBatch,
  ImportUploadSessionRow,
  NewImportArtifactRow,
  NewImportBatch,
  NewImportUploadSessionRow,
} from "../../db/repositories/conversation-imports";
import type {
  RuntimeR2MultipartUpload,
  RuntimeR2UploadedPart,
} from "../storage/r2-runtime-binding";
import {
  ConversationImportsService,
  IMPORT_MIN_CHUNK_BYTES,
  importConfigFromEnv,
} from "./conversation-imports";

const MiB = 1024 * 1024;
const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000bb";
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-09T00:00:00Z");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkPattern(byteLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.fill(seed % 251);
  return bytes;
}

// ---------------------------------------------------------------------------
// In-memory fakes: repositories, tenant quota, R2 bucket with multipart.
// ---------------------------------------------------------------------------

function makeQuota(limitBytes: bigint) {
  const state = { bytes_used: 0n, bytes_limit: limitBytes };
  return {
    state,
    async findByOrganization(_organizationId: string) {
      return { bytes_used: state.bytes_used, bytes_limit: state.bytes_limit };
    },
    async tryReserveBytes(_organizationId: string, bytes: bigint) {
      if (state.bytes_used + bytes > state.bytes_limit) return null;
      state.bytes_used += bytes;
      return state.bytes_used;
    },
    async releaseBytes(_organizationId: string, bytes: bigint) {
      state.bytes_used = state.bytes_used - bytes < 0n ? 0n : state.bytes_used - bytes;
    },
  };
}

function makeBatchesRepo(now: () => Date) {
  const rows = new Map<string, ImportBatch>();
  return {
    rows,
    async create(data: NewImportBatch): Promise<ImportBatch> {
      const row: ImportBatch = {
        id: data.id ?? randomUUID(),
        organization_id: data.organization_id,
        user_id: data.user_id ?? null,
        api_key_id: data.api_key_id ?? null,
        app_id: data.app_id,
        source: data.source,
        status: data.status ?? "uploading",
        upload_bytes: data.upload_bytes,
        reserved_bytes: data.reserved_bytes,
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
      };
      rows.set(row.id, row);
      return row;
    },
    async findByOrgAndId(organizationId: string, id: string) {
      const row = rows.get(id);
      return row && row.organization_id === organizationId ? { ...row } : undefined;
    },
    async listByOrganization(
      organizationId: string,
      options: { limit?: number; offset?: number } = {},
    ) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const offset = Math.max(options.offset ?? 0, 0);
      const all = [...rows.values()]
        .filter((row) => row.organization_id === organizationId)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const page = all.slice(offset, offset + limit + 1);
      return {
        items: page.slice(0, limit),
        hasMore: page.length > limit,
        limit,
        offset,
      };
    },
    async transitionStatus(
      organizationId: string,
      id: string,
      fromStatuses: string[],
      toStatus: string,
      extra: Partial<Pick<NewImportBatch, "reserved_bytes" | "deleted_at">> = {},
    ) {
      const row = rows.get(id);
      if (!row || row.organization_id !== organizationId || !fromStatuses.includes(row.status)) {
        return undefined;
      }
      const next: ImportBatch = {
        ...row,
        status: toStatus,
        updated_at: now(),
        ...(extra.reserved_bytes !== undefined && {
          reserved_bytes: extra.reserved_bytes,
        }),
        ...(extra.deleted_at !== undefined && { deleted_at: extra.deleted_at }),
      };
      rows.set(id, next);
      return { ...next };
    },
  };
}

function makeSessionsRepo(now: () => Date) {
  const rows = new Map<string, ImportUploadSessionRow>();
  let casFailuresToInject = 0;
  return {
    rows,
    injectCasFailures(count: number) {
      casFailuresToInject = count;
    },
    async create(data: NewImportUploadSessionRow): Promise<ImportUploadSessionRow> {
      const row: ImportUploadSessionRow = {
        id: data.id ?? randomUUID(),
        organization_id: data.organization_id,
        batch_id: data.batch_id,
        filename: data.filename,
        content_type: data.content_type,
        declared_sha256: data.declared_sha256,
        upload_bytes: data.upload_bytes,
        chunk_size: data.chunk_size,
        chunk_count: data.chunk_count,
        status: data.status ?? "open",
        multipart_upload_id: data.multipart_upload_id,
        storage_key: data.storage_key,
        session_state: data.session_state,
        part_etags: data.part_etags ?? {},
        retain_raw: data.retain_raw ?? false,
        retain_reason: data.retain_reason ?? null,
        expires_at: data.expires_at,
        created_at: now(),
        updated_at: now(),
      };
      rows.set(row.id, row);
      return row;
    },
    async findByOrgAndId(organizationId: string, id: string) {
      const row = rows.get(id);
      return row && row.organization_id === organizationId ? structuredClone(row) : undefined;
    },
    async findOpenByBatch(organizationId: string, batchId: string) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.organization_id === organizationId &&
            row.batch_id === batchId &&
            row.status === "open",
        )
        .map((row) => structuredClone(row));
    },
    async compareAndSwapState(
      organizationId: string,
      id: string,
      expectedStateUpdatedAt: number,
      update: {
        sessionState: Record<string, unknown>;
        partEtags: Record<string, string>;
        status: string;
      },
    ) {
      if (casFailuresToInject > 0) {
        casFailuresToInject -= 1;
        return undefined;
      }
      const row = rows.get(id);
      if (
        !row ||
        row.organization_id !== organizationId ||
        row.status !== "open" ||
        Number(row.session_state.updatedAt) !== expectedStateUpdatedAt
      ) {
        return undefined;
      }
      const next: ImportUploadSessionRow = {
        ...row,
        session_state: update.sessionState,
        part_etags: update.partEtags,
        status: update.status,
        updated_at: now(),
      };
      rows.set(id, next);
      return structuredClone(next);
    },
    async transitionStatus(
      organizationId: string,
      id: string,
      fromStatuses: string[],
      toStatus: string,
    ) {
      const row = rows.get(id);
      if (!row || row.organization_id !== organizationId || !fromStatuses.includes(row.status)) {
        return undefined;
      }
      const next = { ...row, status: toStatus, updated_at: now() };
      rows.set(id, next);
      return structuredClone(next);
    },
    async findExpiredOpen(nowDate: Date, limit: number) {
      return [...rows.values()]
        .filter((row) => row.status === "open" && row.expires_at.getTime() <= nowDate.getTime())
        .slice(0, limit)
        .map((row) => structuredClone(row));
    },
  };
}

function makeArtifactsRepo(now: () => Date) {
  const rows = new Map<string, ImportArtifactRow>();
  return {
    rows,
    async create(data: NewImportArtifactRow): Promise<ImportArtifactRow> {
      const row: ImportArtifactRow = {
        id: data.id ?? randomUUID(),
        organization_id: data.organization_id,
        batch_id: data.batch_id,
        kind: data.kind,
        sha256: data.sha256,
        byte_length: data.byte_length,
        content_type: data.content_type,
        storage_key: data.storage_key,
        retention_mode: data.retention_mode,
        retain_reason: data.retain_reason ?? null,
        expires_at: data.expires_at ?? null,
        status: data.status ?? "active",
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
      };
      rows.set(row.id, row);
      return { ...row };
    },
    async findActiveByOrgAndId(organizationId: string, id: string) {
      const row = rows.get(id);
      return row && row.organization_id === organizationId && row.status === "active"
        ? { ...row }
        : undefined;
    },
    async findActiveByBatchAndKey(organizationId: string, batchId: string, storageKey: string) {
      for (const row of rows.values()) {
        if (
          row.organization_id === organizationId &&
          row.batch_id === batchId &&
          row.storage_key === storageKey &&
          row.status === "active"
        ) {
          return { ...row };
        }
      }
      return undefined;
    },
    async listActiveByBatch(organizationId: string, batchId: string) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.organization_id === organizationId &&
            row.batch_id === batchId &&
            row.status === "active",
        )
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((row) => ({ ...row }));
    },
    async softDeleteByOrgAndId(organizationId: string, id: string) {
      const row = rows.get(id);
      if (!row || row.organization_id !== organizationId || row.status !== "active") {
        return undefined;
      }
      const next: ImportArtifactRow = {
        ...row,
        status: "deleted",
        deleted_at: now(),
        updated_at: now(),
      };
      rows.set(id, next);
      return { ...next };
    },
    async findExpiredActive(nowDate: Date, limit: number) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.status === "active" &&
            row.retention_mode === "short-lived" &&
            row.expires_at !== null &&
            row.expires_at.getTime() <= nowDate.getTime(),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
  };
}

interface FakeMultipartState {
  key: string;
  uploadId: string;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
  completed: boolean;
  aborted: boolean;
}

function makeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const multiparts = new Map<string, FakeMultipartState>();
  const failDeleteKeys = new Set<string>();
  let uploadPartCalls = 0;

  function handle(state: FakeMultipartState): RuntimeR2MultipartUpload {
    return {
      key: state.key,
      uploadId: state.uploadId,
      async uploadPart(partNumber: number, value) {
        if (state.completed || state.aborted) {
          throw new Error("multipart upload is no longer active");
        }
        uploadPartCalls += 1;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
        const etag = sha256Hex(bytes).slice(0, 32);
        state.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      async complete(uploadedParts: RuntimeR2UploadedPart[]) {
        if (state.aborted) throw new Error("multipart upload aborted");
        if (state.completed) throw new Error("multipart upload already completed");
        const ordered = [...uploadedParts].sort((a, b) => a.partNumber - b.partNumber);
        let total = 0;
        for (const part of ordered) {
          const stored = state.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error(`part ${part.partNumber} missing or etag mismatch`);
          }
          total += stored.bytes.byteLength;
        }
        const assembled = new Uint8Array(total);
        let cursor = 0;
        for (const part of ordered) {
          const stored = state.parts.get(part.partNumber);
          if (!stored) throw new Error("unreachable");
          assembled.set(stored.bytes, cursor);
          cursor += stored.bytes.byteLength;
        }
        state.completed = true;
        objects.set(state.key, { bytes: assembled, customMetadata: {} });
        return { key: state.key };
      },
      async abort() {
        if (state.completed) throw new Error("multipart upload already completed");
        state.aborted = true;
        return undefined;
      },
    };
  }

  return {
    objects,
    multiparts,
    failDeleteKeys,
    get uploadPartCalls() {
      return uploadPartCalls;
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        async text() {
          return new TextDecoder().decode(object.bytes);
        },
      };
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | Blob | null,
      options?: { customMetadata?: Record<string, string> },
    ) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : typeof value === "string"
            ? new TextEncoder().encode(value)
            : new Uint8Array(value as ArrayBuffer);
      objects.set(key, {
        bytes,
        customMetadata: options?.customMetadata ?? {},
      });
      return undefined;
    },
    async delete(key: string) {
      if (failDeleteKeys.has(key)) {
        throw new Error(`injected delete failure for ${key}`);
      }
      objects.delete(key);
      return undefined;
    },
    async createMultipartUpload(
      key: string,
      _options?: { customMetadata?: Record<string, string> },
    ) {
      const state: FakeMultipartState = {
        key,
        uploadId: randomUUID(),
        parts: new Map(),
        completed: false,
        aborted: false,
      };
      multiparts.set(state.uploadId, state);
      return handle(state);
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const state = multiparts.get(uploadId);
      if (!state || state.key !== key) {
        throw new Error("unknown multipart upload");
      }
      return handle(state);
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let nowMs = T0;
const now = () => new Date(nowMs);
let quota = makeQuota(5n * 1024n * 1024n * 1024n);
let batches = makeBatchesRepo(now);
let sessions = makeSessionsRepo(now);
let artifacts = makeArtifactsRepo(now);
let bucket = makeBucket();
let service = new ConversationImportsService(
  batches as never,
  sessions as never,
  artifacts as never,
  quota,
  now,
);

function env(overrides: Record<string, string> = {}) {
  return { BLOB: bucket, ...overrides } as never;
}

beforeEach(() => {
  nowMs = T0;
  quota = makeQuota(5n * 1024n * 1024n * 1024n);
  batches = makeBatchesRepo(now);
  sessions = makeSessionsRepo(now);
  artifacts = makeArtifactsRepo(now);
  bucket = makeBucket();
  service = new ConversationImportsService(
    batches as never,
    sessions as never,
    artifacts as never,
    quota,
    now,
  );
});

async function initSession(input: {
  uploadBytes: number;
  chunkSize?: number;
  retainRawUpload?: boolean;
  retainReason?: string;
  declaredSha256?: string;
  envOverrides?: Record<string, string>;
}) {
  const result = await service.initResumableUpload(env(input.envOverrides ?? {}), {
    organizationId: ORG,
    userId: USER,
    source: "chatgpt",
    filename: "export.zip",
    contentType: "application/zip",
    uploadBytes: input.uploadBytes,
    chunkSize: input.chunkSize ?? IMPORT_MIN_CHUNK_BYTES,
    declaredSha256: input.declaredSha256 ?? sha256Hex(chunkPattern(8, 1)),
    ...(input.retainRawUpload !== undefined && {
      retainRawUpload: input.retainRawUpload,
    }),
    ...(input.retainReason !== undefined && {
      retainReason: input.retainReason,
    }),
  });
  if (!result.ok) throw new Error(`init failed: ${JSON.stringify(result)}`);
  return result;
}

async function uploadWholeFile(uploadBytes: number, chunkSize: number) {
  const init = await initSession({ uploadBytes, chunkSize });
  const data = chunkPattern(uploadBytes, 7);
  const chunkCount = Math.ceil(uploadBytes / chunkSize);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize;
    const chunk = data.slice(start, Math.min(start + chunkSize, uploadBytes));
    const appended = await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: index,
      offset: start,
      bytes: chunk,
    });
    if (!appended || !appended.ok) {
      throw new Error(`append failed: ${JSON.stringify(appended)}`);
    }
  }
  return { init, data };
}

// ---------------------------------------------------------------------------
// Preflight: quota/size admission before any bytes
// ---------------------------------------------------------------------------

describe("preflight", () => {
  test("admits a small upload on the direct path and echoes the ceilings", async () => {
    const decision = await service.preflight(env(), {
      organizationId: ORG,
      uploadBytes: 1 * MiB,
    });
    expect(decision).toMatchObject({
      ok: true,
      requiresResumable: false,
      maxDirectUploadBytes: 25 * MiB,
      maxResumableUploadBytes: 1024 * MiB,
      minChunkBytes: IMPORT_MIN_CHUNK_BYTES,
    });
  });

  test("routes a 100MB-class import to the resumable path", async () => {
    const decision = await service.preflight(env(), {
      organizationId: ORG,
      uploadBytes: 300 * MiB,
    });
    expect(decision).toMatchObject({ ok: true, requiresResumable: true });
  });

  test("rejects an upload past the hard ceiling with the crossed limit", async () => {
    const decision = await service.preflight(env(), {
      organizationId: ORG,
      uploadBytes: 1025 * MiB,
    });
    expect(decision).toEqual({
      ok: false,
      code: "upload_too_large",
      message: expect.stringContaining("exceeds"),
      limit: 1024 * MiB,
      observed: 1025 * MiB,
    });
  });

  test("rejects when the tenant storage quota cannot fit the import", async () => {
    quota.state.bytes_used = quota.state.bytes_limit - BigInt(10 * MiB);
    const decision = await service.preflight(env(), {
      organizationId: ORG,
      uploadBytes: 20 * MiB,
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "quota_storage_exceeded",
      limit: 10 * MiB,
      observed: 20 * MiB,
    });
  });

  test("fails fast on embedding cost overrun when the ceiling is configured", async () => {
    const decision = await service.preflight(env({ IMPORT_MAX_EMBEDDING_UNITS: "1000" }), {
      organizationId: ORG,
      uploadBytes: 1 * MiB,
      embeddingUnits: 5000,
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "quota_embedding_exceeded",
      limit: 1000,
      observed: 5000,
    });
  });

  test("fails fast on conversation-count overrun when configured", async () => {
    const decision = await service.preflight(env({ IMPORT_MAX_CONVERSATIONS: "100" }), {
      organizationId: ORG,
      uploadBytes: 1 * MiB,
      conversationCount: 250,
    });
    expect(decision).toMatchObject({
      ok: false,
      code: "quota_conversations_exceeded",
      limit: 100,
      observed: 250,
    });
  });

  test("honors the conservative configurable max upload size", async () => {
    const decision = await service.preflight(
      env({
        IMPORT_MAX_DIRECT_UPLOAD_BYTES: String(1 * MiB),
        IMPORT_MAX_UPLOAD_BYTES: String(10 * MiB),
      }),
      { organizationId: ORG, uploadBytes: 11 * MiB },
    );
    expect(decision).toMatchObject({
      ok: false,
      code: "upload_too_large",
      limit: 10 * MiB,
    });
  });

  test("malformed size configuration fails closed instead of defaulting", () => {
    expect(() => importConfigFromEnv({ IMPORT_MAX_UPLOAD_BYTES: "banana" })).toThrow(
      "IMPORT_MAX_UPLOAD_BYTES",
    );
    expect(() =>
      importConfigFromEnv({
        IMPORT_MAX_DIRECT_UPLOAD_BYTES: String(2 * MiB),
        IMPORT_MAX_UPLOAD_BYTES: String(1 * MiB),
      }),
    ).toThrow("must not exceed");
  });
});

// ---------------------------------------------------------------------------
// Resumable upload lifecycle
// ---------------------------------------------------------------------------

describe("resumable upload lifecycle", () => {
  test("init reserves quota and opens a tenant-scoped multipart session", async () => {
    const uploadBytes = 12 * MiB;
    const init = await initSession({ uploadBytes });
    expect(quota.state.bytes_used).toBe(BigInt(uploadBytes));
    expect(init.session.chunkCount).toBe(3);
    expect(init.session.status).toBe("open");
    expect(init.session.missingRanges).toHaveLength(3);
    expect(init.session.progress.receivedBytes).toBe(0);
    const storedSession = sessions.rows.get(init.session.sessionId);
    expect(storedSession?.storage_key).toStartWith(
      `conversation-imports/${ORG}/apps/default/batches/${init.batch.id}/raw-upload/`,
    );
    expect(bucket.multiparts.size).toBe(1);
    const batchRow = batches.rows.get(init.batch.id);
    expect(batchRow?.status).toBe("uploading");
    expect(batchRow?.reserved_bytes).toBe(BigInt(uploadBytes));
  });

  test("init refuses a chunk size below the R2 multipart minimum", async () => {
    await expect(
      service.initResumableUpload(env(), {
        organizationId: ORG,
        source: "chatgpt",
        filename: "export.zip",
        contentType: "application/zip",
        uploadBytes: 12 * MiB,
        chunkSize: 1 * MiB,
        declaredSha256: sha256Hex(chunkPattern(8, 1)),
      }),
    ).rejects.toThrow("chunkSize");
    expect(quota.state.bytes_used).toBe(0n);
    expect(batches.rows.size).toBe(0);
  });

  test("init refuses explicit raw retention without a reason", async () => {
    await expect(
      service.initResumableUpload(env(), {
        organizationId: ORG,
        source: "chatgpt",
        filename: "export.zip",
        contentType: "application/zip",
        uploadBytes: 12 * MiB,
        chunkSize: IMPORT_MIN_CHUNK_BYTES,
        declaredSha256: sha256Hex(chunkPattern(8, 1)),
        retainRawUpload: true,
      }),
    ).rejects.toThrow("retainReason");
  });

  test("init returns a typed quota failure when reservation loses the race", async () => {
    quota.state.bytes_used = quota.state.bytes_limit;
    const result = await service.initResumableUpload(env(), {
      organizationId: ORG,
      source: "chatgpt",
      filename: "export.zip",
      contentType: "application/zip",
      uploadBytes: 12 * MiB,
      chunkSize: IMPORT_MIN_CHUNK_BYTES,
      declaredSha256: sha256Hex(chunkPattern(8, 1)),
    });
    expect(result).toMatchObject({ ok: false, code: "quota_storage_exceeded" });
    expect(batches.rows.size).toBe(0);
    expect(sessions.rows.size).toBe(0);
  });

  test("chunks assemble into the declared raw object with short retention by default", async () => {
    const uploadBytes = 12 * MiB;
    const { init, data } = await uploadWholeFile(uploadBytes, IMPORT_MIN_CHUNK_BYTES);
    const completed = await service.completeUpload(env(), ORG, init.session.sessionId);
    expect(completed).toBeDefined();
    if (!completed || !completed.ok) throw new Error("complete failed");
    expect(completed.batch.status).toBe("uploaded");
    expect(completed.artifact.kind).toBe("raw-upload");
    expect(completed.artifact.byteLength).toBe(uploadBytes);
    expect(completed.artifact.retention).toEqual({
      mode: "short-lived",
      expiresAt: new Date(T0 + 7 * DAY_MS).toISOString(),
    });
    // The bytes in the object store are exactly the upload — never truncated.
    const object = bucket.objects.get(completed.artifact.storageKey);
    expect(object).toBeDefined();
    expect(object?.bytes.byteLength).toBe(uploadBytes);
    expect(sha256Hex(object?.bytes ?? new Uint8Array())).toBe(sha256Hex(data));
    // Reservation transferred from the batch to the artifact charge.
    expect(batches.rows.get(init.batch.id)?.reserved_bytes).toBe(0n);
    expect(quota.state.bytes_used).toBe(BigInt(uploadBytes));
  });

  test("duplicate chunk retry is idempotent and skips a second store write", async () => {
    const init = await initSession({ uploadBytes: 12 * MiB });
    const chunk = chunkPattern(IMPORT_MIN_CHUNK_BYTES, 3);
    const first = await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: chunk,
    });
    expect(first).toMatchObject({ ok: true, status: "accepted" });
    const partsAfterFirst = bucket.uploadPartCalls;
    const retry = await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: chunk,
    });
    expect(retry).toMatchObject({ ok: true, status: "duplicate" });
    expect(bucket.uploadPartCalls).toBe(partsAfterFirst);
  });

  test("a chunk retry with different bytes is a typed conflict, not silent corruption", async () => {
    const init = await initSession({ uploadBytes: 12 * MiB });
    await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: chunkPattern(IMPORT_MIN_CHUNK_BYTES, 3),
    });
    const conflict = await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: chunkPattern(IMPORT_MIN_CHUNK_BYTES, 4),
    });
    expect(conflict).toEqual({
      ok: false,
      code: "upload_chunk_conflict",
      message: expect.stringContaining("chunk 0"),
      chunkIndex: 0,
    });
  });

  test("wrong offsets, wrong lengths, and digest mismatches are rejected", async () => {
    const init = await initSession({ uploadBytes: 12 * MiB });
    const chunk = chunkPattern(IMPORT_MIN_CHUNK_BYTES, 3);
    await expect(
      service.appendChunk(env(), {
        organizationId: ORG,
        sessionId: init.session.sessionId,
        chunkIndex: 1,
        offset: 0,
        bytes: chunk,
      }),
    ).rejects.toThrow("offset");
    await expect(
      service.appendChunk(env(), {
        organizationId: ORG,
        sessionId: init.session.sessionId,
        chunkIndex: 0,
        offset: 0,
        bytes: chunk.slice(0, 1024),
      }),
    ).rejects.toThrow("length");
    await expect(
      service.appendChunk(env(), {
        organizationId: ORG,
        sessionId: init.session.sessionId,
        chunkIndex: 0,
        offset: 0,
        bytes: chunk,
        sha256: sha256Hex(chunkPattern(8, 9)),
      }),
    ).rejects.toThrow("sha256");
  });

  test("interrupted uploads resume from reported missing ranges and never complete partial", async () => {
    const uploadBytes = 12 * MiB;
    const init = await initSession({ uploadBytes });
    const data = chunkPattern(uploadBytes, 7);
    await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: data.slice(0, IMPORT_MIN_CHUNK_BYTES),
    });

    // The client crashed; a new client asks where to resume.
    const status = await service.getUploadStatus(ORG, init.session.sessionId);
    expect(status?.progress.receivedChunks).toBe(1);
    expect(status?.missingRanges).toEqual([
      {
        start: IMPORT_MIN_CHUNK_BYTES,
        endExclusive: 2 * IMPORT_MIN_CHUNK_BYTES,
        chunkIndex: 1,
      },
      {
        start: 2 * IMPORT_MIN_CHUNK_BYTES,
        endExclusive: uploadBytes,
        chunkIndex: 2,
      },
    ]);

    // Completing now must fail with the exact missing ranges — not truncate.
    const premature = await service.completeUpload(env(), ORG, init.session.sessionId);
    expect(premature).toMatchObject({
      ok: false,
      code: "upload_interrupted",
      receivedBytes: IMPORT_MIN_CHUNK_BYTES,
      uploadBytes,
    });
    if (!premature || premature.ok !== false) throw new Error("unreachable");
    if (premature.code !== "upload_interrupted") throw new Error("unreachable");
    expect(premature.missingRanges).toHaveLength(2);
    expect(bucket.objects.size).toBe(0);

    // Resume exactly the missing ranges, then complete.
    for (const range of premature.missingRanges) {
      const appended = await service.appendChunk(env(), {
        organizationId: ORG,
        sessionId: init.session.sessionId,
        chunkIndex: range.chunkIndex,
        offset: range.start,
        bytes: data.slice(range.start, range.endExclusive),
      });
      expect(appended).toMatchObject({ ok: true, status: "accepted" });
    }
    const completed = await service.completeUpload(env(), ORG, init.session.sessionId);
    expect(completed).toMatchObject({ ok: true });
  });

  test("concurrent chunk appends reconcile through the core merge primitive", async () => {
    const init = await initSession({ uploadBytes: 12 * MiB });
    sessions.injectCasFailures(1);
    const result = await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: chunkPattern(IMPORT_MIN_CHUNK_BYTES, 3),
    });
    expect(result).toMatchObject({ ok: true, status: "accepted" });
    const stored = sessions.rows.get(init.session.sessionId);
    expect(Object.keys(stored?.session_state.chunks ?? {})).toEqual(["0"]);
  });

  test("complete retry after success is idempotent", async () => {
    const { init } = await uploadWholeFile(10 * MiB, IMPORT_MIN_CHUNK_BYTES);
    const first = await service.completeUpload(env(), ORG, init.session.sessionId);
    const second = await service.completeUpload(env(), ORG, init.session.sessionId);
    if (!first?.ok || !second?.ok) throw new Error("complete failed");
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(artifacts.rows.size).toBe(1);
    expect(bucket.objects.size).toBe(1);
  });

  test("abort releases the reserved quota and tears down the multipart upload", async () => {
    const uploadBytes = 12 * MiB;
    const init = await initSession({ uploadBytes });
    expect(quota.state.bytes_used).toBe(BigInt(uploadBytes));
    const aborted = await service.abortUpload(env(), ORG, init.session.sessionId);
    expect(aborted).toEqual({
      ok: true,
      sessionId: init.session.sessionId,
      status: "aborted",
    });
    expect(quota.state.bytes_used).toBe(0n);
    expect([...bucket.multiparts.values()].every((state) => state.aborted)).toBe(true);
    expect(batches.rows.get(init.batch.id)?.status).toBe("aborted");
    // Idempotent retry.
    const again = await service.abortUpload(env(), ORG, init.session.sessionId);
    expect(again).toMatchObject({ ok: true, status: "aborted" });
    expect(quota.state.bytes_used).toBe(0n);
  });

  test("an expired session fails typed, aborts the upload, and releases quota", async () => {
    const uploadBytes = 12 * MiB;
    const init = await initSession({ uploadBytes });
    nowMs = T0 + 7 * DAY_MS + 1;
    const result = await service.appendChunk(env(), {
      organizationId: ORG,
      sessionId: init.session.sessionId,
      chunkIndex: 0,
      offset: 0,
      bytes: chunkPattern(IMPORT_MIN_CHUNK_BYTES, 3),
    });
    expect(result).toEqual({
      ok: false,
      code: "upload_session_expired",
      message: expect.stringContaining("expired"),
      expiredAt: new Date(T0 + 7 * DAY_MS).toISOString(),
    });
    expect(quota.state.bytes_used).toBe(0n);
    expect(sessions.rows.get(init.session.sessionId)?.status).toBe("aborted");
  });

  test("100MB-class declared uploads track progress without buffering the whole file", async () => {
    const uploadBytes = 300 * MiB;
    const chunkSize = 8 * MiB;
    const init = await initSession({ uploadBytes, chunkSize });
    expect(init.session.chunkCount).toBe(Math.ceil(uploadBytes / chunkSize));
    for (let index = 0; index < 2; index += 1) {
      const appended = await service.appendChunk(env(), {
        organizationId: ORG,
        sessionId: init.session.sessionId,
        chunkIndex: index,
        offset: index * chunkSize,
        bytes: chunkPattern(chunkSize, index + 1),
      });
      expect(appended).toMatchObject({ ok: true, status: "accepted" });
    }
    const status = await service.getUploadStatus(ORG, init.session.sessionId);
    expect(status?.progress).toEqual({
      receivedBytes: 2 * chunkSize,
      uploadBytes,
      receivedChunks: 2,
      chunkCount: Math.ceil(uploadBytes / chunkSize),
      complete: false,
    });
    expect(status?.missingRanges).toHaveLength(Math.ceil(uploadBytes / chunkSize) - 2);
  });
});

// ---------------------------------------------------------------------------
// Direct upload path
// ---------------------------------------------------------------------------

describe("direct upload", () => {
  test("stores a small export content-addressed with short retention and quota charge", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify([{ title: "hello", messages: [] }]));
    const result = await service.directUpload(env(), {
      organizationId: ORG,
      userId: USER,
      source: "chatgpt",
      filename: "conversations.json",
      contentType: "application/json",
      bytes,
    });
    if (!result.ok) throw new Error("direct upload failed");
    expect(result.artifact.sha256).toBe(sha256Hex(bytes));
    expect(result.artifact.storageKey).toBe(
      `conversation-imports/${ORG}/apps/default/batches/${result.batch.id}/raw-upload/${sha256Hex(bytes)}.json`,
    );
    expect(result.artifact.retention).toEqual({
      mode: "short-lived",
      expiresAt: new Date(T0 + 7 * DAY_MS).toISOString(),
    });
    expect(result.batch.status).toBe("uploaded");
    expect(bucket.objects.has(result.artifact.storageKey)).toBe(true);
    expect(quota.state.bytes_used).toBe(BigInt(bytes.byteLength));
  });

  test("refuses direct uploads past the direct ceiling with a resumable_required DTO", async () => {
    const result = await service.directUpload(
      env({
        IMPORT_MAX_DIRECT_UPLOAD_BYTES: "1024",
        IMPORT_MAX_UPLOAD_BYTES: String(1 * MiB),
      }),
      {
        organizationId: ORG,
        source: "chatgpt",
        filename: "big.json",
        contentType: "application/json",
        bytes: chunkPattern(4096, 5),
      },
    );
    expect(result).toEqual({
      ok: false,
      code: "resumable_required",
      message: expect.stringContaining("resumable"),
      limit: 1024,
      observed: 4096,
    });
    expect(bucket.objects.size).toBe(0);
    expect(quota.state.bytes_used).toBe(0n);
  });

  test("refuses direct uploads that cannot fit the tenant quota", async () => {
    quota.state.bytes_used = quota.state.bytes_limit;
    const result = await service.directUpload(env(), {
      organizationId: ORG,
      source: "chatgpt",
      filename: "conversations.json",
      contentType: "application/json",
      bytes: chunkPattern(1024, 5),
    });
    expect(result).toMatchObject({ ok: false, code: "quota_storage_exceeded" });
    expect(bucket.objects.size).toBe(0);
  });

  test("explicit raw retention requires and records a reason", async () => {
    const bytes = chunkPattern(64, 2);
    const result = await service.directUpload(env(), {
      organizationId: ORG,
      source: "claude",
      filename: "export.json",
      contentType: "application/json",
      bytes,
      retainRawUpload: true,
      retainReason: "compliance hold for support case 1234",
    });
    if (!result.ok) throw new Error("direct upload failed");
    expect(result.artifact.retention).toEqual({
      mode: "explicit-raw-retain",
      reason: "compliance hold for support case 1234",
    });
  });
});

// ---------------------------------------------------------------------------
// Derived artifacts
// ---------------------------------------------------------------------------

describe("derived artifacts", () => {
  test("stores content-addressed derived artifacts tied to the batch lifecycle", async () => {
    const direct = await service.directUpload(env(), {
      organizationId: ORG,
      source: "chatgpt",
      filename: "conversations.json",
      contentType: "application/json",
      bytes: chunkPattern(64, 2),
    });
    if (!direct.ok) throw new Error("direct upload failed");
    const report = JSON.stringify({ imported: 12, skipped: 0 });
    const stored = await service.storeDerivedArtifact(env(), {
      organizationId: ORG,
      batchId: direct.batch.id,
      kind: "import-report",
      contentType: "application/json",
      bytes: report,
      extension: "json",
    });
    if (!stored || !stored.ok) throw new Error("derived store failed");
    expect(stored.artifact.retention).toEqual({
      mode: "batch-lifecycle",
      deleteWithBatch: true,
    });
    expect(stored.artifact.storageKey).toContain("/import-report/");
    expect(stored.artifact.sha256).toBe(sha256Hex(new TextEncoder().encode(report)));
    // Identical content dedupes instead of double-charging.
    const usedAfterFirst = quota.state.bytes_used;
    const again = await service.storeDerivedArtifact(env(), {
      organizationId: ORG,
      batchId: direct.batch.id,
      kind: "import-report",
      contentType: "application/json",
      bytes: report,
      extension: "json",
    });
    if (!again || !again.ok) throw new Error("derived store failed");
    expect(again.artifact.id).toBe(stored.artifact.id);
    expect(quota.state.bytes_used).toBe(usedAfterFirst);
  });

  test("derived artifacts charge tenant storage quota and fail typed on overrun", async () => {
    const direct = await service.directUpload(env(), {
      organizationId: ORG,
      source: "chatgpt",
      filename: "conversations.json",
      contentType: "application/json",
      bytes: chunkPattern(64, 2),
    });
    if (!direct.ok) throw new Error("direct upload failed");
    quota.state.bytes_used = quota.state.bytes_limit;
    const stored = await service.storeDerivedArtifact(env(), {
      organizationId: ORG,
      batchId: direct.batch.id,
      kind: "derived-document",
      contentType: "text/plain",
      bytes: "rendered transcript",
    });
    expect(stored).toMatchObject({ ok: false, code: "quota_storage_exceeded" });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  test("sessions, batches, and deletes are invisible across organizations", async () => {
    const { init } = await uploadWholeFile(10 * MiB, IMPORT_MIN_CHUNK_BYTES);
    expect(await service.getUploadStatus(OTHER_ORG, init.session.sessionId)).toBeUndefined();
    expect(
      await service.appendChunk(env(), {
        organizationId: OTHER_ORG,
        sessionId: init.session.sessionId,
        chunkIndex: 0,
        offset: 0,
        bytes: chunkPattern(IMPORT_MIN_CHUNK_BYTES, 3),
      }),
    ).toBeUndefined();
    expect(await service.completeUpload(env(), OTHER_ORG, init.session.sessionId)).toBeUndefined();
    expect(await service.abortUpload(env(), OTHER_ORG, init.session.sessionId)).toBeUndefined();
    expect(await service.getBatch(OTHER_ORG, init.batch.id)).toBeUndefined();
    expect(await service.deleteBatch(env(), OTHER_ORG, init.batch.id)).toBeUndefined();
    const list = await service.listBatches(OTHER_ORG);
    expect(list.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Batch delete + retention
// ---------------------------------------------------------------------------

describe("batch delete", () => {
  test("removes raw + derived artifacts, releases quota, and reports per-artifact accounting", async () => {
    const { init } = await uploadWholeFile(10 * MiB, IMPORT_MIN_CHUNK_BYTES);
    const completed = await service.completeUpload(env(), ORG, init.session.sessionId);
    if (!completed?.ok) throw new Error("complete failed");
    const derived = await service.storeDerivedArtifact(env(), {
      organizationId: ORG,
      batchId: init.batch.id,
      kind: "derived-manifest",
      contentType: "application/json",
      bytes: JSON.stringify({ documents: ["doc-1"] }),
    });
    if (!derived?.ok) throw new Error("derived store failed");
    expect(bucket.objects.size).toBe(2);
    expect(quota.state.bytes_used).toBeGreaterThan(0n);

    const report = await service.deleteBatch(env(), ORG, init.batch.id);
    expect(report).toBeDefined();
    if (!report) throw new Error("unreachable");
    expect(report.batchDeleted).toBe(true);
    expect(report.failed).toHaveLength(0);
    expect(report.deleted).toHaveLength(2);
    expect(bucket.objects.size).toBe(0);
    expect(quota.state.bytes_used).toBe(0n);
    expect(batches.rows.get(init.batch.id)?.status).toBe("deleted");

    // Idempotent retry: nothing left, still reports the deleted batch.
    const again = await service.deleteBatch(env(), ORG, init.batch.id);
    expect(again).toMatchObject({
      batchDeleted: true,
      deleted: [],
      failed: [],
    });
    expect(quota.state.bytes_used).toBe(0n);
  });

  test("aborts in-flight sessions and releases their reservation on batch delete", async () => {
    const init = await initSession({ uploadBytes: 12 * MiB });
    const report = await service.deleteBatch(env(), ORG, init.batch.id);
    expect(report?.sessionsAborted).toBe(1);
    expect(report?.batchDeleted).toBe(true);
    expect(quota.state.bytes_used).toBe(0n);
    expect(sessions.rows.get(init.session.sessionId)?.status).toBe("aborted");
  });

  test("a failed object delete stays retryable and keeps the batch alive", async () => {
    const { init } = await uploadWholeFile(10 * MiB, IMPORT_MIN_CHUNK_BYTES);
    const completed = await service.completeUpload(env(), ORG, init.session.sessionId);
    if (!completed?.ok) throw new Error("complete failed");
    bucket.failDeleteKeys.add(completed.artifact.storageKey);

    const report = await service.deleteBatch(env(), ORG, init.batch.id);
    expect(report?.batchDeleted).toBe(false);
    expect(report?.failed).toEqual([
      {
        artifactId: completed.artifact.id,
        storageKey: completed.artifact.storageKey,
        error: expect.stringContaining("injected delete failure"),
      },
    ]);
    // Artifact row is still active, so quota is still charged.
    expect(quota.state.bytes_used).toBe(BigInt(10 * MiB));

    bucket.failDeleteKeys.clear();
    const retry = await service.deleteBatch(env(), ORG, init.batch.id);
    expect(retry?.batchDeleted).toBe(true);
    expect(retry?.failed).toHaveLength(0);
    expect(quota.state.bytes_used).toBe(0n);
  });
});

describe("retention sweep", () => {
  test("purges expired short-lived raw uploads and aborts stale sessions", async () => {
    // Completed upload whose raw artifact expires after the default 7 days.
    const { init } = await uploadWholeFile(10 * MiB, IMPORT_MIN_CHUNK_BYTES);
    const completed = await service.completeUpload(env(), ORG, init.session.sessionId);
    if (!completed?.ok) throw new Error("complete failed");
    // A second, in-flight session that will go stale.
    const stale = await initSession({ uploadBytes: 12 * MiB });
    // A young direct upload that must survive the sweep.
    nowMs = T0 + 6 * DAY_MS;
    const young = await service.directUpload(env(), {
      organizationId: ORG,
      source: "claude",
      filename: "fresh.json",
      contentType: "application/json",
      bytes: chunkPattern(128, 9),
    });
    if (!young.ok) throw new Error("direct upload failed");

    nowMs = T0 + 7 * DAY_MS + 1;
    const report = await service.purgeExpired(env());
    expect(report.purgedArtifacts).toBe(1);
    expect(report.abortedSessions).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(bucket.objects.has(completed.artifact.storageKey)).toBe(false);
    expect(bucket.objects.has(young.artifact.storageKey)).toBe(true);
    expect(sessions.rows.get(stale.session.sessionId)?.status).toBe("aborted");
    // Only the young upload's bytes remain charged.
    expect(quota.state.bytes_used).toBe(128n);
  });

  test("explicitly retained raw uploads are not purged", async () => {
    const retained = await service.directUpload(env(), {
      organizationId: ORG,
      source: "claude",
      filename: "hold.json",
      contentType: "application/json",
      bytes: chunkPattern(64, 4),
      retainRawUpload: true,
      retainReason: "legal hold",
    });
    if (!retained.ok) throw new Error("direct upload failed");
    nowMs = T0 + 365 * DAY_MS;
    const report = await service.purgeExpired(env());
    expect(report.purgedArtifacts).toBe(0);
    expect(bucket.objects.has(retained.artifact.storageKey)).toBe(true);
  });

  test("IMPORT_RAW_RETENTION_MS overrides the default raw retention window", async () => {
    const result = await service.directUpload(env({ IMPORT_RAW_RETENTION_MS: String(60_000) }), {
      organizationId: ORG,
      source: "chatgpt",
      filename: "short.json",
      contentType: "application/json",
      bytes: chunkPattern(32, 1),
    });
    if (!result.ok) throw new Error("direct upload failed");
    expect(result.artifact.retention).toEqual({
      mode: "short-lived",
      expiresAt: new Date(T0 + 60_000).toISOString(),
    });
  });
});
