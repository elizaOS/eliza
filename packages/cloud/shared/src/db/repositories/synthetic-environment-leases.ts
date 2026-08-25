/**
 * Owns Cloud synthetic namespace leases on the primary database clock. Row
 * locks serialize reset generations with production repository mutations.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type {
  AcquireSyntheticEnvironmentLeaseInput,
  GuardedSyntheticEnvironmentWriteResult,
  RefreshSyntheticEnvironmentLeaseInput,
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseOwner,
  SyntheticEnvironmentLeaseReceipt,
  SyntheticEnvironmentLeaseSnapshot,
  SyntheticEnvironmentLeaseStore,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import {
  isSyntheticEnvironmentNamespace,
  SYNTHETIC_ENVIRONMENT_LEASE_VERSION,
  SYNTHETIC_ENVIRONMENT_NAMESPACE_MAX_LENGTH,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type SyntheticEnvironmentLease,
  syntheticEnvironmentLeases,
} from "../schemas/synthetic-environment-leases";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const MAX_LEASE_DURATION_MS = 86_400_000;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalidInput(message: string): ElizaError {
  return new ElizaError(message, {
    code: "SYNTHETIC_LEASE_INVALID_INPUT",
    severity: "fatal",
  });
}

function storageFailure(message: string, namespace: string): ElizaError {
  return new ElizaError(message, {
    code: "SYNTHETIC_LEASE_STORAGE_FAILURE",
    severity: "fatal",
    context: { namespace },
  });
}

function validateNamespace(value: unknown, field: string): string {
  if (!isSyntheticEnvironmentNamespace(value)) {
    throw invalidInput(
      `${field} must contain 1-${SYNTHETIC_ENVIRONMENT_NAMESPACE_MAX_LENGTH} non-control characters`,
    );
  }
  return value;
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw invalidInput(`${field} must be 1-128 safe identifier characters and start alphanumeric`);
  }
  return value;
}

function validateOwner(owner: SyntheticEnvironmentLeaseOwner): SyntheticEnvironmentLeaseOwner {
  if (typeof owner !== "object" || owner === null) {
    throw invalidInput("owner must be an object");
  }
  validateIdentifier(owner.ownerId, "owner.ownerId");
  if (
    owner.processId !== null &&
    (!Number.isSafeInteger(owner.processId) ||
      owner.processId < 1 ||
      owner.processId > 2_147_483_647)
  ) {
    throw invalidInput("owner.processId must be a positive 32-bit integer or null");
  }
  if (typeof owner.host !== "string") throw invalidInput("owner.host must be a string");
  const host = owner.host.trim();
  if (host.length === 0 || host.length > 255 || containsControlCharacter(host)) {
    throw invalidInput("owner.host must contain 1-255 safe characters");
  }
  return { ...owner, host };
}

function validateDuration(leaseDurationMs: number): number {
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 10 ||
    leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    throw invalidInput("leaseDurationMs must be an integer between 10ms and one day");
  }
  return leaseDurationMs;
}

function validateAuthority(
  authority: SyntheticEnvironmentLeaseAuthority,
): SyntheticEnvironmentLeaseAuthority {
  if (typeof authority !== "object" || authority === null) {
    throw invalidInput("authority must be an object");
  }
  if (authority.version !== SYNTHETIC_ENVIRONMENT_LEASE_VERSION) {
    throw invalidInput("authority.version is unsupported");
  }
  const namespace = validateNamespace(authority.namespace, "authority.namespace");
  validateIdentifier(authority.leaseId, "authority.leaseId");
  validateOwner(authority.owner);
  if (!Number.isSafeInteger(authority.generation) || authority.generation < 1) {
    throw invalidInput("authority.generation must be a positive integer");
  }
  return { ...authority, namespace };
}

function rowOwner(row: SyntheticEnvironmentLease): SyntheticEnvironmentLeaseOwner | null {
  if (row.owner_id === null || row.owner_host === null) return null;
  return {
    ownerId: row.owner_id,
    processId: row.owner_process_id,
    host: row.owner_host,
  };
}

function snapshot(
  row: SyntheticEnvironmentLease,
  databaseNow: Date,
): SyntheticEnvironmentLeaseSnapshot {
  const status =
    row.lease_id === null
      ? "released"
      : row.expires_at !== null && row.expires_at.getTime() <= databaseNow.getTime()
        ? "expired"
        : "active";
  return {
    version: SYNTHETIC_ENVIRONMENT_LEASE_VERSION,
    namespace: row.namespace,
    generation: row.generation,
    leaseId: row.lease_id,
    owner: rowOwner(row),
    acquiredAt: row.acquired_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    releasedAt: row.released_at?.toISOString() ?? null,
    revision: row.revision,
    status,
    observedAt: databaseNow.toISOString(),
  };
}

function authorityFromRow(row: SyntheticEnvironmentLease): SyntheticEnvironmentLeaseAuthority {
  const owner = rowOwner(row);
  if (!row.lease_id || !owner) {
    throw new ElizaError("Synthetic lease has no active authority", {
      code: "SYNTHETIC_LEASE_LOST",
      severity: "fatal",
      context: { namespace: row.namespace, generation: row.generation },
    });
  }
  return {
    version: SYNTHETIC_ENVIRONMENT_LEASE_VERSION,
    namespace: row.namespace,
    generation: row.generation,
    leaseId: row.lease_id,
    owner,
  };
}

function assertAuthorityMatches(
  row: SyntheticEnvironmentLease | undefined,
  authority: SyntheticEnvironmentLeaseAuthority,
  databaseNow: Date,
): SyntheticEnvironmentLease {
  if (
    !row ||
    row.lease_id !== authority.leaseId ||
    row.generation !== authority.generation ||
    row.owner_id !== authority.owner.ownerId ||
    row.owner_process_id !== authority.owner.processId ||
    row.owner_host !== authority.owner.host ||
    !row.expires_at ||
    row.expires_at.getTime() <= databaseNow.getTime()
  ) {
    throw new ElizaError(
      "Synthetic environment lease authority is stale, expired, or owned elsewhere",
      {
        code: "SYNTHETIC_LEASE_LOST",
        severity: "fatal",
        context: {
          namespace: authority.namespace,
          generation: authority.generation,
          ownerId: authority.owner.ownerId,
        },
      },
    );
  }
  return row;
}

async function lockRow(
  tx: DbTransaction,
  namespace: string,
): Promise<SyntheticEnvironmentLease | undefined> {
  const [row] = await tx
    .select()
    .from(syntheticEnvironmentLeases)
    .where(eq(syntheticEnvironmentLeases.namespace, namespace))
    .for("update")
    .limit(1);
  return row;
}

function receipt(
  operation: SyntheticEnvironmentLeaseReceipt["operation"],
  row: SyntheticEnvironmentLease,
  databaseNow: Date,
): SyntheticEnvironmentLeaseReceipt {
  return { operation, authority: authorityFromRow(row), snapshot: snapshot(row, databaseNow) };
}

/** PostgreSQL/PGlite adapter used by Cloud workers and the local Cloud stack. */
export class CloudSyntheticEnvironmentLeaseStore
  implements SyntheticEnvironmentLeaseStore<DbTransaction>
{
  async acquire(
    input: AcquireSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("acquire input must be an object");
    }
    const namespace = validateNamespace(input.namespace, "namespace");
    const owner = validateOwner(input.owner);
    const duration = validateDuration(input.leaseDurationMs);
    return dbWrite.transaction(async (tx) => {
      await tx
        .insert(syntheticEnvironmentLeases)
        .values({ namespace, generation: 0, revision: 0 })
        .onConflictDoNothing({ target: syntheticEnvironmentLeases.namespace });
      const current = await lockRow(tx, namespace);
      if (!current) {
        throw new ElizaError("Synthetic lease row disappeared", {
          code: "SYNTHETIC_LEASE_NOT_FOUND",
          severity: "fatal",
          context: { namespace },
        });
      }
      const databaseNow = await readPostLockDatabaseNow(tx);
      if (current.lease_id && current.expires_at && current.expires_at > databaseNow) {
        throw new ElizaError("Synthetic environment namespace already has an active owner", {
          code: "SYNTHETIC_LEASE_COLLISION",
          severity: "fatal",
          context: {
            namespace,
            generation: current.generation,
            ownerId: current.owner_id,
          },
        });
      }
      const operation = current.lease_id ? "recover" : "acquire";
      const [updated] = await tx
        .update(syntheticEnvironmentLeases)
        .set({
          generation: current.generation + 1,
          lease_id: randomUUID(),
          owner_id: owner.ownerId,
          owner_process_id: owner.processId,
          owner_host: owner.host,
          acquired_at: databaseNow,
          heartbeat_at: databaseNow,
          expires_at: new Date(databaseNow.getTime() + duration),
          released_at: null,
          revision: current.revision + 1,
          updated_at: databaseNow,
        })
        .where(eq(syntheticEnvironmentLeases.namespace, namespace))
        .returning();
      if (!updated) {
        throw new ElizaError("Synthetic lease update was not committed", {
          code: "SYNTHETIC_LEASE_NOT_FOUND",
          severity: "fatal",
          context: { namespace },
        });
      }
      return receipt(operation, updated, databaseNow);
    });
  }

  async read(namespace: string): Promise<SyntheticEnvironmentLeaseSnapshot | null> {
    namespace = validateNamespace(namespace, "namespace");
    return dbWrite.transaction(async (tx) => {
      const row = await lockRow(tx, namespace);
      if (!row) return null;
      const databaseNow = await readPostLockDatabaseNow(tx);
      return snapshot(row, databaseNow);
    });
  }

  async heartbeat(
    input: RefreshSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("heartbeat input must be an object");
    }
    const authority = validateAuthority(input.authority);
    const duration = validateDuration(input.leaseDurationMs);
    return dbWrite.transaction(async (tx) => {
      const row = await lockRow(tx, authority.namespace);
      const databaseNow = await readPostLockDatabaseNow(tx);
      const active = assertAuthorityMatches(row, authority, databaseNow);
      const [updated] = await tx
        .update(syntheticEnvironmentLeases)
        .set({
          heartbeat_at: databaseNow,
          expires_at: new Date(databaseNow.getTime() + duration),
          revision: active.revision + 1,
          updated_at: databaseNow,
        })
        .where(eq(syntheticEnvironmentLeases.namespace, authority.namespace))
        .returning();
      if (!updated) {
        throw storageFailure(
          "Synthetic lease heartbeat update was not committed",
          authority.namespace,
        );
      }
      return receipt("heartbeat", updated, databaseNow);
    });
  }

  async rollover(
    input: RefreshSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("rollover input must be an object");
    }
    const authority = validateAuthority(input.authority);
    const duration = validateDuration(input.leaseDurationMs);
    return dbWrite.transaction(async (tx) => {
      const row = await lockRow(tx, authority.namespace);
      const databaseNow = await readPostLockDatabaseNow(tx);
      const active = assertAuthorityMatches(row, authority, databaseNow);
      const [updated] = await tx
        .update(syntheticEnvironmentLeases)
        .set({
          generation: active.generation + 1,
          lease_id: randomUUID(),
          acquired_at: databaseNow,
          heartbeat_at: databaseNow,
          expires_at: new Date(databaseNow.getTime() + duration),
          released_at: null,
          revision: active.revision + 1,
          updated_at: databaseNow,
        })
        .where(eq(syntheticEnvironmentLeases.namespace, authority.namespace))
        .returning();
      if (!updated) {
        throw storageFailure(
          "Synthetic lease rollover update was not committed",
          authority.namespace,
        );
      }
      return receipt("rollover", updated, databaseNow);
    });
  }

  async release(
    uncheckedAuthority: SyntheticEnvironmentLeaseAuthority,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    const authority = validateAuthority(uncheckedAuthority);
    return dbWrite.transaction(async (tx) => {
      const row = await lockRow(tx, authority.namespace);
      const databaseNow = await readPostLockDatabaseNow(tx);
      const active = assertAuthorityMatches(row, authority, databaseNow);
      const [released] = await tx
        .update(syntheticEnvironmentLeases)
        .set({
          lease_id: null,
          owner_id: null,
          owner_process_id: null,
          owner_host: null,
          expires_at: null,
          released_at: databaseNow,
          revision: active.revision + 1,
          updated_at: databaseNow,
        })
        .where(eq(syntheticEnvironmentLeases.namespace, authority.namespace))
        .returning();
      if (!released) {
        throw storageFailure(
          "Synthetic lease release update was not committed",
          authority.namespace,
        );
      }
      return {
        operation: "release",
        authority: authorityFromRow(active),
        snapshot: snapshot(released, databaseNow),
      };
    });
  }

  async withActiveGeneration<T>(
    uncheckedAuthority: SyntheticEnvironmentLeaseAuthority,
    write: (transaction: DbTransaction) => T | Promise<T>,
  ): Promise<GuardedSyntheticEnvironmentWriteResult<T>> {
    const authority = validateAuthority(uncheckedAuthority);
    return dbWrite.transaction(async (tx) => {
      const initial = await lockRow(tx, authority.namespace);
      const initialNow = await readPostLockDatabaseNow(tx);
      assertAuthorityMatches(initial, authority, initialNow);
      const value = await write(tx);
      const committedNow = await readPostLockDatabaseNow(tx);
      const active = assertAuthorityMatches(
        await lockRow(tx, authority.namespace),
        authority,
        committedNow,
      );
      return { value, receipt: receipt("guarded-write", active, committedNow) };
    });
  }
}

export const cloudSyntheticEnvironmentLeaseStore = new CloudSyntheticEnvironmentLeaseStore();
