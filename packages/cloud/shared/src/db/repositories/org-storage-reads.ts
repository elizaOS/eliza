/**
 * Owns durable storage-read receipts and atomically attaches one exact debit
 * only after the native provider result has been recorded.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { writeTransaction } from "../helpers";
import {
  type OrgStorageReadMethod,
  type OrgStorageReadOperation,
  orgStorageReadOperations,
} from "../schemas/org-storage-reads";
import { organizations } from "../schemas/organizations";

export class StorageReadConflictError extends Error {
  constructor(
    public readonly reason: "idempotency_mismatch" | "state_conflict" | "provider_result_mismatch",
  ) {
    super(`Native storage read conflict: ${reason}`);
    this.name = "StorageReadConflictError";
  }
}

export interface PrepareStorageReadInput {
  organizationId: string;
  userId: string;
  objectId?: string;
  idempotencyKeyHash: string;
  requestDigest: string;
  method: OrgStorageReadMethod;
  priceUsd: string;
  capabilityId?: string;
  capabilityHost?: string;
  capabilityIssuedAt?: Date;
  capabilityExpiresAt?: Date;
  retainUntil?: Date;
}

export interface PrepareStoragePresignRenewalInput {
  organizationId: string;
  userId: string;
  rootOperationId: string;
  expectedGeneration: number;
  idempotencyKeyHash: string;
  requestDigest: string;
  priceUsd: string;
  capabilityId: string;
  capabilityHost: string;
  capabilityIssuedAt: Date;
  capabilityExpiresAt: Date;
  now: Date;
}

export interface ProviderStorageReadResult {
  operationId: string;
  organizationId: string;
  objectId?: string;
  objectGeneration?: bigint;
  providerKey?: string;
  resultSizeBytes?: bigint;
  resultContentType?: string;
  resultEtag?: string;
  responseStatus: number;
  responseJson: string;
  providerSucceededAt: Date;
}

export interface CommittedStorageRead {
  operation: OrgStorageReadOperation;
  insufficient: boolean;
  availableUsd?: string;
}

function requiredRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`[NativeStorageRead] ${label} returned no row`);
  return row;
}

function bigintValue(value: bigint | string | number | null): bigint | null {
  return value === null ? null : typeof value === "bigint" ? value : BigInt(value);
}

function dateValue(value: Date | string | null): Date | null {
  return value === null || value instanceof Date ? value : new Date(value);
}

function normalize(row: OrgStorageReadOperation): OrgStorageReadOperation {
  return {
    ...row,
    object_generation: bigintValue(row.object_generation),
    result_size_bytes: bigintValue(row.result_size_bytes),
    access_count: bigintValue(row.access_count) ?? 0n,
    capability_issued_at: dateValue(row.capability_issued_at),
    capability_expires_at: dateValue(row.capability_expires_at),
    capability_revoked_at: dateValue(row.capability_revoked_at),
    retain_until: dateValue(row.retain_until),
    provider_succeeded_at: dateValue(row.provider_succeeded_at),
    completed_at: dateValue(row.completed_at),
    last_access_at: dateValue(row.last_access_at),
    created_at: dateValue(row.created_at)!,
    updated_at: dateValue(row.updated_at)!,
  };
}

function providerResultMatches(
  operation: OrgStorageReadOperation,
  result: ProviderStorageReadResult,
): boolean {
  return (
    operation.object_id === (result.objectId ?? null) &&
    operation.object_generation === (result.objectGeneration ?? null) &&
    operation.provider_key === (result.providerKey ?? null) &&
    operation.result_size_bytes === (result.resultSizeBytes ?? null) &&
    operation.result_content_type === (result.resultContentType ?? null) &&
    operation.result_etag === (result.resultEtag ?? null) &&
    operation.response_status === result.responseStatus &&
    operation.response_json === result.responseJson
  );
}

export class OrgStorageReadsRepository {
  async findByIdempotency(
    organizationId: string,
    idempotencyKeyHash: string,
  ): Promise<OrgStorageReadOperation | undefined> {
    const row = await writeTransaction((tx) =>
      tx.query.orgStorageReadOperations.findFirst({
        where: and(
          eq(orgStorageReadOperations.organization_id, organizationId),
          eq(orgStorageReadOperations.idempotency_key_hash, idempotencyKeyHash),
        ),
      }),
    );
    return row ? normalize(row) : undefined;
  }

  async prepare(input: PrepareStorageReadInput): Promise<{
    operation: OrgStorageReadOperation;
    replay: boolean;
  }> {
    return await writeTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${input.organizationId}:${input.idempotencyKeyHash}`}, 0
        ))`,
      );
      const existing = await tx.query.orgStorageReadOperations.findFirst({
        where: and(
          eq(orgStorageReadOperations.organization_id, input.organizationId),
          eq(orgStorageReadOperations.idempotency_key_hash, input.idempotencyKeyHash),
        ),
      });
      if (existing) {
        if (
          existing.request_digest !== input.requestDigest ||
          existing.user_id !== input.userId ||
          existing.method !== input.method
        ) {
          throw new StorageReadConflictError("idempotency_mismatch");
        }
        return { operation: normalize(existing), replay: true };
      }
      const inserted = await tx
        .insert(orgStorageReadOperations)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          object_id: input.objectId,
          idempotency_key_hash: input.idempotencyKeyHash,
          request_digest: input.requestDigest,
          method: input.method,
          price_usd: input.priceUsd,
          capability_id: input.capabilityId,
          capability_host: input.capabilityHost,
          capability_issued_at: input.capabilityIssuedAt,
          capability_expires_at: input.capabilityExpiresAt,
          retain_until: input.retainUntil,
        })
        .returning();
      return { operation: normalize(requiredRow(inserted, "receipt insert")), replay: false };
    });
  }

  async findLatestPresignRenewal(params: {
    organizationId: string;
    rootOperationId: string;
  }): Promise<OrgStorageReadOperation | undefined> {
    return await writeTransaction(async (tx) => {
      const rows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE organization_id = ${params.organizationId}
            AND (id = ${params.rootOperationId}
              OR renewal_root_id = ${params.rootOperationId})
          ORDER BY renewal_generation DESC
          LIMIT 1`,
      );
      return rows[0] ? normalize(rows[0]) : undefined;
    });
  }

  async preparePresignRenewal(
    input: PrepareStoragePresignRenewalInput,
  ): Promise<{ operation: OrgStorageReadOperation; created: boolean }> {
    return await writeTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`storage-presign-renewal:${input.rootOperationId}`}, 0
        ))`,
      );
      const rootRows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE id = ${input.rootOperationId}
            AND organization_id = ${input.organizationId}
          FOR UPDATE`,
      );
      const root = normalize(requiredRow(rootRows, "renewal root lock"));
      if (
        root.user_id !== input.userId ||
        root.method !== "presign" ||
        root.renewal_root_id !== null ||
        root.renewal_generation !== 0
      ) {
        throw new StorageReadConflictError("idempotency_mismatch");
      }
      const latestRows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE organization_id = ${input.organizationId}
            AND (id = ${input.rootOperationId}
              OR renewal_root_id = ${input.rootOperationId})
          ORDER BY renewal_generation DESC
          LIMIT 1
          FOR UPDATE`,
      );
      const latest = normalize(requiredRow(latestRows, "latest renewal lock"));
      if (latest.renewal_generation >= input.expectedGeneration) {
        return { operation: latest, created: false };
      }
      if (
        latest.renewal_generation !== input.expectedGeneration - 1 ||
        !latest.object_id ||
        latest.capability_revoked_at !== null ||
        !(
          (latest.state === "committed" &&
            latest.capability_expires_at !== null &&
            latest.capability_expires_at <= input.now) ||
          (latest.state === "failed" && latest.response_status === 409)
        )
      ) {
        throw new StorageReadConflictError("state_conflict");
      }
      const objectRows = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT object_row.id FROM org_storage_objects object_row
          WHERE object_row.id = ${latest.object_id}
            AND object_row.organization_id = ${input.organizationId}
            AND object_row.deleted_at IS NULL
            AND object_row.provider_key IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM org_storage_delete_operations active_delete
              WHERE active_delete.object_id = object_row.id
                AND active_delete.state IN ('prepared', 'provider_started')
            )
          FOR UPDATE OF object_row`,
      );
      if (objectRows.length === 0) {
        throw new StorageReadConflictError("provider_result_mismatch");
      }
      const inserted = await tx
        .insert(orgStorageReadOperations)
        .values({
          organization_id: input.organizationId,
          user_id: input.userId,
          object_id: latest.object_id,
          idempotency_key_hash: input.idempotencyKeyHash,
          request_digest: input.requestDigest,
          renewal_root_id: root.id,
          renewal_generation: input.expectedGeneration,
          method: "presign",
          price_usd: input.priceUsd,
          capability_id: input.capabilityId,
          capability_host: input.capabilityHost,
          capability_issued_at: input.capabilityIssuedAt,
          capability_expires_at: input.capabilityExpiresAt,
          retain_until: input.capabilityExpiresAt,
        })
        .returning();
      return {
        operation: normalize(requiredRow(inserted, "renewal receipt insert")),
        created: true,
      };
    });
  }

  async recordProviderSuccess(result: ProviderStorageReadResult): Promise<OrgStorageReadOperation> {
    return await writeTransaction(async (tx) => {
      const rows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE id = ${result.operationId}
            AND organization_id = ${result.organizationId}
          FOR UPDATE`,
      );
      const operation = normalize(requiredRow(rows, "provider-success lock"));
      if (operation.state !== "prepared") {
        if (
          ["provider_succeeded", "committed"].includes(operation.state) &&
          providerResultMatches(operation, result)
        ) {
          return operation;
        }
        throw new StorageReadConflictError("provider_result_mismatch");
      }
      if (result.objectId) {
        const objectRows = await sqlRows<{ id: string }>(
          tx,
          sql`SELECT object_row.id FROM org_storage_objects AS object_row
            WHERE object_row.id = ${result.objectId}
              AND object_row.organization_id = ${result.organizationId}
              AND object_row.generation = ${result.objectGeneration ?? null}
              AND object_row.provider_key = ${result.providerKey ?? null}
              AND object_row.size_bytes = ${result.resultSizeBytes ?? null}
              AND object_row.etag = ${result.resultEtag ?? null}
              AND object_row.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM org_storage_delete_operations AS active_delete
                WHERE active_delete.object_id = object_row.id
                  AND active_delete.state IN ('prepared', 'provider_started')
              )
            FOR UPDATE OF object_row`,
        );
        if (objectRows.length === 0) {
          throw new StorageReadConflictError("provider_result_mismatch");
        }
      }
      const updated = await tx
        .update(orgStorageReadOperations)
        .set({
          state: "provider_succeeded",
          object_id: result.objectId,
          object_generation: result.objectGeneration,
          provider_key: result.providerKey,
          result_size_bytes: result.resultSizeBytes,
          result_content_type: result.resultContentType,
          result_etag: result.resultEtag,
          response_status: result.responseStatus,
          response_json: result.responseJson,
          provider_succeeded_at: result.providerSucceededAt,
          updated_at: result.providerSucceededAt,
        })
        .where(eq(orgStorageReadOperations.id, operation.id))
        .returning();
      return normalize(requiredRow(updated, "provider-success update"));
    });
  }

  async recordFailure(params: {
    operationId: string;
    organizationId: string;
    responseStatus: number;
    responseJson: string;
    now: Date;
  }): Promise<OrgStorageReadOperation> {
    return await writeTransaction(async (tx) => {
      const rows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE id = ${params.operationId}
            AND organization_id = ${params.organizationId}
          FOR UPDATE`,
      );
      const operation = normalize(requiredRow(rows, "failure lock"));
      if (operation.state === "failed") return operation;
      if (operation.state !== "prepared") {
        throw new StorageReadConflictError("state_conflict");
      }
      const updated = await tx
        .update(orgStorageReadOperations)
        .set({
          state: "failed",
          response_status: params.responseStatus,
          response_json: params.responseJson,
          completed_at: params.now,
          updated_at: params.now,
        })
        .where(eq(orgStorageReadOperations.id, operation.id))
        .returning();
      return normalize(requiredRow(updated, "failure update"));
    });
  }

  async expirePresignProviderSuccess(params: {
    operationId: string;
    organizationId: string;
    now: Date;
  }): Promise<OrgStorageReadOperation> {
    return await writeTransaction(async (tx) => {
      const updated = await tx
        .update(orgStorageReadOperations)
        .set({
          state: "failed",
          response_status: 409,
          response_json: JSON.stringify({ error: "Capability expired before settlement" }),
          completed_at: params.now,
          updated_at: params.now,
        })
        .where(
          and(
            eq(orgStorageReadOperations.id, params.operationId),
            eq(orgStorageReadOperations.organization_id, params.organizationId),
            eq(orgStorageReadOperations.method, "presign"),
            eq(orgStorageReadOperations.state, "provider_succeeded"),
          ),
        )
        .returning();
      if (updated[0]) return normalize(updated[0]);
      const rows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE id = ${params.operationId}
            AND organization_id = ${params.organizationId}`,
      );
      return normalize(requiredRow(rows, "expired capability receipt"));
    });
  }

  async commitProviderSuccess(params: {
    operationId: string;
    organizationId: string;
    now: Date;
  }): Promise<CommittedStorageRead> {
    return await writeTransaction(async (tx) => {
      const rows = await sqlRows<OrgStorageReadOperation>(
        tx,
        sql`SELECT * FROM ${orgStorageReadOperations}
          WHERE id = ${params.operationId}
            AND organization_id = ${params.organizationId}
          FOR UPDATE`,
      );
      const operation = normalize(requiredRow(rows, "settlement lock"));
      // `now()` is fixed at transaction start in PostgreSQL. Sample the wall
      // clock only after the receipt lock so lock waits cannot settle an
      // already-expired capability.
      const clockRows = await sqlRows<{ current_time: Date | string }>(
        tx,
        sql`SELECT clock_timestamp() AS current_time`,
      );
      const settlementNow = dateValue(requiredRow(clockRows, "settlement clock").current_time);
      if (!settlementNow) throw new Error("[NativeStorageRead] settlement clock was null");
      if (operation.state === "committed") {
        return { operation, insufficient: false };
      }
      if (operation.state === "failed") {
        return { operation, insufficient: operation.response_status === 402 };
      }
      if (operation.state !== "provider_succeeded") {
        throw new StorageReadConflictError("state_conflict");
      }

      const capabilityUnavailable =
        operation.method === "presign" &&
        (operation.capability_revoked_at !== null ||
          !operation.capability_expires_at ||
          operation.capability_expires_at <= settlementNow);
      if (capabilityUnavailable) {
        const error = operation.capability_revoked_at
          ? "Capability revoked before settlement"
          : "Capability expired before settlement";
        const failed = await tx
          .update(orgStorageReadOperations)
          .set({
            state: "failed",
            response_status: 409,
            response_json: JSON.stringify({ error }),
            completed_at: settlementNow,
            updated_at: settlementNow,
          })
          .where(eq(orgStorageReadOperations.id, operation.id))
          .returning();
        return {
          operation: normalize(requiredRow(failed, "revoked capability receipt")),
          insufficient: false,
        };
      }

      let creditTransactionId: string | null = null;
      if (String(operation.price_usd) !== "0.000000") {
        const balanceRows = await sqlRows<{ credit_balance: string }>(
          tx,
          sql`UPDATE ${organizations}
            SET credit_balance = credit_balance - CAST(${String(operation.price_usd)} AS numeric),
                updated_at = NOW()
            WHERE id = ${params.organizationId}
              AND credit_balance >= CAST(${String(operation.price_usd)} AS numeric)
            RETURNING credit_balance`,
        );
        if (balanceRows.length === 0) {
          const availableRows = await sqlRows<{ credit_balance: string }>(
            tx,
            sql`SELECT credit_balance FROM ${organizations}
              WHERE id = ${params.organizationId} FOR UPDATE`,
          );
          const failed = await tx
            .update(orgStorageReadOperations)
            .set({
              state: "failed",
              response_status: 402,
              response_json: JSON.stringify({ error: "Insufficient credits" }),
              completed_at: settlementNow,
              updated_at: settlementNow,
            })
            .where(eq(orgStorageReadOperations.id, operation.id))
            .returning();
          return {
            operation: normalize(requiredRow(failed, "insufficient receipt")),
            insufficient: true,
            availableUsd: requiredRow(availableRows, "organization balance").credit_balance,
          };
        }

        const metadata = JSON.stringify({
          type: "proxy_storage",
          settlement_marker: "storage_read_receipt_v2",
          storage_read_operation_id: operation.id,
          method: operation.method,
          request_digest: operation.request_digest,
          price_usd: String(operation.price_usd),
        });
        const creditRows = await sqlRows<{ id: string }>(
          tx,
          sql`INSERT INTO credit_transactions (
              organization_id, user_id, amount, type, description, metadata,
              created_at, settled_at
            ) VALUES (
              ${params.organizationId}, ${operation.user_id},
              -CAST(${String(operation.price_usd)} AS numeric), 'debit',
              ${`API proxy: storage — native ${operation.method}`},
              ${metadata}::jsonb, ${settlementNow}, ${settlementNow}
            ) RETURNING id`,
        );
        creditTransactionId = requiredRow(creditRows, "credit insert").id;
      }

      const committed = await tx
        .update(orgStorageReadOperations)
        .set({
          state: "committed",
          credit_transaction_id: creditTransactionId,
          completed_at: settlementNow,
          updated_at: settlementNow,
        })
        .where(eq(orgStorageReadOperations.id, operation.id))
        .returning();
      return {
        operation: normalize(requiredRow(committed, "receipt commit")),
        insufficient: false,
      };
    });
  }

  async authorizeCapability(params: {
    capabilityId: string;
    capabilityHost: string;
    now: Date;
  }): Promise<OrgStorageReadOperation | undefined> {
    return await writeTransaction(async (tx) => {
      const rows = await tx
        .update(orgStorageReadOperations)
        .set({
          access_count: sql`${orgStorageReadOperations.access_count} + 1`,
          last_access_at: params.now,
          updated_at: params.now,
        })
        .where(
          and(
            eq(orgStorageReadOperations.capability_id, params.capabilityId),
            eq(orgStorageReadOperations.capability_host, params.capabilityHost),
            eq(orgStorageReadOperations.method, "presign"),
            eq(orgStorageReadOperations.state, "committed"),
            isNull(orgStorageReadOperations.capability_revoked_at),
            gt(orgStorageReadOperations.capability_expires_at, params.now),
          ),
        )
        .returning();
      const row = rows[0];
      return row ? normalize(row) : undefined;
    });
  }

  async revokeCapabilitiesForObject(params: {
    organizationId: string;
    objectId: string;
    now: Date;
  }): Promise<number> {
    const rows = await writeTransaction((tx) =>
      tx
        .update(orgStorageReadOperations)
        .set({ capability_revoked_at: params.now, updated_at: params.now })
        .where(
          and(
            eq(orgStorageReadOperations.organization_id, params.organizationId),
            eq(orgStorageReadOperations.object_id, params.objectId),
            eq(orgStorageReadOperations.method, "presign"),
            isNull(orgStorageReadOperations.capability_revoked_at),
          ),
        )
        .returning({ id: orgStorageReadOperations.id }),
    );
    return rows.length;
  }
}

export const orgStorageReadsRepository = new OrgStorageReadsRepository();
