/**
 * Conversation-import cloud path (#13432): quota-aware, resumable, tenant-safe
 * upload handling for conversation exports.
 *
 * This service is the use-case layer behind `/api/v1/imports/*`. It wires the
 * pure `@elizaos/import-conversations` core primitives — the quota/size
 * preflight, the resumable upload session state, and the content-addressed
 * artifact policy — to the cloud's tenant quota repository, Postgres rows, and
 * the R2 multipart upload API. Routes call these methods and return the DTOs
 * unchanged; no business math happens in the route layer.
 *
 * Contract highlights (from #12071, binding for #13432):
 * - tenant quota + size ceilings are enforced BEFORE any bytes are accepted;
 * - imports past the direct ceiling must use resumable chunks (never buffered
 *   whole in Worker memory);
 * - raw uploads are short-lived by default; longer retention is explicit;
 * - derived artifacts are content-addressed and delete with their batch;
 * - an over-limit or interrupted import fails with a typed DTO — it is never
 *   silently truncated into a healthy-looking import.
 */

import { randomUUID } from "node:crypto";
import {
  buildImportArtifactDescriptor,
  DEFAULT_RAW_UPLOAD_RETENTION_MS,
} from "@elizaos/import-conversations/core/artifacts";
import {
  DEFAULT_IMPORT_LIMITS,
  type ImportLimits,
  type ImportUsageEstimate,
  preflightImport,
} from "@elizaos/import-conversations/core/preflight";
import {
  createResumableUploadSession,
  findMissingResumableUploadRanges,
  getResumableUploadProgress,
  mergeResumableUploadSessions,
  type ResumableUploadSession,
  recordResumableChunk,
  resumableSha256Hex,
  validateResumableUploadSession,
} from "@elizaos/import-conversations/core/resumable";
import {
  type ImportArtifactRow,
  type ImportBatch,
  type ImportUploadSessionRow,
  importArtifactsRepository,
  importBatchesRepository,
  importUploadSessionsRepository,
} from "../../db/repositories/conversation-imports";
import {
  DEFAULT_ORG_STORAGE_BYTES_LIMIT,
  orgStorageQuotaRepository,
} from "../../db/repositories/org-storage-quota";
import type { Bindings } from "../../types/cloud-worker-env";
import type {
  ConversationImportFailureDto,
  ImportArtifactDto,
  ImportArtifactRetentionDto,
  ImportBatchDeleteReportDto,
  ImportBatchDto,
  ImportChunkConflictDto,
  ImportChunkResultDto,
  ImportCompleteResultDto,
  ImportDirectUploadResultDto,
  ImportInitResultDto,
  ImportLimitFailureDto,
  ImportPreflightDecisionDto,
  ImportRetentionSweepReportDto,
  ImportSessionExpiredDto,
  ImportUploadInterruptedDto,
  ImportUploadSessionDto,
} from "../../types/conversation-imports";
import { ApiError } from "../api/cloud-worker-errors";
import type { RuntimeR2Bucket, RuntimeR2UploadedPart } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";

const MiB = 1024 * 1024;

/** R2 multipart parts must be at least 5 MiB (all but the last part). */
export const IMPORT_MIN_CHUNK_BYTES = 5 * MiB;
/** Stays under the Workers request-body ceiling with headroom. */
export const IMPORT_MAX_CHUNK_BYTES = 90 * MiB;
/** Chunk size suggested to clients that do not pick their own. */
export const IMPORT_RECOMMENDED_CHUNK_BYTES = 16 * MiB;
/** Rows processed per retention sweep run. */
const RETENTION_SWEEP_BATCH = 100;
/** Bounded optimistic-concurrency retries for concurrent chunk appends. */
const CHUNK_CAS_ATTEMPTS = 3;

/** Mirrors the core artifact policy's safe path-component contract. */
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DEFAULT_APP_ID = "default";

export interface ConversationImportConfig {
  limits: ImportLimits;
  minChunkBytes: number;
  maxChunkBytes: number;
  /** Short raw-upload retention (and in-flight session TTL), in ms. */
  rawRetentionMs: number;
  /** Optional per-import embedding-cost ceiling (fail-fast cost overrun gate). */
  maxEmbeddingUnits?: number;
  /** Optional per-import conversation-count ceiling. */
  maxConversations?: number;
}

type ImportConfigEnv = Pick<
  Bindings,
  | "IMPORT_MAX_DIRECT_UPLOAD_BYTES"
  | "IMPORT_MAX_UPLOAD_BYTES"
  | "IMPORT_RAW_RETENTION_MS"
  | "IMPORT_MAX_EMBEDDING_UNITS"
  | "IMPORT_MAX_CONVERSATIONS"
>;

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`[ConversationImports] ${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Resolves the conservative, operator-configurable import ceilings. Malformed
 * configuration throws (fail closed) instead of silently reverting to
 * defaults; unset values use the core `DEFAULT_IMPORT_LIMITS` (25 MiB direct,
 * 1 GiB resumable) and the core 7-day raw retention.
 */
export function importConfigFromEnv(env: ImportConfigEnv): ConversationImportConfig {
  const maxDirectUploadBytes = env.IMPORT_MAX_DIRECT_UPLOAD_BYTES
    ? parsePositiveInt("IMPORT_MAX_DIRECT_UPLOAD_BYTES", env.IMPORT_MAX_DIRECT_UPLOAD_BYTES)
    : DEFAULT_IMPORT_LIMITS.maxDirectUploadBytes;
  const maxResumableUploadBytes = env.IMPORT_MAX_UPLOAD_BYTES
    ? parsePositiveInt("IMPORT_MAX_UPLOAD_BYTES", env.IMPORT_MAX_UPLOAD_BYTES)
    : DEFAULT_IMPORT_LIMITS.maxResumableUploadBytes;
  if (maxDirectUploadBytes > maxResumableUploadBytes) {
    throw new Error(
      "[ConversationImports] IMPORT_MAX_DIRECT_UPLOAD_BYTES must not exceed IMPORT_MAX_UPLOAD_BYTES",
    );
  }
  return {
    limits: { maxDirectUploadBytes, maxResumableUploadBytes },
    minChunkBytes: IMPORT_MIN_CHUNK_BYTES,
    maxChunkBytes: IMPORT_MAX_CHUNK_BYTES,
    rawRetentionMs: env.IMPORT_RAW_RETENTION_MS
      ? parsePositiveInt("IMPORT_RAW_RETENTION_MS", env.IMPORT_RAW_RETENTION_MS)
      : DEFAULT_RAW_UPLOAD_RETENTION_MS,
    ...(env.IMPORT_MAX_EMBEDDING_UNITS !== undefined && {
      maxEmbeddingUnits: parsePositiveInt(
        "IMPORT_MAX_EMBEDDING_UNITS",
        env.IMPORT_MAX_EMBEDDING_UNITS,
      ),
    }),
    ...(env.IMPORT_MAX_CONVERSATIONS !== undefined && {
      maxConversations: parsePositiveInt("IMPORT_MAX_CONVERSATIONS", env.IMPORT_MAX_CONVERSATIONS),
    }),
  };
}

/** Storage-quota port; `orgStorageQuotaRepository` satisfies it structurally. */
export interface ImportQuotaRepository {
  findByOrganization(
    organizationId: string,
  ): Promise<{ bytes_used: bigint; bytes_limit: bigint } | undefined>;
  tryReserveBytes(organizationId: string, bytes: bigint): Promise<bigint | null>;
  releaseBytes(organizationId: string, bytes: bigint): Promise<void>;
}

type MultipartCapableBucket = RuntimeR2Bucket & {
  createMultipartUpload: NonNullable<RuntimeR2Bucket["createMultipartUpload"]>;
  resumeMultipartUpload: NonNullable<RuntimeR2Bucket["resumeMultipartUpload"]>;
};

function hasMultipartSupport(bucket: RuntimeR2Bucket): bucket is MultipartCapableBucket {
  return (
    typeof bucket.createMultipartUpload === "function" &&
    typeof bucket.resumeMultipartUpload === "function"
  );
}

function requireBucket(env: Pick<Bindings, "BLOB">): RuntimeR2Bucket {
  if (!env.BLOB) {
    throw new ApiError(503, "service_unavailable", "R2 storage is not configured");
  }
  return env.BLOB;
}

function requireMultipartBucket(env: Pick<Bindings, "BLOB">): MultipartCapableBucket {
  const bucket = requireBucket(env);
  if (!hasMultipartSupport(bucket)) {
    throw new ApiError(
      503,
      "service_unavailable",
      "R2 multipart uploads are not supported by the configured storage binding",
    );
  }
  return bucket;
}

function safeComponent(value: string, field: string): string {
  const trimmed = value.trim();
  if (!SAFE_COMPONENT.test(trimmed)) {
    throw new ApiError(
      400,
      "validation_error",
      `${field} must be a safe path component (letters, digits, ".", "_", "-")`,
    );
  }
  return trimmed;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w .+=@()-]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "upload";
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.trim().toLowerCase();
  if (normalized.includes("zip")) return "zip";
  if (normalized.includes("ndjson") || normalized.includes("jsonl")) {
    return "jsonl";
  }
  if (normalized.includes("json")) return "json";
  if (normalized.startsWith("text/")) return "txt";
  return "bin";
}

/**
 * Raw-upload object key for the resumable path, mirroring the core artifact
 * policy layout exactly. The core `buildImportArtifactDescriptor` hashes the
 * artifact bytes itself, which a 1 GiB streamed multipart upload cannot
 * provide up front — so the client declares the whole-file sha256 at init
 * (every chunk is still digest-verified server-side by the core resumable
 * primitive). Seam note: if core later exports a descriptor-from-digest
 * variant, this helper collapses into it.
 */
export function buildRawUploadStorageKey(
  scope: { tenantId: string; appId: string; batchId: string },
  sha256: string,
  extension: string,
): string {
  return [
    "conversation-imports",
    scope.tenantId,
    "apps",
    scope.appId,
    "batches",
    scope.batchId,
    "raw-upload",
    `${sha256}.${extension}`,
  ].join("/");
}

function serializeResumableSession(session: ResumableUploadSession): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    uploadBytes: session.uploadBytes,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    chunks: session.chunks,
  };
}

function storageQuotaFailure(remaining: number, observed: number): ImportLimitFailureDto {
  return {
    ok: false,
    code: "quota_storage_exceeded",
    message: `import needs ${observed} storage bytes but only ${remaining} remain in the organization quota`,
    limit: remaining,
    observed,
  };
}

function sessionExpiredFailure(expiredAt: Date): ImportSessionExpiredDto {
  return {
    ok: false,
    code: "upload_session_expired",
    message: "upload session expired before completing; start a new import",
    expiredAt: expiredAt.toISOString(),
  };
}

function chunkConflictFailure(chunkIndex: number): ImportChunkConflictDto {
  return {
    ok: false,
    code: "upload_chunk_conflict",
    message: `chunk ${chunkIndex} conflicts with previously received bytes`,
    chunkIndex,
  };
}

export interface ImportPreflightInput {
  organizationId: string;
  uploadBytes: number;
  conversationCount?: number;
  storageBytes?: number;
  embeddingUnits?: number;
}

export interface ImportInitInput {
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  appId?: string;
  source: string;
  filename: string;
  contentType: string;
  uploadBytes: number;
  chunkSize: number;
  declaredSha256: string;
  conversationCount?: number;
  embeddingUnits?: number;
  retainRawUpload?: boolean;
  retainReason?: string;
}

export interface ImportChunkInput {
  organizationId: string;
  sessionId: string;
  chunkIndex: number;
  offset: number;
  bytes: Uint8Array;
  sha256?: string;
}

export interface ImportDirectUploadInput {
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  appId?: string;
  source: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  conversationCount?: number;
  embeddingUnits?: number;
  retainRawUpload?: boolean;
  retainReason?: string;
}

export interface ImportDerivedArtifactInput {
  organizationId: string;
  batchId: string;
  kind: "derived-document" | "derived-manifest" | "import-report";
  contentType: string;
  bytes: Uint8Array | string;
  extension?: string;
}

export class ConversationImportsService {
  constructor(
    private readonly batches = importBatchesRepository,
    private readonly sessions = importUploadSessionsRepository,
    private readonly artifacts = importArtifactsRepository,
    private readonly quota: ImportQuotaRepository = orgStorageQuotaRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Quota/size admission decision BEFORE any bytes are accepted. Delegates to
   * the core `preflightImport` with the real tenant storage remainder plus the
   * operator-configured per-import cost ceilings.
   */
  async preflight(
    env: ImportConfigEnv,
    input: ImportPreflightInput,
  ): Promise<ImportPreflightDecisionDto> {
    const config = importConfigFromEnv(env);
    const remainingStorageBytes = await this.remainingStorageBytes(input.organizationId);
    const estimate: ImportUsageEstimate = {
      uploadBytes: input.uploadBytes,
      ...(input.conversationCount !== undefined && {
        conversationCount: input.conversationCount,
      }),
      ...(input.storageBytes !== undefined && {
        storageBytes: input.storageBytes,
      }),
      ...(input.embeddingUnits !== undefined && {
        embeddingUnits: input.embeddingUnits,
      }),
    };
    const decision = preflightImport(estimate, {
      limits: config.limits,
      quota: {
        remainingStorageBytes,
        ...(config.maxEmbeddingUnits !== undefined && {
          remainingEmbeddingUnits: config.maxEmbeddingUnits,
        }),
        ...(config.maxConversations !== undefined && {
          remainingConversations: config.maxConversations,
        }),
      },
    });
    if (!decision.ok) {
      logger.info("[ConversationImports] Preflight rejected import", {
        organizationId: input.organizationId,
        code: decision.code,
        limit: decision.limit,
        observed: decision.observed,
      });
      return {
        ok: false,
        code: decision.code,
        message: decision.message,
        limit: decision.limit,
        observed: decision.observed,
      };
    }
    logger.info("[ConversationImports] Preflight admitted import", {
      organizationId: input.organizationId,
      uploadBytes: input.uploadBytes,
      requiresResumable: decision.requiresResumable,
    });
    return {
      ok: true,
      requiresResumable: decision.requiresResumable,
      maxDirectUploadBytes: config.limits.maxDirectUploadBytes,
      maxResumableUploadBytes: config.limits.maxResumableUploadBytes,
      minChunkBytes: config.minChunkBytes,
      maxChunkBytes: config.maxChunkBytes,
      recommendedChunkBytes: Math.min(
        Math.max(IMPORT_RECOMMENDED_CHUNK_BYTES, config.minChunkBytes),
        config.maxChunkBytes,
      ),
    };
  }

  /**
   * Opens a resumable chunk-upload session: preflight, atomic tenant quota
   * reservation, batch row, R2 multipart upload, and the serialized core
   * resumable session state. Fails fast with a typed DTO — quota is reserved
   * only after admission and released again on any setup failure.
   */
  async initResumableUpload(
    env: Bindings,
    input: ImportInitInput,
  ): Promise<ImportInitResultDto | ConversationImportFailureDto> {
    const config = importConfigFromEnv(env);
    const appId = safeComponent(input.appId ?? DEFAULT_APP_ID, "appId");
    const source = safeComponent(input.source, "source");
    const declaredSha256 = input.declaredSha256.trim().toLowerCase();
    if (!SHA256_HEX.test(declaredSha256)) {
      throw new ApiError(
        400,
        "validation_error",
        "declaredSha256 must be a 64-character lowercase hex sha256 digest",
      );
    }
    if (
      !Number.isSafeInteger(input.chunkSize) ||
      input.chunkSize < config.minChunkBytes ||
      input.chunkSize > config.maxChunkBytes
    ) {
      throw new ApiError(
        400,
        "validation_error",
        `chunkSize must be an integer between ${config.minChunkBytes} and ${config.maxChunkBytes} bytes`,
      );
    }
    if (input.retainRawUpload && !input.retainReason?.trim()) {
      throw new ApiError(400, "validation_error", "retainRawUpload requires a retainReason");
    }
    const bucket = requireMultipartBucket(env);

    const decision = await this.preflight(env, {
      organizationId: input.organizationId,
      uploadBytes: input.uploadBytes,
      ...(input.conversationCount !== undefined && {
        conversationCount: input.conversationCount,
      }),
      ...(input.embeddingUnits !== undefined && {
        embeddingUnits: input.embeddingUnits,
      }),
    });
    if (!decision.ok) return decision;

    const uploadBytes = BigInt(input.uploadBytes);
    const reserved = await this.quota.tryReserveBytes(input.organizationId, uploadBytes);
    if (reserved === null) {
      const remaining = await this.remainingStorageBytes(input.organizationId);
      return storageQuotaFailure(remaining, input.uploadBytes);
    }

    let batch: ImportBatch | undefined;
    try {
      batch = await this.batches.create({
        organization_id: input.organizationId,
        user_id: input.userId ?? null,
        api_key_id: input.apiKeyId ?? null,
        app_id: appId,
        source,
        status: "uploading",
        upload_bytes: uploadBytes,
        reserved_bytes: uploadBytes,
      });
      const storageKey = buildRawUploadStorageKey(
        { tenantId: input.organizationId, appId, batchId: batch.id },
        declaredSha256,
        extensionForContentType(input.contentType),
      );
      const multipart = await bucket.createMultipartUpload(storageKey, {
        httpMetadata: { contentType: input.contentType },
        customMetadata: {
          organizationId: input.organizationId,
          batchId: batch.id,
          kind: "raw-upload",
        },
      });
      const sessionId = randomUUID();
      const state = createResumableUploadSession({
        sessionId,
        uploadBytes: input.uploadBytes,
        chunkSize: input.chunkSize,
        now: () => this.now().getTime(),
      });
      const row = await this.sessions.create({
        id: sessionId,
        organization_id: input.organizationId,
        batch_id: batch.id,
        filename: sanitizeFilename(input.filename),
        content_type: input.contentType,
        declared_sha256: declaredSha256,
        upload_bytes: uploadBytes,
        chunk_size: input.chunkSize,
        chunk_count: state.chunkCount,
        status: "open",
        multipart_upload_id: multipart.uploadId,
        storage_key: storageKey,
        session_state: serializeResumableSession(state),
        part_etags: {},
        retain_raw: input.retainRawUpload ?? false,
        retain_reason: input.retainReason?.trim() ?? null,
        expires_at: new Date(this.now().getTime() + config.rawRetentionMs),
      });
      logger.info("[ConversationImports] Opened resumable upload session", {
        organizationId: input.organizationId,
        batchId: batch.id,
        sessionId: row.id,
        uploadBytes: input.uploadBytes,
        chunkSize: input.chunkSize,
        chunkCount: state.chunkCount,
        storageKey,
      });
      return {
        ok: true,
        session: this.toSessionDto(row, state),
        batch: this.toBatchDto(batch),
      };
    } catch (error) {
      await this.quota.releaseBytes(input.organizationId, uploadBytes);
      if (batch) {
        await this.batches
          .transitionStatus(input.organizationId, batch.id, ["uploading"], "aborted", {
            reserved_bytes: 0n,
          })
          .catch((transitionError) => {
            logger.warn("[ConversationImports] Failed to abort batch after init failure", {
              organizationId: input.organizationId,
              batchId: batch?.id,
              error:
                transitionError instanceof Error
                  ? transitionError.message
                  : String(transitionError),
            });
            return undefined;
          });
      }
      throw error;
    }
  }

  /**
   * Validates and stores one chunk. Duplicate retries of an already-received
   * identical chunk are idempotent (no second R2 write); a retry with
   * different bytes is a typed conflict. Concurrent appends are reconciled
   * through the core merge primitive under optimistic concurrency.
   */
  async appendChunk(
    env: Bindings,
    input: ImportChunkInput,
  ): Promise<ImportChunkResultDto | ConversationImportFailureDto | undefined> {
    const row = await this.sessions.findByOrgAndId(input.organizationId, input.sessionId);
    if (!row || row.status === "aborted") return undefined;
    const expired = await this.failIfExpired(env, row);
    if (expired) return expired;

    const state = validateResumableUploadSession(row.session_state);
    const sha256 = resumableSha256Hex(input.bytes);
    if (input.sha256 !== undefined && input.sha256 !== sha256) {
      throw new ApiError(
        400,
        "validation_error",
        `chunk ${input.chunkIndex} sha256 does not match the uploaded bytes`,
      );
    }
    const existing = state.chunks[input.chunkIndex];
    if (existing) {
      if (
        existing.offset !== input.offset ||
        existing.byteLength !== input.bytes.byteLength ||
        existing.sha256 !== sha256
      ) {
        return chunkConflictFailure(input.chunkIndex);
      }
      logger.debug("[ConversationImports] Duplicate chunk retry", {
        organizationId: input.organizationId,
        sessionId: row.id,
        chunkIndex: input.chunkIndex,
      });
      return {
        ok: true,
        status: "duplicate",
        chunkIndex: input.chunkIndex,
        progress: getResumableUploadProgress(state),
      };
    }

    let accepted: ResumableUploadSession;
    try {
      const result = recordResumableChunk(state, {
        index: input.chunkIndex,
        offset: input.offset,
        bytes: input.bytes,
        sha256,
        now: () => this.now().getTime(),
      });
      accepted = result.session;
    } catch (error) {
      throw new ApiError(
        400,
        "validation_error",
        error instanceof Error ? error.message : String(error),
      );
    }

    const bucket = requireMultipartBucket(env);
    const multipart = bucket.resumeMultipartUpload(row.storage_key, row.multipart_upload_id);
    const part = await multipart.uploadPart(input.chunkIndex + 1, input.bytes);

    let expectedUpdatedAt = state.updatedAt;
    let nextState = accepted;
    let nextEtags: Record<string, string> = {
      ...row.part_etags,
      [String(part.partNumber)]: part.etag,
    };
    for (let attempt = 0; attempt < CHUNK_CAS_ATTEMPTS; attempt += 1) {
      const updated = await this.sessions.compareAndSwapState(
        input.organizationId,
        row.id,
        expectedUpdatedAt,
        {
          sessionState: serializeResumableSession(nextState),
          partEtags: nextEtags,
          status: nextState.status,
        },
      );
      if (updated) {
        logger.debug("[ConversationImports] Chunk accepted", {
          organizationId: input.organizationId,
          sessionId: row.id,
          chunkIndex: input.chunkIndex,
          byteLength: input.bytes.byteLength,
          receivedChunks: getResumableUploadProgress(nextState).receivedChunks,
        });
        return {
          ok: true,
          status: "accepted",
          chunkIndex: input.chunkIndex,
          progress: getResumableUploadProgress(nextState),
        };
      }
      const fresh = await this.sessions.findByOrgAndId(input.organizationId, row.id);
      if (!fresh || fresh.status === "aborted") return undefined;
      const freshState = validateResumableUploadSession(fresh.session_state);
      try {
        nextState = mergeResumableUploadSessions(freshState, accepted);
      } catch {
        return chunkConflictFailure(input.chunkIndex);
      }
      expectedUpdatedAt = freshState.updatedAt;
      nextEtags = {
        ...fresh.part_etags,
        [String(part.partNumber)]: part.etag,
      };
    }
    throw new ApiError(
      409,
      "session_not_ready",
      "concurrent chunk updates exhausted retries; retry this chunk",
    );
  }

  /** Progress + missing ranges so an interrupted client can resume. */
  async getUploadStatus(
    organizationId: string,
    sessionId: string,
  ): Promise<ImportUploadSessionDto | undefined> {
    const row = await this.sessions.findByOrgAndId(organizationId, sessionId);
    if (!row) return undefined;
    const state = validateResumableUploadSession(row.session_state);
    return this.toSessionDto(row, state);
  }

  /**
   * Finishes the upload: every chunk must be present (otherwise a typed
   * `upload_interrupted` DTO with the exact missing ranges — never a partial
   * "healthy" import), the R2 multipart upload is completed, and the raw
   * upload becomes a retention-tracked artifact (short-lived by default).
   * Retrying a finished complete is idempotent.
   */
  async completeUpload(
    env: Bindings,
    organizationId: string,
    sessionId: string,
  ): Promise<ImportCompleteResultDto | ConversationImportFailureDto | undefined> {
    const row = await this.sessions.findByOrgAndId(organizationId, sessionId);
    if (!row || row.status === "aborted") return undefined;
    const batch = await this.batches.findByOrgAndId(organizationId, row.batch_id);
    if (!batch || batch.status === "deleted") return undefined;

    const existingArtifact = await this.artifacts.findActiveByBatchAndKey(
      organizationId,
      row.batch_id,
      row.storage_key,
    );
    if (existingArtifact) {
      return {
        ok: true,
        batch: this.toBatchDto({ ...batch, status: "uploaded" }),
        artifact: this.toArtifactDto(existingArtifact),
      };
    }

    const expired = await this.failIfExpired(env, row);
    if (expired) return expired;

    const state = validateResumableUploadSession(row.session_state);
    const progress = getResumableUploadProgress(state);
    if (!progress.complete) {
      const missingRanges = findMissingResumableUploadRanges(state);
      logger.info("[ConversationImports] Complete refused: upload interrupted", {
        organizationId,
        sessionId,
        receivedBytes: progress.receivedBytes,
        uploadBytes: progress.uploadBytes,
        missingChunks: missingRanges.length,
      });
      const interrupted: ImportUploadInterruptedDto = {
        ok: false,
        code: "upload_interrupted",
        message: `upload has ${missingRanges.length} missing chunk(s); upload them and complete again`,
        receivedBytes: progress.receivedBytes,
        uploadBytes: progress.uploadBytes,
        missingRanges,
      };
      return interrupted;
    }

    const parts: RuntimeR2UploadedPart[] = [];
    for (let index = 0; index < row.chunk_count; index += 1) {
      const partNumber = index + 1;
      const etag = row.part_etags[String(partNumber)];
      if (!etag) {
        throw new Error(
          `[ConversationImports] session ${sessionId} chunk ${index} accepted but part etag missing`,
        );
      }
      parts.push({ partNumber, etag });
    }
    const bucket = requireMultipartBucket(env);
    const multipart = bucket.resumeMultipartUpload(row.storage_key, row.multipart_upload_id);
    await multipart.complete(parts);

    const retention = this.rawRetention(env, row);
    const artifact = await this.artifacts.create({
      organization_id: organizationId,
      batch_id: row.batch_id,
      kind: "raw-upload",
      sha256: row.declared_sha256,
      byte_length: row.upload_bytes,
      content_type: row.content_type,
      storage_key: row.storage_key,
      retention_mode: retention.mode,
      retain_reason: retention.mode === "explicit-raw-retain" ? retention.reason : null,
      expires_at: retention.mode === "short-lived" ? new Date(retention.expiresAt) : null,
      status: "active",
    });
    await this.sessions.transitionStatus(
      organizationId,
      sessionId,
      ["open", "complete"],
      "complete",
    );
    const uploadedBatch =
      (await this.batches.transitionStatus(
        organizationId,
        row.batch_id,
        ["uploading"],
        "uploaded",
        { reserved_bytes: 0n },
      )) ?? batch;
    logger.info("[ConversationImports] Completed resumable upload", {
      organizationId,
      sessionId,
      batchId: row.batch_id,
      storageKey: row.storage_key,
      byteLength: Number(row.upload_bytes),
      retentionMode: retention.mode,
    });
    return {
      ok: true,
      batch: this.toBatchDto(uploadedBatch),
      artifact: this.toArtifactDto(artifact),
    };
  }

  /** Aborts an open session: R2 multipart abort + quota release, idempotently. */
  async abortUpload(
    env: Bindings,
    organizationId: string,
    sessionId: string,
  ): Promise<{ ok: true; sessionId: string; status: "aborted" } | undefined> {
    const row = await this.sessions.findByOrgAndId(organizationId, sessionId);
    if (!row) return undefined;
    if (row.status === "complete") {
      throw new ApiError(
        409,
        "session_not_ready",
        "upload already completed; delete the import batch instead",
      );
    }
    if (row.status === "open") {
      await this.abortSessionResources(env, row);
    }
    return { ok: true, sessionId, status: "aborted" };
  }

  /**
   * Direct (non-resumable) upload for exports within the conservative direct
   * ceiling. Larger admitted uploads get a typed `resumable_required`
   * rejection — bytes past the ceiling are never buffered here.
   */
  async directUpload(
    env: Bindings,
    input: ImportDirectUploadInput,
  ): Promise<ImportDirectUploadResultDto | ConversationImportFailureDto> {
    const config = importConfigFromEnv(env);
    const appId = safeComponent(input.appId ?? DEFAULT_APP_ID, "appId");
    const source = safeComponent(input.source, "source");
    if (input.retainRawUpload && !input.retainReason?.trim()) {
      throw new ApiError(400, "validation_error", "retainRawUpload requires a retainReason");
    }
    const uploadBytes = input.bytes.byteLength;
    const decision = await this.preflight(env, {
      organizationId: input.organizationId,
      uploadBytes,
      ...(input.conversationCount !== undefined && {
        conversationCount: input.conversationCount,
      }),
      ...(input.embeddingUnits !== undefined && {
        embeddingUnits: input.embeddingUnits,
      }),
    });
    if (!decision.ok) return decision;
    if (decision.requiresResumable) {
      return {
        ok: false,
        code: "resumable_required",
        message: `upload of ${uploadBytes} bytes exceeds the ${config.limits.maxDirectUploadBytes}-byte direct ceiling; use the resumable chunk path`,
        limit: config.limits.maxDirectUploadBytes,
        observed: uploadBytes,
      };
    }

    const bucket = requireBucket(env);
    const reserved = await this.quota.tryReserveBytes(input.organizationId, BigInt(uploadBytes));
    if (reserved === null) {
      const remaining = await this.remainingStorageBytes(input.organizationId);
      return storageQuotaFailure(remaining, uploadBytes);
    }

    let batch: ImportBatch | undefined;
    let wroteObject = false;
    let storageKey = "";
    try {
      batch = await this.batches.create({
        organization_id: input.organizationId,
        user_id: input.userId ?? null,
        api_key_id: input.apiKeyId ?? null,
        app_id: appId,
        source,
        status: "uploaded",
        upload_bytes: BigInt(uploadBytes),
        reserved_bytes: 0n,
      });
      const descriptor = buildImportArtifactDescriptor({
        kind: "raw-upload",
        scope: {
          tenantId: input.organizationId,
          appId,
          batchId: batch.id,
        },
        contentType: input.contentType,
        bytes: input.bytes,
        extension: extensionForContentType(input.contentType),
        rawRetention: {
          retentionMs: config.rawRetentionMs,
          ...(input.retainRawUpload !== undefined && {
            retainRawUpload: input.retainRawUpload,
          }),
          ...(input.retainReason !== undefined && {
            retainReason: input.retainReason,
          }),
        },
        now: () => this.now().getTime(),
      });
      storageKey = descriptor.storageKey;
      await bucket.put(descriptor.storageKey, input.bytes, {
        httpMetadata: { contentType: descriptor.contentType },
        customMetadata: {
          organizationId: input.organizationId,
          batchId: batch.id,
          kind: "raw-upload",
          sha256: descriptor.sha256,
        },
      });
      wroteObject = true;
      const artifact = await this.artifacts.create({
        organization_id: input.organizationId,
        batch_id: batch.id,
        kind: "raw-upload",
        sha256: descriptor.sha256,
        byte_length: BigInt(descriptor.byteLength),
        content_type: descriptor.contentType,
        storage_key: descriptor.storageKey,
        retention_mode: descriptor.retention.mode,
        retain_reason:
          descriptor.retention.mode === "explicit-raw-retain" ? descriptor.retention.reason : null,
        expires_at:
          descriptor.retention.mode === "short-lived"
            ? new Date(descriptor.retention.expiresAt)
            : null,
        status: "active",
      });
      logger.info("[ConversationImports] Stored direct upload", {
        organizationId: input.organizationId,
        batchId: batch.id,
        storageKey: descriptor.storageKey,
        byteLength: descriptor.byteLength,
        sha256: descriptor.sha256,
        retentionMode: descriptor.retention.mode,
      });
      return {
        ok: true,
        batch: this.toBatchDto(batch),
        artifact: this.toArtifactDto(artifact),
      };
    } catch (error) {
      if (wroteObject) {
        await bucket.delete(storageKey).catch((deleteError) => {
          logger.warn(
            "[ConversationImports] Failed to clean up object after direct-upload failure",
            {
              storageKey,
              error: deleteError instanceof Error ? deleteError.message : String(deleteError),
            },
          );
        });
      }
      await this.quota.releaseBytes(input.organizationId, BigInt(uploadBytes));
      if (batch) {
        await this.batches.transitionStatus(
          input.organizationId,
          batch.id,
          ["uploaded", "uploading"],
          "aborted",
          { reserved_bytes: 0n },
        );
      }
      throw error;
    }
  }

  /**
   * Stores a derived artifact (rendered document, manifest, import report)
   * content-addressed under the batch, charged against tenant storage quota.
   * Identical content within a batch dedupes to the existing artifact.
   */
  async storeDerivedArtifact(
    env: Bindings,
    input: ImportDerivedArtifactInput,
  ): Promise<{ ok: true; artifact: ImportArtifactDto } | ConversationImportFailureDto | undefined> {
    const batch = await this.batches.findByOrgAndId(input.organizationId, input.batchId);
    if (!batch || batch.status === "deleted") return undefined;
    const bucket = requireBucket(env);
    const descriptor = buildImportArtifactDescriptor({
      kind: input.kind,
      scope: {
        tenantId: input.organizationId,
        appId: batch.app_id,
        batchId: batch.id,
      },
      contentType: input.contentType,
      bytes: input.bytes,
      ...(input.extension !== undefined && { extension: input.extension }),
      now: () => this.now().getTime(),
    });

    const existing = await this.artifacts.findActiveByBatchAndKey(
      input.organizationId,
      batch.id,
      descriptor.storageKey,
    );
    if (existing) {
      return { ok: true, artifact: this.toArtifactDto(existing) };
    }

    const byteLength = BigInt(descriptor.byteLength);
    const reserved = await this.quota.tryReserveBytes(input.organizationId, byteLength);
    if (reserved === null) {
      const remaining = await this.remainingStorageBytes(input.organizationId);
      return storageQuotaFailure(remaining, descriptor.byteLength);
    }
    let wroteObject = false;
    try {
      await bucket.put(descriptor.storageKey, resolveBytes(input.bytes), {
        httpMetadata: { contentType: descriptor.contentType },
        customMetadata: {
          organizationId: input.organizationId,
          batchId: batch.id,
          kind: input.kind,
          sha256: descriptor.sha256,
        },
      });
      wroteObject = true;
      const artifact = await this.artifacts.create({
        organization_id: input.organizationId,
        batch_id: batch.id,
        kind: input.kind,
        sha256: descriptor.sha256,
        byte_length: byteLength,
        content_type: descriptor.contentType,
        storage_key: descriptor.storageKey,
        retention_mode: descriptor.retention.mode,
        retain_reason: null,
        expires_at: null,
        status: "active",
      });
      logger.info("[ConversationImports] Stored derived artifact", {
        organizationId: input.organizationId,
        batchId: batch.id,
        kind: input.kind,
        storageKey: descriptor.storageKey,
        byteLength: descriptor.byteLength,
        sha256: descriptor.sha256,
      });
      return { ok: true, artifact: this.toArtifactDto(artifact) };
    } catch (error) {
      if (wroteObject) {
        await bucket.delete(descriptor.storageKey).catch(() => undefined);
      }
      await this.quota.releaseBytes(input.organizationId, byteLength);
      throw error;
    }
  }

  async getBatch(
    organizationId: string,
    batchId: string,
  ): Promise<{ batch: ImportBatchDto; artifacts: ImportArtifactDto[] } | undefined> {
    const batch = await this.batches.findByOrgAndId(organizationId, batchId);
    if (!batch) return undefined;
    const artifacts = await this.artifacts.listActiveByBatch(organizationId, batchId);
    return {
      batch: this.toBatchDto(batch),
      artifacts: artifacts.map((artifact) => this.toArtifactDto(artifact)),
    };
  }

  async listBatches(
    organizationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{
    items: ImportBatchDto[];
    hasMore: boolean;
    limit: number;
    offset: number;
  }> {
    const result = await this.batches.listByOrganization(organizationId, options);
    return {
      items: result.items.map((batch) => this.toBatchDto(batch)),
      hasMore: result.hasMore,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /**
   * Batch delete per the retention policy: aborts open sessions, removes every
   * batch-scoped artifact (raw + derived) with per-artifact accounting, and
   * releases quota exactly once. Failures stay retryable — the batch is only
   * marked deleted when every artifact is gone.
   */
  async deleteBatch(
    env: Bindings,
    organizationId: string,
    batchId: string,
  ): Promise<ImportBatchDeleteReportDto | undefined> {
    const batch = await this.batches.findByOrgAndId(organizationId, batchId);
    if (!batch) return undefined;
    const bucket = requireBucket(env);

    let sessionsAborted = 0;
    const openSessions = await this.sessions.findOpenByBatch(organizationId, batchId);
    for (const session of openSessions) {
      await this.abortSessionResources(env, session);
      sessionsAborted += 1;
    }

    const deleted: ImportBatchDeleteReportDto["deleted"] = [];
    const failed: ImportBatchDeleteReportDto["failed"] = [];
    const activeArtifacts = await this.artifacts.listActiveByBatch(organizationId, batchId);
    for (const artifact of activeArtifacts) {
      try {
        await bucket.delete(artifact.storage_key);
        const removed = await this.artifacts.softDeleteByOrgAndId(organizationId, artifact.id);
        if (removed) {
          await this.quota.releaseBytes(organizationId, removed.byte_length);
        }
        deleted.push({
          artifactId: artifact.id,
          storageKey: artifact.storage_key,
        });
      } catch (error) {
        // error-policy: per-artifact accounting — a failed object delete is
        // reported and the row stays active so a retry can finish the job.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[ConversationImports] Failed to delete artifact", {
          organizationId,
          batchId,
          artifactId: artifact.id,
          storageKey: artifact.storage_key,
          error: message,
        });
        failed.push({
          artifactId: artifact.id,
          storageKey: artifact.storage_key,
          error: message,
        });
      }
    }

    let batchDeleted = batch.status === "deleted";
    if (failed.length === 0) {
      const preReserved = batch.reserved_bytes;
      const transitioned = await this.batches.transitionStatus(
        organizationId,
        batchId,
        ["uploading", "uploaded", "aborted"],
        "deleted",
        { reserved_bytes: 0n, deleted_at: this.now() },
      );
      if (transitioned) {
        batchDeleted = true;
        if (preReserved > 0n) {
          await this.quota.releaseBytes(organizationId, preReserved);
        }
      }
    }
    logger.info("[ConversationImports] Batch delete finished", {
      organizationId,
      batchId,
      deletedArtifacts: deleted.length,
      failedArtifacts: failed.length,
      sessionsAborted,
      batchDeleted,
    });
    return { batchId, deleted, failed, sessionsAborted, batchDeleted };
  }

  /**
   * Retention sweep: purges expired short-lived raw uploads and aborts
   * expired in-flight sessions, releasing tenant quota. Invoked by cron.
   */
  async purgeExpired(
    env: Bindings,
    now: Date = this.now(),
  ): Promise<ImportRetentionSweepReportDto> {
    const bucket = requireBucket(env);
    const failures: ImportRetentionSweepReportDto["failures"] = [];

    let purgedArtifacts = 0;
    const expiredArtifacts = await this.artifacts.findExpiredActive(now, RETENTION_SWEEP_BATCH);
    for (const artifact of expiredArtifacts) {
      try {
        await bucket.delete(artifact.storage_key);
        const removed = await this.artifacts.softDeleteByOrgAndId(
          artifact.organization_id,
          artifact.id,
        );
        if (removed) {
          await this.quota.releaseBytes(artifact.organization_id, removed.byte_length);
          purgedArtifacts += 1;
        }
      } catch (error) {
        failures.push({
          id: artifact.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let abortedSessions = 0;
    const expiredSessions = await this.sessions.findExpiredOpen(now, RETENTION_SWEEP_BATCH);
    for (const session of expiredSessions) {
      try {
        await this.abortSessionResources(env, session);
        abortedSessions += 1;
      } catch (error) {
        failures.push({
          id: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info("[ConversationImports] Retention sweep finished", {
      purgedArtifacts,
      abortedSessions,
      failures: failures.length,
    });
    return { purgedArtifacts, abortedSessions, failures };
  }

  private async remainingStorageBytes(organizationId: string): Promise<number> {
    const row = await this.quota.findByOrganization(organizationId);
    const used = row?.bytes_used ?? 0n;
    const limit = row?.bytes_limit ?? DEFAULT_ORG_STORAGE_BYTES_LIMIT;
    const remaining = limit - used;
    if (remaining <= 0n) return 0;
    return remaining > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(remaining);
  }

  /** Eagerly aborts an expired open session and returns the typed failure. */
  private async failIfExpired(
    env: Bindings,
    row: ImportUploadSessionRow,
  ): Promise<ImportSessionExpiredDto | undefined> {
    if (row.status !== "open") return undefined;
    if (row.expires_at.getTime() > this.now().getTime()) return undefined;
    await this.abortSessionResources(env, row);
    logger.info("[ConversationImports] Session expired before completion", {
      organizationId: row.organization_id,
      sessionId: row.id,
      expiredAt: row.expires_at.toISOString(),
    });
    return sessionExpiredFailure(row.expires_at);
  }

  /** Abort multipart + release the batch's reserved quota exactly once. */
  private async abortSessionResources(env: Bindings, row: ImportUploadSessionRow): Promise<void> {
    const won = await this.sessions.transitionStatus(
      row.organization_id,
      row.id,
      ["open"],
      "aborted",
    );
    if (!won) return;
    const bucket = requireBucket(env);
    if (hasMultipartSupport(bucket)) {
      try {
        await bucket.resumeMultipartUpload(row.storage_key, row.multipart_upload_id).abort();
      } catch (error) {
        // error-policy: abort of an already-gone multipart upload is benign;
        // quota release below still runs. Observed via this warn.
        logger.warn("[ConversationImports] Multipart abort failed", {
          organizationId: row.organization_id,
          sessionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const batch = await this.batches.findByOrgAndId(row.organization_id, row.batch_id);
    if (!batch) return;
    const preReserved = batch.reserved_bytes;
    const transitioned = await this.batches.transitionStatus(
      row.organization_id,
      row.batch_id,
      ["uploading"],
      "aborted",
      { reserved_bytes: 0n },
    );
    if (transitioned && preReserved > 0n) {
      await this.quota.releaseBytes(row.organization_id, preReserved);
    }
    logger.info("[ConversationImports] Aborted upload session", {
      organizationId: row.organization_id,
      sessionId: row.id,
      batchId: row.batch_id,
      releasedBytes: transitioned ? Number(preReserved) : 0,
    });
  }

  private rawRetention(
    env: ImportConfigEnv,
    row: ImportUploadSessionRow,
  ): { mode: "short-lived"; expiresAt: number } | { mode: "explicit-raw-retain"; reason: string } {
    if (row.retain_raw) {
      const reason = row.retain_reason?.trim();
      if (!reason) {
        throw new Error(
          `[ConversationImports] session ${row.id} retains raw upload without a reason`,
        );
      }
      return { mode: "explicit-raw-retain", reason };
    }
    const config = importConfigFromEnv(env);
    return {
      mode: "short-lived",
      expiresAt: this.now().getTime() + config.rawRetentionMs,
    };
  }

  private toBatchDto(batch: ImportBatch): ImportBatchDto {
    return {
      id: batch.id,
      appId: batch.app_id,
      source: batch.source,
      status: batch.status,
      uploadBytes: Number(batch.upload_bytes),
      createdAt: batch.created_at.toISOString(),
      updatedAt: batch.updated_at.toISOString(),
    };
  }

  private toSessionDto(
    row: ImportUploadSessionRow,
    state: ResumableUploadSession,
  ): ImportUploadSessionDto {
    return {
      sessionId: row.id,
      batchId: row.batch_id,
      filename: row.filename,
      contentType: row.content_type,
      declaredSha256: row.declared_sha256,
      uploadBytes: Number(row.upload_bytes),
      chunkSize: row.chunk_size,
      chunkCount: row.chunk_count,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      progress: getResumableUploadProgress(state),
      missingRanges: findMissingResumableUploadRanges(state),
    };
  }

  private toArtifactDto(artifact: ImportArtifactRow): ImportArtifactDto {
    return {
      id: artifact.id,
      batchId: artifact.batch_id,
      kind: artifact.kind,
      sha256: artifact.sha256,
      byteLength: Number(artifact.byte_length),
      contentType: artifact.content_type,
      storageKey: artifact.storage_key,
      retention: this.toRetentionDto(artifact),
      status: artifact.status,
      createdAt: artifact.created_at.toISOString(),
    };
  }

  private toRetentionDto(artifact: ImportArtifactRow): ImportArtifactRetentionDto {
    if (artifact.retention_mode === "short-lived") {
      if (!artifact.expires_at) {
        throw new Error(
          `[ConversationImports] artifact ${artifact.id} is short-lived but has no expires_at`,
        );
      }
      return {
        mode: "short-lived",
        expiresAt: artifact.expires_at.toISOString(),
      };
    }
    if (artifact.retention_mode === "explicit-raw-retain") {
      const reason = artifact.retain_reason?.trim();
      if (!reason) {
        throw new Error(
          `[ConversationImports] artifact ${artifact.id} retains raw upload without a reason`,
        );
      }
      return { mode: "explicit-raw-retain", reason };
    }
    if (artifact.retention_mode === "batch-lifecycle") {
      return { mode: "batch-lifecycle", deleteWithBatch: true };
    }
    throw new Error(
      `[ConversationImports] artifact ${artifact.id} has unknown retention mode "${artifact.retention_mode}"`,
    );
  }
}

function resolveBytes(bytes: Uint8Array | string): Uint8Array {
  return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
}

export const conversationImportsService = new ConversationImportsService();
