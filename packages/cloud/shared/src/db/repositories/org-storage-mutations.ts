/**
 * Owns the transactionally serialized authority for native organization PUTs.
 * Provider I/O stays outside transactions; leases and immutable generation
 * keys make its ambiguous outcomes recoverable by a strong R2 HEAD.
 */
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { dbWrite, writeTransaction } from "../helpers";
import {
  type OrgStorageDeleteOperation,
  type OrgStorageObject,
  type OrgStoragePutOperation,
  orgStorageDeleteOperations,
  orgStorageGcOutbox,
  orgStorageObjects,
  orgStoragePutOperations,
} from "../schemas/org-storage-mutations";
import { orgStorageQuota } from "../schemas/org-storage-quota";
import { DEFAULT_ORG_STORAGE_BYTES_LIMIT } from "./org-storage-quota";

const GC_PIN_MS = 24 * 60 * 60 * 1000;
const MAX_DUE_BATCH = 100;

export class StoragePutConflictError extends Error {
  constructor(public readonly reason: "idempotency_mismatch" | "object_busy" | "stale_lease") {
    super(`Native storage PUT conflict: ${reason}`);
    this.name = "StoragePutConflictError";
  }
}

export class StorageQuotaExceededError extends Error {
  constructor() {
    super("Storage quota exceeded for this organization");
    this.name = "StorageQuotaExceededError";
  }
}

export interface PrepareStoragePutInput {
  organizationId: string;
  logicalKey: string;
  idempotencyKeyHash: string;
  requestDigest: string;
  sizeBytes: bigint;
  contentType: string;
  contentSha256: string;
  priceUsd: string;
}

export interface PreparedStoragePut {
  operation: OrgStoragePutOperation;
  replay: boolean;
}

export interface ReservedStoragePut {
  operation: OrgStoragePutOperation;
  insufficient: boolean;
  available: number;
}

export interface LegacyStorageObjectCandidate {
  organizationId: string;
  logicalKey: string;
  providerKey: string;
  sizeBytes: bigint;
  contentType: string;
  etag: string;
  uploadedAt: Date;
}

function providerKey(organizationId: string, objectId: string, generation: bigint): string {
  return `__eliza_storage_authority/v2/org/${organizationId}/${objectId}/${generation}`;
}

function requiredRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`[NativeStoragePut] ${label} returned no row`);
  return row;
}

function bigintValue(value: bigint | string | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function normalizeObject(row: OrgStorageObject): OrgStorageObject {
  return {
    ...row,
    generation: bigintValue(row.generation),
    size_bytes: bigintValue(row.size_bytes),
  };
}

function normalizeOperation(row: OrgStoragePutOperation): OrgStoragePutOperation {
  return {
    ...row,
    source_generation: bigintValue(row.source_generation),
    source_size_bytes: bigintValue(row.source_size_bytes),
    target_generation: bigintValue(row.target_generation),
    target_size_bytes: bigintValue(row.target_size_bytes),
    quota_reserved_bytes: bigintValue(row.quota_reserved_bytes),
  };
}

export class OrgStorageMutationsRepository {
  async preparePut(input: PrepareStoragePutInput): Promise<PreparedStoragePut> {
    return await writeTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.logicalKey}`}, 0))`,
      );

      const existing = await tx.query.orgStoragePutOperations.findFirst({
        where: and(
          eq(orgStoragePutOperations.organization_id, input.organizationId),
          eq(orgStoragePutOperations.idempotency_key_hash, input.idempotencyKeyHash),
        ),
      });
      if (existing) {
        if (existing.request_digest !== input.requestDigest) {
          throw new StoragePutConflictError("idempotency_mismatch");
        }
        return { operation: existing, replay: true };
      }

      await tx
        .insert(orgStorageObjects)
        .values({ organization_id: input.organizationId, logical_key: input.logicalKey })
        .onConflictDoNothing();

      const objectRows = await sqlRows<OrgStorageObject>(
        tx,
        sql`SELECT * FROM ${orgStorageObjects}
          WHERE ${orgStorageObjects.organization_id} = ${input.organizationId}
            AND ${orgStorageObjects.logical_key} = ${input.logicalKey}
          FOR UPDATE`,
      );
      const object = normalizeObject(requiredRow(objectRows, "object lock"));

      const active = await tx.query.orgStoragePutOperations.findFirst({
        where: and(
          eq(orgStoragePutOperations.object_id, object.id),
          inArray(orgStoragePutOperations.state, [
            "prepared",
            "reserved",
            "provider_started",
            "reconciling",
          ]),
        ),
      });
      if (active) throw new StoragePutConflictError("object_busy");
      const activeDelete = await tx.query.orgStorageDeleteOperations.findFirst({
        where: and(
          eq(orgStorageDeleteOperations.object_id, object.id),
          inArray(orgStorageDeleteOperations.state, ["prepared", "provider_started"]),
        ),
      });
      if (activeDelete) throw new StoragePutConflictError("object_busy");

      const quotaReserved =
        input.sizeBytes > object.size_bytes ? input.sizeBytes - object.size_bytes : 0n;
      await tx
        .insert(orgStorageQuota)
        .values({
          organization_id: input.organizationId,
          bytes_used: 0n,
          bytes_limit: DEFAULT_ORG_STORAGE_BYTES_LIMIT,
        })
        .onConflictDoNothing();
      const quotaRows = await sqlRows<{ bytes_used: bigint }>(
        tx,
        sql`UPDATE ${orgStorageQuota}
          SET bytes_used = ${orgStorageQuota.bytes_used} + ${quotaReserved},
              updated_at = NOW()
          WHERE ${orgStorageQuota.organization_id} = ${input.organizationId}
            AND ${orgStorageQuota.bytes_used} + ${quotaReserved} <= ${orgStorageQuota.bytes_limit}
          RETURNING ${orgStorageQuota.bytes_used}`,
      );
      if (quotaRows.length === 0) throw new StorageQuotaExceededError();

      const targetGeneration = object.generation + 1n;
      const inserted = await tx
        .insert(orgStoragePutOperations)
        .values({
          organization_id: input.organizationId,
          object_id: object.id,
          idempotency_key_hash: input.idempotencyKeyHash,
          request_digest: input.requestDigest,
          source_generation: object.generation,
          source_provider_key: object.provider_key,
          source_size_bytes: object.size_bytes,
          target_generation: targetGeneration,
          target_provider_key: providerKey(input.organizationId, object.id, targetGeneration),
          target_size_bytes: input.sizeBytes,
          target_content_type: input.contentType,
          target_content_sha256: input.contentSha256,
          quota_reserved_bytes: quotaReserved,
          price_usd: input.priceUsd,
        })
        .returning();
      return { operation: requiredRow(inserted, "operation insert"), replay: false };
    });
  }

  async reservePutCredits(params: {
    operationId: string;
    organizationId: string;
  }): Promise<ReservedStoragePut> {
    return await writeTransaction(async (tx) => {
      const rows = await sqlRows<OrgStoragePutOperation>(
        tx,
        sql`SELECT * FROM ${orgStoragePutOperations}
          WHERE id = ${params.operationId}
            AND organization_id = ${params.organizationId}
          FOR UPDATE`,
      );
      const operation = normalizeOperation(requiredRow(rows, "credit reservation lock"));
      if (operation.state !== "prepared") {
        if (["reserved", "provider_started", "committed"].includes(operation.state)) {
          return { operation, insufficient: false, available: 0 };
        }
        throw new StoragePutConflictError("stale_lease");
      }
      if (Number(operation.price_usd) === 0) {
        const reserved = await tx
          .update(orgStoragePutOperations)
          .set({ state: "reserved", updated_at: new Date() })
          .where(eq(orgStoragePutOperations.id, operation.id))
          .returning();
        return {
          operation: normalizeOperation(requiredRow(reserved, "zero-cost reservation")),
          insufficient: false,
          available: 0,
        };
      }

      const balanceRows = await sqlRows<{ credit_balance: string }>(
        tx,
        sql`UPDATE organizations
          SET credit_balance = credit_balance - CAST(${String(operation.price_usd)} AS numeric),
              updated_at = NOW()
          WHERE id = ${params.organizationId}
            AND credit_balance >= CAST(${String(operation.price_usd)} AS numeric)
          RETURNING credit_balance`,
      );
      if (balanceRows.length === 0) {
        const availableRows = await sqlRows<{ credit_balance: string }>(
          tx,
          sql`SELECT credit_balance FROM organizations
            WHERE id = ${params.organizationId} FOR UPDATE`,
        );
        const quotaRows = await sqlRows<{ bytes_used: bigint }>(
          tx,
          sql`UPDATE ${orgStorageQuota}
            SET bytes_used = ${orgStorageQuota.bytes_used} - ${operation.quota_reserved_bytes},
                updated_at = NOW()
            WHERE ${orgStorageQuota.organization_id} = ${params.organizationId}
              AND ${orgStorageQuota.bytes_used} >= ${operation.quota_reserved_bytes}
            RETURNING ${orgStorageQuota.bytes_used}`,
        );
        requiredRow(quotaRows, "insufficient-credit quota release");
        const responseJson = JSON.stringify({ error: "Insufficient credits" });
        const refunded = await tx
          .update(orgStoragePutOperations)
          .set({
            state: "refunded",
            response_json: responseJson,
            completed_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(orgStoragePutOperations.id, operation.id))
          .returning();
        return {
          operation: normalizeOperation(requiredRow(refunded, "insufficient-credit receipt")),
          insufficient: true,
          available: Number(requiredRow(availableRows, "organization balance").credit_balance),
        };
      }

      const metadata = JSON.stringify({
        type: "reservation",
        settlement_marker: "credit_reservation_v1",
        storage_operation_id: operation.id,
        reserved_amount: Number(operation.price_usd),
      });
      const holdRows = await sqlRows<{ id: string }>(
        tx,
        sql`INSERT INTO credit_transactions (
            organization_id, amount, type, description, metadata, created_at
          ) VALUES (
            ${params.organizationId}, -CAST(${String(operation.price_usd)} AS numeric),
            'debit', 'API proxy: storage — native put (reserved)', ${metadata}::jsonb, NOW()
          ) RETURNING id`,
      );
      const holdId = requiredRow(holdRows, "credit reservation insert").id;
      const reserved = await tx
        .update(orgStoragePutOperations)
        .set({ state: "reserved", credit_transaction_id: holdId, updated_at: new Date() })
        .where(eq(orgStoragePutOperations.id, operation.id))
        .returning();
      return {
        operation: normalizeOperation(requiredRow(reserved, "credit reservation attach")),
        insufficient: false,
        available: Number(requiredRow(balanceRows, "credit balance debit").credit_balance),
      };
    });
  }

  async claimProviderLease(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<OrgStoragePutOperation> {
    const rows = await writeTransaction(
      async (tx) =>
        await tx
          .update(orgStoragePutOperations)
          .set({
            state: "provider_started",
            lease_token: params.leaseToken,
            lease_expires_at: params.leaseExpiresAt,
            updated_at: params.now,
          })
          .where(
            and(
              eq(orgStoragePutOperations.id, params.operationId),
              eq(orgStoragePutOperations.organization_id, params.organizationId),
              or(
                eq(orgStoragePutOperations.state, "reserved"),
                and(
                  eq(orgStoragePutOperations.state, "provider_started"),
                  lt(orgStoragePutOperations.lease_expires_at, params.now),
                ),
              ),
            ),
          )
          .returning(),
    );
    if (!rows[0]) throw new StoragePutConflictError("stale_lease");
    return rows[0];
  }

  async claimReconciliationLease(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    staleBefore: Date;
    now: Date;
  }): Promise<OrgStoragePutOperation> {
    const rows = await writeTransaction(async (tx) =>
      sqlRows<OrgStoragePutOperation>(
        tx,
        sql`UPDATE ${orgStoragePutOperations} AS operation
          SET state = CASE
                WHEN operation.state = 'provider_started' THEN 'provider_started'
                ELSE 'reconciling'
              END,
              lease_token = ${params.leaseToken},
              lease_expires_at = ${params.leaseExpiresAt},
              updated_at = ${params.now}
          WHERE operation.id = ${params.operationId}
            AND operation.organization_id = ${params.organizationId}
            AND ((operation.state = 'prepared' AND operation.created_at < ${params.staleBefore})
              OR (operation.state = 'reserved' AND operation.updated_at < ${params.staleBefore})
              OR (operation.state = 'reconciling' AND operation.lease_expires_at < ${params.now})
              OR (operation.state = 'provider_started' AND operation.lease_expires_at < ${params.now}))
          RETURNING operation.*`,
      ),
    );
    if (!rows[0]) throw new StoragePutConflictError("stale_lease");
    return normalizeOperation(rows[0]);
  }

  async deferProviderAbsence(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    observedAt: Date;
    recheckAt: Date;
  }): Promise<OrgStoragePutOperation> {
    const rows = await writeTransaction(
      async (tx) =>
        await tx
          .update(orgStoragePutOperations)
          .set({
            state: "reconciling",
            provider_absence_observed_at: params.observedAt,
            lease_expires_at: params.recheckAt,
            updated_at: params.observedAt,
          })
          .where(
            and(
              eq(orgStoragePutOperations.id, params.operationId),
              eq(orgStoragePutOperations.organization_id, params.organizationId),
              eq(orgStoragePutOperations.state, "provider_started"),
              eq(orgStoragePutOperations.lease_token, params.leaseToken),
            ),
          )
          .returning(),
    );
    if (!rows[0]) throw new StoragePutConflictError("stale_lease");
    return normalizeOperation(rows[0]);
  }

  async commitObservedPut(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    etag: string;
    uploadedAt: Date;
    responseJson: string;
  }): Promise<OrgStoragePutOperation> {
    return await writeTransaction(async (tx) => {
      const operationRows = await sqlRows<OrgStoragePutOperation>(
        tx,
        sql`SELECT * FROM ${orgStoragePutOperations}
          WHERE ${orgStoragePutOperations.id} = ${params.operationId}
            AND ${orgStoragePutOperations.organization_id} = ${params.organizationId}
          FOR UPDATE`,
      );
      const operation = normalizeOperation(requiredRow(operationRows, "operation commit lock"));
      if (operation.state === "committed") return operation;
      if (
        !["provider_started", "reconciling"].includes(operation.state) ||
        operation.lease_token !== params.leaseToken
      ) {
        throw new StoragePutConflictError("stale_lease");
      }

      const objectRows = await sqlRows<OrgStorageObject>(
        tx,
        sql`SELECT * FROM ${orgStorageObjects}
          WHERE ${orgStorageObjects.id} = ${operation.object_id}
            AND ${orgStorageObjects.organization_id} = ${params.organizationId}
          FOR UPDATE`,
      );
      const object = normalizeObject(requiredRow(objectRows, "object commit lock"));
      if (object.generation !== operation.source_generation) {
        throw new StoragePutConflictError("object_busy");
      }

      if (Number(operation.price_usd) > 0) {
        const settled = await sqlRows<{ id: string }>(
          tx,
          sql`UPDATE credit_transactions
            SET settled_at = NOW()
            WHERE id = ${operation.credit_transaction_id}
              AND organization_id = ${params.organizationId}
              AND type = 'debit'
              AND amount = -CAST(${String(operation.price_usd)} AS numeric)
              AND settled_at IS NULL
              AND metadata->>'type' = 'reservation'
              AND metadata->>'settlement_marker' = 'credit_reservation_v1'
              AND metadata->>'storage_operation_id' = ${operation.id}
            RETURNING id`,
        );
        requiredRow(settled, "credit settlement");
      }

      const finalDelta =
        operation.target_size_bytes - operation.source_size_bytes - operation.quota_reserved_bytes;
      const quotaRows = await sqlRows<{ bytes_used: bigint }>(
        tx,
        sql`UPDATE ${orgStorageQuota}
          SET bytes_used = ${orgStorageQuota.bytes_used} + ${finalDelta},
              updated_at = NOW()
          WHERE ${orgStorageQuota.organization_id} = ${params.organizationId}
            AND ${orgStorageQuota.bytes_used} + ${finalDelta} >= 0
          RETURNING ${orgStorageQuota.bytes_used}`,
      );
      requiredRow(quotaRows, "quota finalization");

      await tx
        .update(orgStorageObjects)
        .set({
          generation: operation.target_generation,
          provider_key: operation.target_provider_key,
          size_bytes: operation.target_size_bytes,
          content_type: operation.target_content_type,
          content_sha256: operation.target_content_sha256,
          etag: params.etag,
          uploaded_at: params.uploadedAt,
          deleted_at: null,
          updated_at: new Date(),
        })
        .where(eq(orgStorageObjects.id, object.id));

      if (operation.source_provider_key) {
        await tx
          .insert(orgStorageGcOutbox)
          .values({
            organization_id: params.organizationId,
            operation_id: operation.id,
            provider_key: operation.source_provider_key,
            not_before: new Date(Date.now() + GC_PIN_MS),
          })
          .onConflictDoNothing();
      }

      const committed = await tx
        .update(orgStoragePutOperations)
        .set({
          state: "committed",
          result_etag: params.etag,
          result_uploaded_at: params.uploadedAt,
          response_json: params.responseJson,
          completed_at: new Date(),
          lease_token: null,
          lease_expires_at: null,
          provider_absence_observed_at: null,
          updated_at: new Date(),
        })
        .where(eq(orgStoragePutOperations.id, operation.id))
        .returning();
      return requiredRow(committed, "operation commit");
    });
  }

  async finalizeRefund(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    responseJson: string;
  }): Promise<OrgStoragePutOperation> {
    return await writeTransaction(async (tx) => {
      const rows = await sqlRows<OrgStoragePutOperation>(
        tx,
        sql`SELECT * FROM ${orgStoragePutOperations}
          WHERE ${orgStoragePutOperations.id} = ${params.operationId}
            AND ${orgStoragePutOperations.organization_id} = ${params.organizationId}
          FOR UPDATE`,
      );
      const operation = normalizeOperation(requiredRow(rows, "refund lock"));
      if (operation.state === "refunded") return operation;
      if (
        !["reconciling", "provider_started"].includes(operation.state) ||
        operation.lease_token !== params.leaseToken
      ) {
        throw new StoragePutConflictError("stale_lease");
      }

      if (Number(operation.price_usd) > 0) {
        const holdRows = await sqlRows<{ id: string; settled_at: Date | null }>(
          tx,
          operation.credit_transaction_id
            ? sql`SELECT id, settled_at FROM credit_transactions
                WHERE id = ${operation.credit_transaction_id}
                  AND organization_id = ${params.organizationId}
                  AND type = 'debit'
                  AND amount = -CAST(${String(operation.price_usd)} AS numeric)
                  AND metadata->>'type' = 'reservation'
                  AND metadata->>'settlement_marker' = 'credit_reservation_v1'
                  AND metadata->>'storage_operation_id' = ${operation.id}
                FOR UPDATE`
            : sql`SELECT id, settled_at FROM credit_transactions
                WHERE organization_id = ${params.organizationId}
                  AND type = 'debit'
                  AND amount = -CAST(${String(operation.price_usd)} AS numeric)
                  AND metadata->>'type' = 'reservation'
                  AND metadata->>'settlement_marker' = 'credit_reservation_v1'
                  AND metadata->>'storage_operation_id' = ${operation.id}
                ORDER BY created_at ASC
                FOR UPDATE`,
        );
        if (
          holdRows.length > 1 ||
          (operation.credit_transaction_id !== null && holdRows.length !== 1) ||
          holdRows[0]?.settled_at
        ) {
          throw new Error("[NativeStoragePut] refundable credit hold is missing or ambiguous");
        }
        if (holdRows[0]) {
          const holdId = holdRows[0].id;
          const refundMetadata = JSON.stringify({
            type: "storage_put_refund",
            storage_operation_id: operation.id,
            reservation_transaction_id: holdId,
          });
          const organizationRows = await sqlRows<{ id: string }>(
            tx,
            sql`UPDATE organizations
              SET credit_balance = credit_balance + CAST(${String(operation.price_usd)} AS numeric),
                  updated_at = NOW()
              WHERE id = ${params.organizationId}
              RETURNING id`,
          );
          requiredRow(organizationRows, "credit refund balance");
          await tx.execute(sql`INSERT INTO credit_transactions (
              organization_id, amount, type, description, metadata, created_at
            ) VALUES (
              ${params.organizationId}, CAST(${String(operation.price_usd)} AS numeric),
              'refund', 'API proxy: storage — native put (refund)',
              ${refundMetadata}::jsonb, NOW()
            )`);
          const settled = await sqlRows<{ id: string }>(
            tx,
            sql`UPDATE credit_transactions
              SET settled_at = NOW()
              WHERE id = ${holdId} AND settled_at IS NULL
              RETURNING id`,
          );
          requiredRow(settled, "credit refund settlement");
        }
      }
      const quotaRows = await sqlRows<{ bytes_used: bigint }>(
        tx,
        sql`UPDATE ${orgStorageQuota}
          SET bytes_used = ${orgStorageQuota.bytes_used} - ${operation.quota_reserved_bytes},
              updated_at = NOW()
          WHERE ${orgStorageQuota.organization_id} = ${params.organizationId}
            AND ${orgStorageQuota.bytes_used} >= ${operation.quota_reserved_bytes}
          RETURNING ${orgStorageQuota.bytes_used}`,
      );
      requiredRow(quotaRows, "quota refund");
      const refunded = await tx
        .update(orgStoragePutOperations)
        .set({
          state: "refunded",
          response_json: params.responseJson,
          completed_at: new Date(),
          lease_token: null,
          lease_expires_at: null,
          provider_absence_observed_at: null,
          updated_at: new Date(),
        })
        .where(eq(orgStoragePutOperations.id, operation.id))
        .returning();
      return requiredRow(refunded, "operation refund");
    });
  }

  async findOperation(
    organizationId: string,
    operationId: string,
  ): Promise<OrgStoragePutOperation | undefined> {
    return await dbWrite.query.orgStoragePutOperations.findFirst({
      where: and(
        eq(orgStoragePutOperations.id, operationId),
        eq(orgStoragePutOperations.organization_id, organizationId),
      ),
    });
  }

  async findObject(
    organizationId: string,
    logicalKey: string,
  ): Promise<OrgStorageObject | undefined> {
    return await dbWrite.query.orgStorageObjects.findFirst({
      where: and(
        eq(orgStorageObjects.organization_id, organizationId),
        eq(orgStorageObjects.logical_key, logicalKey),
      ),
    });
  }

  async adoptLegacyObject(input: LegacyStorageObjectCandidate): Promise<OrgStorageObject> {
    return await writeTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.logicalKey}`}, 0))`,
      );
      await tx
        .insert(orgStorageObjects)
        .values({ organization_id: input.organizationId, logical_key: input.logicalKey })
        .onConflictDoNothing();
      const rows = await sqlRows<OrgStorageObject>(
        tx,
        sql`SELECT * FROM ${orgStorageObjects}
          WHERE organization_id = ${input.organizationId}
            AND logical_key = ${input.logicalKey}
          FOR UPDATE`,
      );
      const object = normalizeObject(requiredRow(rows, "legacy adoption lock"));
      if (object.provider_key || object.generation > 0n || object.deleted_at) return object;
      const adopted = await tx
        .update(orgStorageObjects)
        .set({
          provider_key: input.providerKey,
          size_bytes: input.sizeBytes,
          content_type: input.contentType,
          etag: input.etag,
          uploaded_at: input.uploadedAt,
          updated_at: new Date(),
        })
        .where(eq(orgStorageObjects.id, object.id))
        .returning();
      return normalizeObject(requiredRow(adopted, "legacy adoption"));
    });
  }

  async adoptLegacyObjects(inputs: LegacyStorageObjectCandidate[]): Promise<void> {
    if (inputs.length === 0) return;
    const organizationId = inputs[0]?.organizationId;
    if (!organizationId || inputs.some((input) => input.organizationId !== organizationId)) {
      throw new Error("[NativeStoragePut] bulk legacy adoption must belong to one tenant");
    }
    const candidates = JSON.stringify(
      inputs.map((input) => ({
        logical_key: input.logicalKey,
        provider_key: input.providerKey,
        size_bytes: input.sizeBytes.toString(),
        content_type: input.contentType,
        etag: input.etag,
        uploaded_at: input.uploadedAt.toISOString(),
      })),
    );
    await writeTransaction(async (tx) => {
      await tx.execute(sql`WITH candidates AS (
          SELECT logical_key, provider_key, size_bytes::bigint,
            content_type, etag, uploaded_at::timestamptz
          FROM jsonb_to_recordset(${candidates}::jsonb) AS candidate(
            logical_key text, provider_key text, size_bytes text,
            content_type text, etag text, uploaded_at text
          )
        )
        INSERT INTO ${orgStorageObjects} (
          organization_id, logical_key, provider_key, size_bytes,
          content_type, etag, uploaded_at, updated_at
        )
        SELECT ${organizationId}, logical_key, provider_key, size_bytes,
          content_type, etag, uploaded_at, NOW()
        FROM candidates
        ON CONFLICT (organization_id, logical_key) DO UPDATE SET
          provider_key = EXCLUDED.provider_key,
          size_bytes = EXCLUDED.size_bytes,
          content_type = EXCLUDED.content_type,
          etag = EXCLUDED.etag,
          uploaded_at = EXCLUDED.uploaded_at,
          updated_at = NOW()
        WHERE ${orgStorageObjects.generation} = 0
          AND ${orgStorageObjects.provider_key} IS NULL
          AND ${orgStorageObjects.deleted_at} IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${orgStoragePutOperations} AS active_put
            WHERE active_put.object_id = ${orgStorageObjects.id}
              AND active_put.state IN ('prepared','reserved','provider_started','reconciling')
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${orgStorageDeleteOperations} AS active_delete
            WHERE active_delete.object_id = ${orgStorageObjects.id}
              AND active_delete.state IN ('prepared','provider_started')
          )`);
    });
  }

  async quotaNeedsNativeCatalogReconciliation(organizationId: string): Promise<boolean> {
    await dbWrite
      .insert(orgStorageQuota)
      .values({
        organization_id: organizationId,
        bytes_used: 0n,
        bytes_limit: DEFAULT_ORG_STORAGE_BYTES_LIMIT,
      })
      .onConflictDoNothing();
    const quota = await dbWrite.query.orgStorageQuota.findFirst({
      where: eq(orgStorageQuota.organization_id, organizationId),
      columns: { native_catalog_reconciled_at: true },
    });
    return !quota?.native_catalog_reconciled_at;
  }

  async reconcileNativeQuotaFromCatalog(organizationId: string): Promise<bigint> {
    return await writeTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`storage-quota:${organizationId}`}, 0))`,
      );
      const quotaLock = await sqlRows<{ organization_id: string }>(
        tx,
        sql`SELECT organization_id FROM ${orgStorageQuota}
          WHERE organization_id = ${organizationId}
          FOR UPDATE`,
      );
      requiredRow(quotaLock, "native quota lock");
      const rows = await sqlRows<{ bytes_used: bigint }>(
        tx,
        sql`WITH catalog AS (
              SELECT COALESCE(SUM(size_bytes), 0) AS bytes
              FROM ${orgStorageObjects}
              WHERE organization_id = ${organizationId}
                AND deleted_at IS NULL AND provider_key IS NOT NULL
            ), reservations AS (
              SELECT COALESCE(SUM(quota_reserved_bytes), 0) AS bytes
              FROM ${orgStoragePutOperations}
              WHERE organization_id = ${organizationId}
                AND state IN ('prepared','reserved','provider_started','reconciling')
            )
            UPDATE ${orgStorageQuota}
            SET bytes_used = (catalog.bytes + reservations.bytes)::bigint,
                native_catalog_reconciled_at = NOW(),
                updated_at = NOW()
            FROM catalog, reservations
            WHERE ${orgStorageQuota.organization_id} = ${organizationId}
            RETURNING ${orgStorageQuota.bytes_used}`,
      );
      return bigintValue(requiredRow(rows, "native quota reconciliation").bytes_used);
    });
  }

  async listObjects(
    organizationId: string,
    prefix: string,
    limit = 1001,
    recursive = true,
  ): Promise<OrgStorageObject[]> {
    const escapedPrefix = prefix
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = await sqlRows<OrgStorageObject>(
      dbWrite,
      sql`SELECT * FROM ${orgStorageObjects}
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND provider_key IS NOT NULL
          AND logical_key LIKE ${`${escapedPrefix}%`} ESCAPE '\\'
          AND (${recursive} OR POSITION('/' IN LTRIM(
            SUBSTRING(logical_key FROM char_length(${prefix}) + 1), '/'
          )) = 0)
        ORDER BY logical_key ASC
        LIMIT ${Math.max(1, Math.min(limit, 1001))}`,
    );
    return rows.map(normalizeObject);
  }

  async listDueOperations(now: Date, limit = MAX_DUE_BATCH): Promise<OrgStoragePutOperation[]> {
    const preparedBefore = new Date(now.getTime() - 10 * 60 * 1000);
    return await dbWrite.query.orgStoragePutOperations.findMany({
      where: or(
        and(
          eq(orgStoragePutOperations.state, "prepared"),
          lt(orgStoragePutOperations.created_at, preparedBefore),
        ),
        and(
          eq(orgStoragePutOperations.state, "reserved"),
          lt(orgStoragePutOperations.updated_at, preparedBefore),
        ),
        and(
          eq(orgStoragePutOperations.state, "provider_started"),
          lt(orgStoragePutOperations.lease_expires_at, now),
        ),
        and(
          eq(orgStoragePutOperations.state, "reconciling"),
          lt(orgStoragePutOperations.lease_expires_at, now),
        ),
      ),
      orderBy: (table, { asc }) => [asc(table.created_at)],
      limit: Math.max(1, Math.min(limit, MAX_DUE_BATCH)),
    });
  }

  async listDueGc(now: Date, limit = MAX_DUE_BATCH) {
    return await sqlRows<typeof orgStorageGcOutbox.$inferSelect>(
      dbWrite,
      sql`SELECT gc.* FROM ${orgStorageGcOutbox} gc
        WHERE gc.state = 'pending'
          AND gc.not_before < ${now}
          AND NOT EXISTS (
            SELECT 1 FROM org_storage_read_operations read
            WHERE read.provider_key = gc.provider_key
              AND read.state IN ('provider_succeeded', 'committed')
              AND read.retain_until > ${now}
          )
        ORDER BY gc.created_at ASC
        LIMIT ${Math.max(1, Math.min(limit, MAX_DUE_BATCH))}`,
    );
  }

  async completeGc(id: string): Promise<void> {
    await writeTransaction(async (tx) => {
      await tx
        .update(orgStorageGcOutbox)
        .set({ state: "completed", completed_at: new Date() })
        .where(and(eq(orgStorageGcOutbox.id, id), eq(orgStorageGcOutbox.state, "pending")));
    });
  }

  async prepareDelete(input: {
    organizationId: string;
    logicalKey: string;
    idempotencyKeyHash: string;
    requestDigest: string;
  }): Promise<{ operation: OrgStorageDeleteOperation; replay: boolean }> {
    return await writeTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.logicalKey}`}, 0))`,
      );
      const replay = await tx.query.orgStorageDeleteOperations.findFirst({
        where: and(
          eq(orgStorageDeleteOperations.organization_id, input.organizationId),
          eq(orgStorageDeleteOperations.idempotency_key_hash, input.idempotencyKeyHash),
        ),
      });
      if (replay) {
        if (replay.request_digest !== input.requestDigest) {
          throw new StoragePutConflictError("idempotency_mismatch");
        }
        return { operation: replay, replay: true };
      }
      const objectRows = await sqlRows<OrgStorageObject>(
        tx,
        sql`SELECT * FROM ${orgStorageObjects}
          WHERE ${orgStorageObjects.organization_id} = ${input.organizationId}
            AND ${orgStorageObjects.logical_key} = ${input.logicalKey}
          FOR UPDATE`,
      );
      const object = normalizeObject(requiredRow(objectRows, "delete object lock"));
      if (!object.provider_key || object.size_bytes <= 0n) {
        throw new StoragePutConflictError("object_busy");
      }
      const retainedRead = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT id FROM org_storage_read_operations
          WHERE object_id = ${object.id}
            AND method = 'get'
            AND state IN ('provider_succeeded', 'committed')
            AND retain_until > NOW()
          LIMIT 1`,
      );
      if (retainedRead.length > 0) throw new StoragePutConflictError("object_busy");
      const activePut = await tx.query.orgStoragePutOperations.findFirst({
        where: and(
          eq(orgStoragePutOperations.object_id, object.id),
          inArray(orgStoragePutOperations.state, [
            "prepared",
            "reserved",
            "provider_started",
            "reconciling",
          ]),
        ),
      });
      const activeDelete = await tx.query.orgStorageDeleteOperations.findFirst({
        where: and(
          eq(orgStorageDeleteOperations.object_id, object.id),
          inArray(orgStorageDeleteOperations.state, ["prepared", "provider_started"]),
        ),
      });
      if (activePut || activeDelete) throw new StoragePutConflictError("object_busy");
      const inserted = await tx
        .insert(orgStorageDeleteOperations)
        .values({
          organization_id: input.organizationId,
          object_id: object.id,
          idempotency_key_hash: input.idempotencyKeyHash,
          request_digest: input.requestDigest,
          source_generation: object.generation,
          source_provider_key: object.provider_key,
          source_size_bytes: object.size_bytes,
        })
        .returning();
      return { operation: requiredRow(inserted, "delete operation insert"), replay: false };
    });
  }

  async claimDeleteLease(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    now: Date;
  }): Promise<OrgStorageDeleteOperation> {
    const rows = await writeTransaction(
      async (tx) =>
        await tx
          .update(orgStorageDeleteOperations)
          .set({
            state: "provider_started",
            lease_token: params.leaseToken,
            lease_expires_at: params.leaseExpiresAt,
            updated_at: params.now,
          })
          .where(
            and(
              eq(orgStorageDeleteOperations.id, params.operationId),
              eq(orgStorageDeleteOperations.organization_id, params.organizationId),
              or(
                eq(orgStorageDeleteOperations.state, "prepared"),
                and(
                  eq(orgStorageDeleteOperations.state, "provider_started"),
                  lt(orgStorageDeleteOperations.lease_expires_at, params.now),
                ),
              ),
            ),
          )
          .returning(),
    );
    if (!rows[0]) throw new StoragePutConflictError("stale_lease");
    return rows[0];
  }

  async commitObservedDelete(params: {
    operationId: string;
    organizationId: string;
    leaseToken: string;
    responseJson: string;
  }): Promise<OrgStorageDeleteOperation> {
    return await writeTransaction(async (tx) => {
      const operationRows = await sqlRows<OrgStorageDeleteOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageDeleteOperations}
          WHERE ${orgStorageDeleteOperations.id} = ${params.operationId}
            AND ${orgStorageDeleteOperations.organization_id} = ${params.organizationId}
          FOR UPDATE`,
      );
      const operation = requiredRow(operationRows, "delete operation commit lock");
      if (operation.state === "committed") return operation;
      if (operation.state !== "provider_started" || operation.lease_token !== params.leaseToken) {
        throw new StoragePutConflictError("stale_lease");
      }
      const objectRows = await sqlRows<OrgStorageObject>(
        tx,
        sql`SELECT * FROM ${orgStorageObjects}
          WHERE ${orgStorageObjects.id} = ${operation.object_id}
            AND ${orgStorageObjects.organization_id} = ${params.organizationId}
          FOR UPDATE`,
      );
      const object = normalizeObject(requiredRow(objectRows, "delete object commit lock"));
      if (
        object.generation !== bigintValue(operation.source_generation) ||
        object.provider_key !== operation.source_provider_key
      ) {
        throw new StoragePutConflictError("object_busy");
      }
      const quotaRows = await sqlRows<{ bytes_used: bigint }>(
        tx,
        sql`UPDATE ${orgStorageQuota}
          SET bytes_used = ${orgStorageQuota.bytes_used} - ${bigintValue(operation.source_size_bytes)},
              updated_at = NOW()
          WHERE ${orgStorageQuota.organization_id} = ${params.organizationId}
            AND ${orgStorageQuota.bytes_used} >= ${bigintValue(operation.source_size_bytes)}
          RETURNING ${orgStorageQuota.bytes_used}`,
      );
      requiredRow(quotaRows, "delete quota release");
      await tx
        .update(orgStorageObjects)
        .set({
          provider_key: null,
          size_bytes: 0n,
          content_type: null,
          content_sha256: null,
          etag: null,
          uploaded_at: null,
          deleted_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(orgStorageObjects.id, object.id));
      const committed = await tx
        .update(orgStorageDeleteOperations)
        .set({
          state: "committed",
          response_json: params.responseJson,
          completed_at: new Date(),
          lease_token: null,
          lease_expires_at: null,
          updated_at: new Date(),
        })
        .where(eq(orgStorageDeleteOperations.id, operation.id))
        .returning();
      return requiredRow(committed, "delete operation commit");
    });
  }

  async listDueDeletes(now: Date, limit = MAX_DUE_BATCH): Promise<OrgStorageDeleteOperation[]> {
    const preparedBefore = new Date(now.getTime() - 10 * 60 * 1000);
    return await dbWrite.query.orgStorageDeleteOperations.findMany({
      where: or(
        and(
          eq(orgStorageDeleteOperations.state, "prepared"),
          lt(orgStorageDeleteOperations.created_at, preparedBefore),
        ),
        and(
          eq(orgStorageDeleteOperations.state, "provider_started"),
          lt(orgStorageDeleteOperations.lease_expires_at, now),
        ),
      ),
      orderBy: (table, { asc }) => [asc(table.created_at)],
      limit: Math.max(1, Math.min(limit, MAX_DUE_BATCH)),
    });
  }
}

export const orgStorageMutationsRepository = new OrgStorageMutationsRepository();
