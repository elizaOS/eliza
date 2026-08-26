/** Builds, encrypts, verifies, and generation-fences recovery-window exports. */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/edge";
import { sql } from "drizzle-orm";
import {
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
  listAccountDeletionForeignKeys,
} from "../../db/account-deletion-foreign-key-policy";
import { dbWrite } from "../../db/helpers";
import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import {
  getRuntimeR2Bucket,
  type RuntimeR2Bucket,
  type RuntimeR2Object,
  type RuntimeR2ObjectMetadata,
} from "../storage/r2-runtime-binding";

const EXPORT_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const EXPORT_RETRY_MILLISECONDS = 60 * 1_000;
// Outlive the export worker lease so a stale in-flight put cannot recreate an object after revoke.
const EXPORT_REVOCATION_SAFETY_MILLISECONDS = 15 * 60 * 1_000;
const MAX_ROWS_PER_TABLE = 100_000;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const ENCRYPTED_EXPORT_MAGIC = Buffer.from("ELZXPT01", "ascii");
const REDACTED_SECURITY_MATERIAL = "[REDACTED_SECURITY_MATERIAL]";
const SENSITIVE_COLUMN =
  /(^|_)(access_token|refresh_token|token|secret|password|credential|api_key|private_key|encryption_key|key_hash|hash|ciphertext|nonce|signature|authorization|cookie|session_token)(_|$)/i;

function normalizedFieldName(fieldName: string): string {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

export type AccountDeletionExportErrorCode =
  | "EXPORT_CREDENTIAL_INVALID"
  | "EXPORT_WINDOW_EXPIRED"
  | "EXPORT_UNAVAILABLE"
  | "EXPORT_BUSY"
  | "EXPORT_INTEGRITY_FAILED"
  | "EXPORT_TOO_LARGE";

export class AccountDeletionExportError extends ElizaError {
  override readonly name = "AccountDeletionExportError";

  constructor(message: string, code: AccountDeletionExportErrorCode, cause?: unknown) {
    super(message, {
      code,
      cause,
      severity: code === "EXPORT_BUSY" || code === "EXPORT_UNAVAILABLE" ? "ephemeral" : "fatal",
    });
  }
}

export interface AccountDeletionExportDownload {
  bytes: Uint8Array;
  contentDigest: string;
  filename: string;
}

export interface AccountDeletionExportRevocationResult {
  scheduled: number;
  completed: number;
  pending: number;
}

interface ExportTable {
  table: string;
  rowCount: number;
  rows: unknown[];
  policy?: "portable_subject_data" | "retained_security_audit";
}

type ExplicitExportPath = Readonly<{
  table: string;
  policy: "portable_subject_data" | "retained_security_audit";
  where(input: { userId: string; organizationId: string }): ReturnType<typeof sql>;
}>;

/**
 * Ownership paths that are not direct user/organization foreign keys. Audit
 * rows are exported with security material redacted but remain subject to the
 * separately disclosed retention schedule after account erasure.
 */
const EXPLICIT_EXPORT_PATHS: readonly ExplicitExportPath[] = Object.freeze([
  {
    table: "conversation_messages",
    policy: "portable_subject_data",
    where: ({ userId, organizationId }) => sql`EXISTS (
      SELECT 1 FROM conversations AS parent
      WHERE parent.id = subject.conversation_id
        AND (parent.user_id = ${userId} OR parent.organization_id = ${organizationId})
    )`,
  },
  {
    table: "app_analytics",
    policy: "portable_subject_data",
    where: ({ organizationId }) => sql`EXISTS (
      SELECT 1 FROM apps AS parent
      WHERE parent.id = subject.app_id AND parent.organization_id = ${organizationId}
    )`,
  },
  {
    table: "secret_audit_log",
    policy: "retained_security_audit",
    where: ({ organizationId }) => sql`subject.organization_id = ${organizationId}`,
  },
]);

export interface AccountDeletionExportDependencies {
  collect(input: {
    requestId: string;
    userId: string;
    organizationId: string;
    generatedAt: Date;
  }): Promise<Uint8Array>;
  bucket: RuntimeR2Bucket;
  now(): Date;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exportObjectKey(requestDigest: string): string {
  return `account-deletion-exports/v1/${sha256(`object:${requestDigest}`)}.bin`;
}

function exportKey(recoveryCredential: string, requestDigest: string): Buffer {
  return createHash("sha256")
    .update("eliza-account-export-key-v1\0")
    .update(recoveryCredential)
    .update("\0")
    .update(requestDigest)
    .digest();
}

export function encryptAccountDeletionExport(
  plaintext: Uint8Array,
  recoveryCredential: string,
  requestDigest: string,
  iv = randomBytes(12),
): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", exportKey(recoveryCredential, requestDigest), iv);
  cipher.setAAD(Buffer.from(requestDigest, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ENCRYPTED_EXPORT_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptAccountDeletionExport(
  encrypted: Uint8Array,
  recoveryCredential: string,
  requestDigest: string,
): Uint8Array {
  const bytes = Buffer.from(encrypted);
  if (
    bytes.length < ENCRYPTED_EXPORT_MAGIC.length + 12 + 16 ||
    !bytes.subarray(0, ENCRYPTED_EXPORT_MAGIC.length).equals(ENCRYPTED_EXPORT_MAGIC)
  ) {
    throw new AccountDeletionExportError(
      "Deletion export format is invalid",
      "EXPORT_INTEGRITY_FAILED",
    );
  }
  const ivStart = ENCRYPTED_EXPORT_MAGIC.length;
  const tagStart = ivStart + 12;
  const ciphertextStart = tagStart + 16;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      exportKey(recoveryCredential, requestDigest),
      bytes.subarray(ivStart, tagStart),
    );
    decipher.setAAD(Buffer.from(requestDigest, "utf8"));
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
    return Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]);
  } catch (cause) {
    // error-policy:J2 translate cryptographic rejection into the stable export
    // integrity code while retaining the native cause chain.
    throw new AccountDeletionExportError(
      "Deletion export integrity verification failed",
      "EXPORT_INTEGRITY_FAILED",
      cause,
    );
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe account export schema identifier");
  }
  return `"${identifier}"`;
}

function normalizeExportValue(value: unknown, fieldName?: string): unknown {
  if (fieldName && SENSITIVE_COLUMN.test(normalizedFieldName(fieldName))) {
    return REDACTED_SECURITY_MATERIAL;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return { byteCount: value.byteLength, sha256: sha256(value) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeExportValue(entry));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeExportValue(entry, key)]),
    );
  }
  return String(value);
}

function stableRows(rows: Array<Record<string, unknown>>): unknown[] {
  return rows
    .map((row) => normalizeExportValue(row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function querySubjectRows(input: {
  executor: Pick<typeof dbWrite, "execute">;
  table: string;
  predicates: ReadonlyArray<{ column: string; value: string }>;
}): Promise<{ rows: Array<Record<string, unknown>>; sourceBytes: bigint }> {
  const predicates = input.predicates.map(
    ({ column, value }) => sql`${sql.raw(quoteIdentifier(column))} = ${value}`,
  );
  const where = sql.join(predicates, sql` OR `);
  return querySubjectRowsWhere({ executor: input.executor, table: input.table, where });
}

async function querySubjectRowsWhere(input: {
  executor: Pick<typeof dbWrite, "execute">;
  table: string;
  where: ReturnType<typeof sql>;
}): Promise<{ rows: Array<Record<string, unknown>>; sourceBytes: bigint }> {
  const [bounds] = (
    await input.executor.execute(
      sql`SELECT
            count(*)::text AS row_count,
            COALESCE(sum(pg_column_size(subject)), 0)::text AS byte_count
          FROM ${sql.raw(quoteIdentifier(input.table))} AS subject
          WHERE ${input.where}`,
    )
  ).rows as Array<{ row_count?: unknown; byte_count?: unknown }>;
  let rowCount: bigint;
  let sourceBytes: bigint;
  try {
    rowCount = BigInt(String(bounds?.row_count));
    sourceBytes = BigInt(String(bounds?.byte_count));
  } catch (cause) {
    // error-policy:J2 malformed database aggregates are an integrity failure,
    // never permission to continue with an unbounded export.
    throw new AccountDeletionExportError(
      `Account export bounds for ${input.table} are invalid`,
      "EXPORT_INTEGRITY_FAILED",
      cause,
    );
  }
  if (rowCount > BigInt(MAX_ROWS_PER_TABLE) || sourceBytes > BigInt(MAX_EXPORT_BYTES)) {
    throw new AccountDeletionExportError(
      `Account export table ${input.table} requires streamed support export`,
      "EXPORT_TOO_LARGE",
    );
  }
  const result = await input.executor.execute(
    sql`SELECT * FROM ${sql.raw(quoteIdentifier(input.table))} AS subject
        WHERE ${input.where}
        LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
  );
  if (BigInt(result.rows.length) !== rowCount) {
    throw new AccountDeletionExportError(
      `Account export snapshot for ${input.table} changed during collection`,
      "EXPORT_INTEGRITY_FAILED",
    );
  }
  return {
    rows: result.rows as Array<Record<string, unknown>>,
    sourceBytes,
  };
}

export async function collectPortableAccountDeletionExport(input: {
  requestId: string;
  userId: string;
  organizationId: string;
  generatedAt: Date;
}): Promise<Uint8Array> {
  const grouped = new Map<string, Map<string, { column: string; value: string }>>();
  for (const descriptor of listAccountDeletionForeignKeys()) {
    if (descriptor.sourceColumns.includes(",") || descriptor.targetColumns !== "id") {
      throw new Error("Composite account export authority is unsupported");
    }
    const value = descriptor.targetTable === "users" ? input.userId : input.organizationId;
    const predicates = grouped.get(descriptor.sourceTable) ?? new Map();
    predicates.set(`${descriptor.sourceColumns}:${value}`, {
      column: descriptor.sourceColumns,
      value,
    });
    grouped.set(descriptor.sourceTable, predicates);
  }
  grouped.set(
    "organizations",
    new Map([[`id:${input.organizationId}`, { column: "id", value: input.organizationId }]]),
  );
  grouped.set("users", new Map([[`id:${input.userId}`, { column: "id", value: input.userId }]]));

  const tables = await dbWrite.transaction(
    async (tx) => {
      const snapshotTables: ExportTable[] = [];
      let cumulativeSourceBytes = 0n;
      for (const [table, predicateMap] of [...grouped.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const { rows, sourceBytes } = await querySubjectRows({
          executor: tx,
          table,
          predicates: [...predicateMap.values()],
        });
        cumulativeSourceBytes += sourceBytes;
        if (cumulativeSourceBytes > BigInt(MAX_EXPORT_BYTES)) {
          throw new AccountDeletionExportError(
            "Account export requires a streamed support export",
            "EXPORT_TOO_LARGE",
          );
        }
        if (rows.length === 0) continue;
        snapshotTables.push({ table, rowCount: rows.length, rows: stableRows(rows) });
      }
      for (const path of EXPLICIT_EXPORT_PATHS) {
        const { rows, sourceBytes } = await querySubjectRowsWhere({
          executor: tx,
          table: path.table,
          where: path.where(input),
        });
        cumulativeSourceBytes += sourceBytes;
        if (cumulativeSourceBytes > BigInt(MAX_EXPORT_BYTES)) {
          throw new AccountDeletionExportError(
            "Account export requires a streamed support export",
            "EXPORT_TOO_LARGE",
          );
        }
        if (rows.length === 0) continue;
        snapshotTables.push({
          table: path.table,
          rowCount: rows.length,
          rows: stableRows(rows),
          policy: path.policy,
        });
      }
      return snapshotTables;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  return serializePortableAccountDeletionExport({
    ...input,
    tables,
  });
}

export function serializePortableAccountDeletionExport(input: {
  requestId: string;
  userId: string;
  organizationId: string;
  generatedAt: Date;
  tables: ExportTable[];
  maxBytes?: number;
}): Uint8Array {
  const artifact = {
    format: "eliza-account-export-v1",
    generatedAt: input.generatedAt.toISOString(),
    schemaAuthoritySha256: ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
    requestId: input.requestId,
    subject: {
      userId: input.userId,
      organizationId: input.organizationId,
    },
    retentionNotice:
      "Security credentials are redacted. Legally required tax, billing, fraud-prevention, and security evidence may be retained only under the disclosed retention schedule and is anonymized at account erasure.",
    tables: [...input.tables]
      .sort((left, right) => left.table.localeCompare(right.table))
      .map((table) => ({
        ...table,
        rows: stableRows(table.rows as Array<Record<string, unknown>>),
      })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  if (bytes.byteLength > (input.maxBytes ?? MAX_EXPORT_BYTES)) {
    throw new AccountDeletionExportError(
      "Account export requires a streamed support export",
      "EXPORT_TOO_LARGE",
    );
  }
  return bytes;
}

async function objectBytes(object: RuntimeR2Object): Promise<Uint8Array> {
  if (object.arrayBuffer) return new Uint8Array(await object.arrayBuffer());
  return new TextEncoder().encode(await object.text());
}

async function readVerifiedExportObject(input: {
  bucket: RuntimeR2Bucket;
  objectKey: string;
  recoveryCredential: string;
  requestDigest: string;
  expectedContentDigest?: string | null;
}): Promise<{
  plaintext: Uint8Array;
  contentDigest: string;
  receiptDigest: string;
}> {
  const [head, object] = await Promise.all([
    input.bucket.head?.(input.objectKey),
    input.bucket.get(input.objectKey),
  ]);
  if (!head || !object) {
    throw new AccountDeletionExportError(
      "Deletion export object is unavailable",
      "EXPORT_UNAVAILABLE",
    );
  }
  const encrypted = await objectBytes(object);
  const encryptedDigest = sha256(encrypted);
  if (
    head.customMetadata?.ciphertextDigest !== encryptedDigest ||
    Number(head.customMetadata?.byteCount) !== encrypted.byteLength
  ) {
    throw new AccountDeletionExportError(
      "Deletion export object receipt does not match its bytes",
      "EXPORT_INTEGRITY_FAILED",
    );
  }
  const plaintext = decryptAccountDeletionExport(
    encrypted,
    input.recoveryCredential,
    input.requestDigest,
  );
  const contentDigest = sha256(plaintext);
  if (
    head.customMetadata?.contentDigest !== contentDigest ||
    (input.expectedContentDigest && input.expectedContentDigest !== contentDigest)
  ) {
    throw new AccountDeletionExportError(
      "Deletion export content digest does not match its receipt",
      "EXPORT_INTEGRITY_FAILED",
    );
  }
  return {
    plaintext,
    contentDigest,
    receiptDigest: sha256(
      `r2-export-receipt:v1:${head.version ?? ""}:${head.etag}:${encryptedDigest}`,
    ),
  };
}

async function completeExportRevocation(input: {
  requestId: string;
  requestDigest: string;
  phaseReceiptId: string;
  generation: number;
  now: Date;
}): Promise<boolean> {
  return await accountDeletionRequestsRepository.completeExportRevocation({
    requestId: input.requestId,
    phaseReceiptId: input.phaseReceiptId,
    generation: input.generation,
    providerReceiptDigest: sha256(
      `r2-export-delete-receipt:v1:${exportObjectKey(input.requestDigest)}`,
    ),
    now: input.now,
  });
}

async function reconcileExportRevocationCandidate(input: {
  requestId: string;
  requestDigest: string;
  bucket: RuntimeR2Bucket;
  now: Date;
}): Promise<"completed" | "pending"> {
  const lease = await accountDeletionRequestsRepository.leasePhase({
    requestId: input.requestId,
    phase: "export_revoke",
    leaseOwnerDigest: sha256(randomUUID()),
    now: input.now,
    leaseMilliseconds: EXPORT_LEASE_MILLISECONDS,
  });
  if (!lease) return "pending";
  const objectKey = exportObjectKey(input.requestDigest);

  let existing: RuntimeR2ObjectMetadata | null;
  try {
    existing = (await input.bucket.head?.(objectKey)) ?? null;
  } catch {
    // error-policy:J2 HEAD failed before a provider mutation, so preserve a
    // definite pre-provider retry rather than manufacturing ambiguity.
    await accountDeletionRequestsRepository.markPhaseRetryable({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "EXPORT_REVOCATION_PREFLIGHT_FAILED",
      retryClass: "definite_pre_provider_failure",
      now: input.now,
      retryAt: new Date(input.now.getTime() + EXPORT_RETRY_MILLISECONDS),
    });
    return "pending";
  }

  if (!existing) {
    return (await completeExportRevocation({
      requestId: input.requestId,
      requestDigest: input.requestDigest,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      now: input.now,
    }))
      ? "completed"
      : "pending";
  }

  if (lease.receipt.status === "reconciling") {
    await accountDeletionRequestsRepository.markPhaseRetryable({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "EXPORT_REVOCATION_ABSENCE_CONFIRMED",
      retryClass: "provider_absence_confirmed",
      now: input.now,
      retryAt: new Date(input.now.getTime() + EXPORT_RETRY_MILLISECONDS),
    });
    return "pending";
  }

  const started = await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
    lease.receipt.id,
    lease.generation,
    input.now,
  );
  if (!started) return "pending";
  try {
    await input.bucket.delete(objectKey);
    if (await input.bucket.head?.(objectKey)) {
      throw new AccountDeletionExportError(
        "Deletion export object still exists after revocation",
        "EXPORT_INTEGRITY_FAILED",
      );
    }
    return (await completeExportRevocation({
      requestId: input.requestId,
      requestDigest: input.requestDigest,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      now: input.now,
    }))
      ? "completed"
      : "pending";
  } catch {
    // error-policy:J2 DELETE may have succeeded with a lost response; retain
    // reconciliation state so the next lease proves absence before commit.
    await accountDeletionRequestsRepository.markPhaseForReconciliation({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "EXPORT_REVOCATION_OUTCOME_AMBIGUOUS",
      now: input.now,
      retryAt: new Date(input.now.getTime() + EXPORT_RETRY_MILLISECONDS),
    });
    return "pending";
  }
}

/** Schedules expired artifacts and reconciles conditional R2 deletion receipts. */
export async function reconcileAccountDeletionExportRevocations(
  limit = 25,
  dependencyOverrides: Pick<Partial<AccountDeletionExportDependencies>, "bucket" | "now"> = {},
): Promise<AccountDeletionExportRevocationResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AccountDeletionExportError(
      "Invalid export revocation limit",
      "EXPORT_INTEGRITY_FAILED",
    );
  }
  const now = dependencyOverrides.now?.() ?? new Date();
  const bucket = dependencyOverrides.bucket ?? getRuntimeR2Bucket();
  if (!bucket?.head) {
    throw new AccountDeletionExportError(
      "Deletion export storage is unavailable",
      "EXPORT_UNAVAILABLE",
    );
  }
  const expired = await accountDeletionRequestsRepository.findExpiredExportCandidates(now, limit);
  for (const candidate of expired) {
    await accountDeletionRequestsRepository.ensureExportRevocationPhase({
      requestId: candidate.requestId,
      idempotencyKeyDigest: sha256(`account-deletion-export-revoke:v1:${candidate.requestDigest}`),
      nextAttemptAt: new Date(now.getTime() + EXPORT_REVOCATION_SAFETY_MILLISECONDS),
      now,
    });
  }

  const due = await accountDeletionRequestsRepository.findExportRevocationsDue(now, limit);
  let completed = 0;
  for (const candidate of due) {
    if (
      (await reconcileExportRevocationCandidate({
        ...candidate,
        bucket,
        now,
      })) === "completed"
    ) {
      completed += 1;
    }
  }
  return {
    scheduled: expired.length,
    completed,
    pending: due.length - completed,
  };
}

function validateRecoveryRequest(
  record: Awaited<ReturnType<typeof accountDeletionRequestsRepository.findByRecoveryTokenHash>>,
  now: Date,
) {
  const request = record?.request;
  if (!request) {
    throw new AccountDeletionExportError(
      "Recovery credential is invalid",
      "EXPORT_CREDENTIAL_INVALID",
    );
  }
  if (
    !request.user_id ||
    !request.organization_id ||
    !request.request_digest ||
    !request.recovery_token_expires_at ||
    request.recovery_token_expires_at <= now ||
    (request.status !== "reserved" && request.status !== "recovery")
  ) {
    throw new AccountDeletionExportError(
      "The deletion export window has expired",
      "EXPORT_WINDOW_EXPIRED",
    );
  }
  if (!record.exportReceipt) {
    throw new AccountDeletionExportError(
      "Deletion export receipt is unavailable",
      "EXPORT_UNAVAILABLE",
    );
  }
  return {
    request: {
      ...request,
      user_id: request.user_id,
      organization_id: request.organization_id,
      request_digest: request.request_digest,
    },
    exportReceipt: record.exportReceipt,
  };
}

export async function getAccountDeletionExport(
  recoveryCredential: string,
  dependencyOverrides: Partial<AccountDeletionExportDependencies> = {},
): Promise<AccountDeletionExportDownload> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryCredential)) {
    throw new AccountDeletionExportError(
      "Recovery credential is invalid",
      "EXPORT_CREDENTIAL_INVALID",
    );
  }
  const now = dependencyOverrides.now?.() ?? new Date();
  const record = validateRecoveryRequest(
    await accountDeletionRequestsRepository.findByRecoveryTokenHash(sha256(recoveryCredential)),
    now,
  );
  const bucket = dependencyOverrides.bucket ?? getRuntimeR2Bucket();
  if (!bucket?.head) {
    throw new AccountDeletionExportError(
      "Deletion export storage is unavailable",
      "EXPORT_UNAVAILABLE",
    );
  }
  const collect = dependencyOverrides.collect ?? collectPortableAccountDeletionExport;
  const objectKey = exportObjectKey(record.request.request_digest);

  if (record.exportReceipt.status === "ready") {
    const verified = await readVerifiedExportObject({
      bucket,
      objectKey,
      recoveryCredential,
      requestDigest: record.request.request_digest,
      expectedContentDigest: record.exportReceipt.content_digest,
    });
    return {
      bytes: verified.plaintext,
      contentDigest: verified.contentDigest,
      filename: "eliza-account-export.json",
    };
  }

  const lease = await accountDeletionRequestsRepository.leasePhase({
    requestId: record.request.id,
    phase: "export",
    leaseOwnerDigest: sha256(randomUUID()),
    now,
    leaseMilliseconds: EXPORT_LEASE_MILLISECONDS,
  });
  if (!lease) {
    throw new AccountDeletionExportError(
      "Deletion export is already being prepared",
      "EXPORT_BUSY",
    );
  }

  if (lease.receipt.status === "reconciling") {
    try {
      const verified = await readVerifiedExportObject({
        bucket,
        objectKey,
        recoveryCredential,
        requestDigest: record.request.request_digest,
      });
      const committed = await accountDeletionRequestsRepository.completeExportPhase({
        requestId: record.request.id,
        phaseReceiptId: lease.receipt.id,
        generation: lease.generation,
        contentDigest: verified.contentDigest,
        objectReceiptDigest: verified.receiptDigest,
        byteCount: verified.plaintext.byteLength,
        now,
      });
      if (!committed) {
        throw new AccountDeletionExportError(
          "Deletion export lease changed during reconciliation",
          "EXPORT_BUSY",
        );
      }
      return {
        bytes: verified.plaintext,
        contentDigest: verified.contentDigest,
        filename: "eliza-account-export.json",
      };
    } catch (error) {
      // error-policy:J2 persist whether the provider object is definitely
      // absent before rethrowing the typed reconciliation failure.
      if (error instanceof AccountDeletionExportError && error.code === "EXPORT_UNAVAILABLE") {
        await accountDeletionRequestsRepository.markPhaseRetryable({
          phaseReceiptId: lease.receipt.id,
          generation: lease.generation,
          errorCode: "EXPORT_OBJECT_ABSENCE_CONFIRMED",
          retryClass: "provider_absence_confirmed",
          now,
          retryAt: new Date(now.getTime() + EXPORT_RETRY_MILLISECONDS),
        });
      }
      throw error;
    }
  }

  const building = await accountDeletionRequestsRepository.markExportBuilding({
    requestId: record.request.id,
    phaseReceiptId: lease.receipt.id,
    generation: lease.generation,
    now,
  });
  if (!building) {
    throw new AccountDeletionExportError(
      "Deletion export lease changed before collection",
      "EXPORT_BUSY",
    );
  }

  let plaintext: Uint8Array;
  try {
    plaintext = await collect({
      requestId: record.request.id,
      userId: record.request.user_id,
      organizationId: record.request.organization_id,
      generatedAt: now,
    });
  } catch (error) {
    // error-policy:J2 persist a definite pre-provider retry classification
    // before returning the original collection failure to the boundary.
    await accountDeletionRequestsRepository.markPhaseRetryable({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode:
        error instanceof AccountDeletionExportError ? error.code : "EXPORT_COLLECTION_FAILED",
      retryClass: "definite_pre_provider_failure",
      now,
      retryAt: new Date(now.getTime() + EXPORT_RETRY_MILLISECONDS),
    });
    throw error;
  }
  const contentDigest = sha256(plaintext);
  const encrypted = encryptAccountDeletionExport(
    plaintext,
    recoveryCredential,
    record.request.request_digest,
  );
  const encryptedDigest = sha256(encrypted);
  const started = await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
    lease.receipt.id,
    lease.generation,
    now,
  );
  if (!started) {
    throw new AccountDeletionExportError(
      "Deletion export lease changed before object storage",
      "EXPORT_BUSY",
    );
  }

  try {
    await bucket.put(objectKey, encrypted, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        format: "eliza-account-export-v1",
        contentDigest,
        ciphertextDigest: encryptedDigest,
        byteCount: String(encrypted.byteLength),
      },
      sha256: encryptedDigest,
    });
    const verified = await readVerifiedExportObject({
      bucket,
      objectKey,
      recoveryCredential,
      requestDigest: record.request.request_digest,
      expectedContentDigest: contentDigest,
    });
    const committed = await accountDeletionRequestsRepository.completeExportPhase({
      requestId: record.request.id,
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      contentDigest,
      objectReceiptDigest: verified.receiptDigest,
      byteCount: plaintext.byteLength,
      now,
    });
    if (!committed) {
      throw new AccountDeletionExportError(
        "Deletion export object exists but its receipt lease changed",
        "EXPORT_BUSY",
      );
    }
    return {
      bytes: plaintext,
      contentDigest,
      filename: "eliza-account-export.json",
    };
  } catch (error) {
    // error-policy:J2 the object-store outcome may be successful despite this
    // rejection, so preserve reconciliation evidence before rethrowing.
    await accountDeletionRequestsRepository.markPhaseForReconciliation({
      phaseReceiptId: lease.receipt.id,
      generation: lease.generation,
      errorCode: "EXPORT_OBJECT_OUTCOME_AMBIGUOUS",
      now,
      retryAt: new Date(now.getTime() + EXPORT_RETRY_MILLISECONDS),
    });
    throw error;
  }
}
