/**
 * Typed DTOs for the #13432 conversation-import cloud path.
 *
 * Every failure a client can hit — quota exceeded, over-size upload,
 * interrupted upload, chunk conflict, expired session, parser failure,
 * partial import — is a discriminated union member with the fields the
 * failure/retry UX needs, derived in the service layer and returned by
 * routes verbatim. Codes are stable; clients branch on `code`, not message.
 */

/** Byte range still missing from a resumable upload (mirrors the core primitive). */
export interface ImportMissingRangeDto {
  start: number;
  endExclusive: number;
  chunkIndex: number;
}

/** Preflight/limit rejections — the crossed limit and the observed value. */
export interface ImportLimitFailureDto {
  ok: false;
  code:
    | "upload_too_large"
    | "resumable_required"
    | "quota_storage_exceeded"
    | "quota_embedding_exceeded"
    | "quota_conversations_exceeded";
  message: string;
  limit: number;
  observed: number;
}

/** Complete was requested (or the session was inspected) with chunks missing. */
export interface ImportUploadInterruptedDto {
  ok: false;
  code: "upload_interrupted";
  message: string;
  receivedBytes: number;
  uploadBytes: number;
  missingRanges: ImportMissingRangeDto[];
}

/** A chunk retry carried different bytes than the previously accepted chunk. */
export interface ImportChunkConflictDto {
  ok: false;
  code: "upload_chunk_conflict";
  message: string;
  chunkIndex: number;
}

/** The resumable session passed its retention window before completing. */
export interface ImportSessionExpiredDto {
  ok: false;
  code: "upload_session_expired";
  message: string;
  expiredAt: string;
}

/**
 * The uploaded export could not be parsed. Surfaced by the import-execution
 * step that consumes completed raw uploads (see the seam note in #13432).
 */
export interface ImportParserFailedDto {
  ok: false;
  code: "parser_failed";
  message: string;
  source: string;
}

/**
 * Import execution stopped partway; never presented as a healthy import.
 * Surfaced by the import-execution step that consumes completed raw uploads.
 */
export interface ImportPartialImportDto {
  ok: false;
  code: "partial_import";
  message: string;
  importedConversations: number;
  failedConversations: number;
}

export type ConversationImportFailureDto =
  | ImportLimitFailureDto
  | ImportUploadInterruptedDto
  | ImportChunkConflictDto
  | ImportSessionExpiredDto
  | ImportParserFailedDto
  | ImportPartialImportDto;

export type ConversationImportFailureCode = ConversationImportFailureDto["code"];

/** Canonical HTTP status for each failure code (routes map, never invent). */
export function importFailureHttpStatus(
  code: ConversationImportFailureCode,
): 409 | 410 | 413 | 422 {
  switch (code) {
    case "upload_too_large":
    case "resumable_required":
    case "quota_storage_exceeded":
    case "quota_embedding_exceeded":
    case "quota_conversations_exceeded":
      return 413;
    case "upload_interrupted":
    case "upload_chunk_conflict":
      return 409;
    case "upload_session_expired":
      return 410;
    case "parser_failed":
    case "partial_import":
      return 422;
  }
}

/** An admitted preflight: the transport the client must use plus the ceilings applied. */
export interface ImportPreflightAdmitDto {
  ok: true;
  requiresResumable: boolean;
  maxDirectUploadBytes: number;
  maxResumableUploadBytes: number;
  minChunkBytes: number;
  maxChunkBytes: number;
  recommendedChunkBytes: number;
}

export type ImportPreflightDecisionDto = ImportPreflightAdmitDto | ImportLimitFailureDto;

export interface ImportUploadProgressDto {
  receivedBytes: number;
  uploadBytes: number;
  receivedChunks: number;
  chunkCount: number;
  complete: boolean;
}

export interface ImportUploadSessionDto {
  sessionId: string;
  batchId: string;
  filename: string;
  contentType: string;
  declaredSha256: string;
  uploadBytes: number;
  chunkSize: number;
  chunkCount: number;
  status: string;
  expiresAt: string;
  progress: ImportUploadProgressDto;
  missingRanges: ImportMissingRangeDto[];
}

export interface ImportChunkResultDto {
  ok: true;
  status: "accepted" | "duplicate";
  chunkIndex: number;
  progress: ImportUploadProgressDto;
}

export type ImportArtifactRetentionDto =
  | { mode: "short-lived"; expiresAt: string }
  | { mode: "explicit-raw-retain"; reason: string }
  | { mode: "batch-lifecycle"; deleteWithBatch: true };

export interface ImportArtifactDto {
  id: string;
  batchId: string;
  kind: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  storageKey: string;
  retention: ImportArtifactRetentionDto;
  status: string;
  createdAt: string;
}

export interface ImportBatchDto {
  id: string;
  appId: string;
  source: string;
  status: string;
  uploadBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportCompleteResultDto {
  ok: true;
  batch: ImportBatchDto;
  artifact: ImportArtifactDto;
}

export interface ImportInitResultDto {
  ok: true;
  session: ImportUploadSessionDto;
  batch: ImportBatchDto;
}

export interface ImportDirectUploadResultDto {
  ok: true;
  batch: ImportBatchDto;
  artifact: ImportArtifactDto;
}

/** Per-artifact accounting for a batch delete — failures stay retryable. */
export interface ImportBatchDeleteReportDto {
  batchId: string;
  deleted: Array<{ artifactId: string; storageKey: string }>;
  failed: Array<{ artifactId: string; storageKey: string; error: string }>;
  sessionsAborted: number;
  batchDeleted: boolean;
}

/** Retention sweep stats (cron). */
export interface ImportRetentionSweepReportDto {
  purgedArtifacts: number;
  abortedSessions: number;
  failures: Array<{ id: string; error: string }>;
}
