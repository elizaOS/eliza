/**
 * Content-addressed artifact descriptors for conversation imports.
 *
 * This is the pure policy layer for #13432's storage contract: raw uploads are
 * short-lived by default, derived artifacts are content-addressed and tied to
 * an import batch lifecycle, and every storage key is scoped by tenant/app/batch
 * before any cloud object store is asked to write bytes.
 */

import { createHash } from "node:crypto";
import type { ConversationSource } from "./types.ts";

export const DEFAULT_RAW_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ImportArtifactKind =
  | "raw-upload"
  | "derived-document"
  | "derived-manifest"
  | "import-report";

export interface ImportArtifactScope {
  tenantId: string;
  appId: string;
  batchId: string;
  source?: ConversationSource;
}

export type ImportArtifactRetention =
  | {
      mode: "short-lived";
      retentionMs: number;
      expiresAt: number;
    }
  | {
      mode: "explicit-raw-retain";
      reason: string;
    }
  | {
      mode: "batch-lifecycle";
      deleteWithBatch: true;
    };

export interface ImportArtifactDescriptor {
  kind: ImportArtifactKind;
  scope: ImportArtifactScope;
  sha256: string;
  byteLength: number;
  contentType: string;
  storageKey: string;
  retention: ImportArtifactRetention;
}

export interface RawUploadRetentionOptions {
  /**
   * Override the default short retention window. The upload still expires unless
   * `retainRawUpload` is set with an explicit reason.
   */
  retentionMs?: number;
  /**
   * Longer raw retention is intentionally explicit. A caller must provide a
   * reason so the route/service log can show why raw user exports outlive the
   * short default.
   */
  retainRawUpload?: boolean;
  retainReason?: string;
}

export interface BuildImportArtifactDescriptorOptions {
  kind: ImportArtifactKind;
  scope: ImportArtifactScope;
  contentType: string;
  bytes: string | Uint8Array;
  /** Optional storage-key suffix without a leading dot, for human inspection. */
  extension?: string;
  rawRetention?: RawUploadRetentionOptions;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_EXTENSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
const DEFAULT_NOW = () => Date.now();

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function importArtifactByteLength(bytes: string | Uint8Array): number {
  return typeof bytes === "string"
    ? Buffer.byteLength(bytes, "utf8")
    : bytes.byteLength;
}

export function buildImportArtifactDescriptor(
  options: BuildImportArtifactDescriptorOptions,
): ImportArtifactDescriptor {
  const scope = normalizeScope(options.scope);
  const contentType = normalizeContentType(options.contentType);
  const extension = normalizeExtension(options.extension);
  const sha256 = sha256Hex(options.bytes);
  const byteLength = importArtifactByteLength(options.bytes);
  const suffix = extension ? `.${extension}` : "";
  const storageKey = [
    "conversation-imports",
    scope.tenantId,
    "apps",
    scope.appId,
    "batches",
    scope.batchId,
    options.kind,
    `${sha256}${suffix}`,
  ].join("/");

  return {
    kind: options.kind,
    scope,
    sha256,
    byteLength,
    contentType,
    storageKey,
    retention: retentionForKind(
      options.kind,
      options.rawRetention,
      options.now ?? DEFAULT_NOW,
    ),
  };
}

export function importArtifactExpired(
  descriptor: Pick<ImportArtifactDescriptor, "retention">,
  atMs = Date.now(),
): boolean {
  return (
    descriptor.retention.mode === "short-lived" &&
    atMs >= descriptor.retention.expiresAt
  );
}

function retentionForKind(
  kind: ImportArtifactKind,
  rawRetention: RawUploadRetentionOptions | undefined,
  now: () => number,
): ImportArtifactRetention {
  if (kind !== "raw-upload") {
    return { mode: "batch-lifecycle", deleteWithBatch: true };
  }

  if (rawRetention?.retainRawUpload) {
    const reason = rawRetention.retainReason?.trim();
    if (!reason) {
      throw new Error(
        "buildImportArtifactDescriptor: retainRawUpload requires a retainReason",
      );
    }
    return { mode: "explicit-raw-retain", reason };
  }

  const retentionMs =
    rawRetention?.retentionMs ?? DEFAULT_RAW_UPLOAD_RETENTION_MS;
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    throw new Error(
      `buildImportArtifactDescriptor: raw retentionMs must be a positive finite number, got ${retentionMs}`,
    );
  }
  return {
    mode: "short-lived",
    retentionMs,
    expiresAt: now() + retentionMs,
  };
}

function normalizeScope(scope: ImportArtifactScope): ImportArtifactScope {
  return {
    tenantId: safeComponent(scope.tenantId, "tenantId"),
    appId: safeComponent(scope.appId, "appId"),
    batchId: safeComponent(scope.batchId, "batchId"),
    source: scope.source,
  };
}

function normalizeContentType(contentType: string): string {
  const trimmed = contentType.trim().toLowerCase();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(
      "buildImportArtifactDescriptor: contentType must be a non-empty MIME type",
    );
  }
  return trimmed;
}

function normalizeExtension(extension: string | undefined): string | undefined {
  if (extension === undefined) return undefined;
  const trimmed = extension.trim().replace(/^\./, "").toLowerCase();
  if (!SAFE_EXTENSION.test(trimmed)) {
    throw new Error(
      `buildImportArtifactDescriptor: extension must be a safe suffix, got "${extension}"`,
    );
  }
  return trimmed;
}

function safeComponent(value: string, field: string): string {
  const trimmed = value.trim();
  if (!SAFE_COMPONENT.test(trimmed)) {
    throw new Error(
      `buildImportArtifactDescriptor: ${field} must be a safe path component`,
    );
  }
  return trimmed;
}
