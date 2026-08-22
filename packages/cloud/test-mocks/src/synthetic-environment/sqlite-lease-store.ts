/**
 * Implements synthetic-environment fencing on a file-backed SQLite database.
 * SQLite's cross-process write transaction is the local production boundary;
 * guarded mutations receive that same transaction connection.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type {
  AcquireSyntheticEnvironmentLeaseInput,
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

interface LeaseRow {
  namespace: string;
  generation: number;
  lease_id: string | null;
  owner_id: string | null;
  owner_process_id: number | null;
  owner_host: string | null;
  acquired_at_ms: number | null;
  heartbeat_at_ms: number | null;
  expires_at_ms: number | null;
  released_at_ms: number | null;
  revision: number;
}

const MAX_LEASE_DURATION_MS = 86_400_000;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalidInput(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    code: "SYNTHETIC_LEASE_INVALID_INPUT",
    severity: "fatal",
    cause,
  });
}

function storageFailure(
  message: string,
  namespace: string | null,
  cause: unknown,
): ElizaError {
  return new ElizaError(message, {
    code: "SYNTHETIC_LEASE_STORAGE_FAILURE",
    severity: "fatal",
    context: namespace === null ? undefined : { namespace },
    cause,
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
    throw invalidInput(
      `${field} must be 1-128 safe identifier characters and start alphanumeric`,
    );
  }
  return value;
}

function validateOwner(
  owner: SyntheticEnvironmentLeaseOwner,
): SyntheticEnvironmentLeaseOwner {
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
    throw invalidInput(
      "owner.processId must be a positive 32-bit integer or null",
    );
  }
  if (typeof owner.host !== "string") {
    throw invalidInput("owner.host must be a string");
  }
  const host = owner.host.trim();
  if (
    host.length === 0 ||
    host.length > 255 ||
    containsControlCharacter(host)
  ) {
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
    throw invalidInput(
      "leaseDurationMs must be an integer between 10ms and one day",
    );
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
  const namespace = validateNamespace(
    authority.namespace,
    "authority.namespace",
  );
  validateIdentifier(authority.leaseId, "authority.leaseId");
  validateOwner(authority.owner);
  if (!Number.isSafeInteger(authority.generation) || authority.generation < 1) {
    throw invalidInput("authority.generation must be a positive integer");
  }
  return { ...authority, namespace };
}

function iso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function rowOwner(row: LeaseRow): SyntheticEnvironmentLeaseOwner | null {
  if (row.owner_id === null || row.owner_host === null) return null;
  return {
    ownerId: row.owner_id,
    processId: row.owner_process_id,
    host: row.owner_host,
  };
}

function snapshot(
  row: LeaseRow,
  nowMs: number,
): SyntheticEnvironmentLeaseSnapshot {
  const status =
    row.lease_id === null
      ? "released"
      : row.expires_at_ms !== null && row.expires_at_ms <= nowMs
        ? "expired"
        : "active";
  return {
    version: SYNTHETIC_ENVIRONMENT_LEASE_VERSION,
    namespace: row.namespace,
    generation: row.generation,
    leaseId: row.lease_id,
    owner: rowOwner(row),
    acquiredAt: iso(row.acquired_at_ms),
    heartbeatAt: iso(row.heartbeat_at_ms),
    expiresAt: iso(row.expires_at_ms),
    releasedAt: iso(row.released_at_ms),
    revision: row.revision,
    status,
    observedAt: new Date(nowMs).toISOString(),
  };
}

function authorityFromRow(row: LeaseRow): SyntheticEnvironmentLeaseAuthority {
  const owner = rowOwner(row);
  if (row.lease_id === null || owner === null) {
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
  row: LeaseRow | null,
  authority: SyntheticEnvironmentLeaseAuthority,
  nowMs: number,
): LeaseRow {
  if (
    row === null ||
    row.lease_id !== authority.leaseId ||
    row.generation !== authority.generation ||
    row.owner_id !== authority.owner.ownerId ||
    row.owner_process_id !== authority.owner.processId ||
    row.owner_host !== authority.owner.host ||
    row.expires_at_ms === null ||
    row.expires_at_ms <= nowMs
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

/** File-backed local adapter shared by scenario and provider-mock processes. */
export class SqliteSyntheticEnvironmentLeaseStore
  implements SyntheticEnvironmentLeaseStore<Database>
{
  readonly database: Database;
  private transactionTail: Promise<void> = Promise.resolve();
  private pendingTransactions = 0;
  private closed = false;

  constructor(databasePath: string) {
    if (!path.isAbsolute(databasePath)) {
      throw invalidInput("databasePath must be absolute");
    }
    const parentPath = path.dirname(databasePath);
    mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw invalidInput("databasePath parent must be a real directory");
    }
    if (process.platform !== "win32" && (parent.mode & 0o022) !== 0) {
      throw invalidInput(
        "databasePath parent must not be writable by group or other users",
      );
    }
    let existingIdentity: { dev: number; ino: number } | null = null;
    try {
      const existing = lstatSync(databasePath);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw invalidInput(
          "databasePath must be a regular file, not a symbolic link",
        );
      }
      existingIdentity = { dev: existing.dev, ino: existing.ino };
    } catch (error) {
      // error-policy:J3 Only an absent path may proceed to SQLite creation.
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        if (error instanceof ElizaError) throw error;
        throw invalidInput("databasePath could not be inspected safely", error);
      }
    }
    this.database = new Database(databasePath, { create: true, strict: true });
    chmodSync(databasePath, 0o600);
    const opened = lstatSync(databasePath);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      (existingIdentity !== null &&
        (opened.dev !== existingIdentity.dev ||
          opened.ino !== existingIdentity.ino))
    ) {
      this.database.close(false);
      throw invalidInput("databasePath identity changed while it was opened");
    }
    this.database.run("PRAGMA busy_timeout = 10000");
    // The default rollback journal supports atomic cross-process writers and
    // avoids a connection-start WAL mode transition racing another process.
    this.database.run("PRAGMA synchronous = FULL");
    this.database.run(`
      CREATE TABLE IF NOT EXISTS synthetic_environment_leases (
        namespace TEXT PRIMARY KEY NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        lease_id TEXT,
        owner_id TEXT,
        owner_process_id INTEGER,
        owner_host TEXT,
        acquired_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        expires_at_ms INTEGER,
        released_at_ms INTEGER,
        revision INTEGER NOT NULL CHECK (revision > 0),
        CHECK (
          (lease_id IS NULL AND owner_id IS NULL AND owner_process_id IS NULL
            AND owner_host IS NULL AND expires_at_ms IS NULL)
          OR
          (lease_id IS NOT NULL AND owner_id IS NOT NULL AND owner_host IS NOT NULL
            AND acquired_at_ms IS NOT NULL AND heartbeat_at_ms IS NOT NULL
            AND expires_at_ms IS NOT NULL)
        )
      )
    `);
  }

  close(): void {
    if (this.closed) return;
    if (this.pendingTransactions > 0) {
      throw storageFailure(
        "Cannot close synthetic lease storage while a transaction is pending",
        null,
        new Error("transaction in progress"),
      );
    }
    this.closed = true;
    this.database.close(false);
  }

  async acquire(
    input: AcquireSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("acquire input must be an object");
    }
    const namespace = validateNamespace(input.namespace, "namespace");
    const owner = validateOwner(input.owner);
    const duration = validateDuration(input.leaseDurationMs);
    return this.transaction(namespace, async (nowMs) => {
      const current = this.select(namespace);
      if (
        current !== null &&
        current.lease_id !== null &&
        current.expires_at_ms !== null &&
        current.expires_at_ms > nowMs
      ) {
        throw new ElizaError(
          "Synthetic environment namespace already has an active owner",
          {
            code: "SYNTHETIC_LEASE_COLLISION",
            severity: "fatal",
            context: {
              namespace,
              generation: current.generation,
              ownerId: current.owner_id,
            },
          },
        );
      }
      const generation = (current?.generation ?? 0) + 1;
      const leaseId = randomUUID();
      const operation =
        current?.lease_id === null || current === null ? "acquire" : "recover";
      this.database
        .query(`
          INSERT INTO synthetic_environment_leases (
            namespace, generation, lease_id, owner_id, owner_process_id, owner_host,
            acquired_at_ms, heartbeat_at_ms, expires_at_ms, released_at_ms, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
          ON CONFLICT(namespace) DO UPDATE SET
            generation = excluded.generation,
            lease_id = excluded.lease_id,
            owner_id = excluded.owner_id,
            owner_process_id = excluded.owner_process_id,
            owner_host = excluded.owner_host,
            acquired_at_ms = excluded.acquired_at_ms,
            heartbeat_at_ms = excluded.heartbeat_at_ms,
            expires_at_ms = excluded.expires_at_ms,
            released_at_ms = NULL,
            revision = synthetic_environment_leases.revision + 1
        `)
        .run(
          namespace,
          generation,
          leaseId,
          owner.ownerId,
          owner.processId,
          owner.host,
          nowMs,
          nowMs,
          nowMs + duration,
        );
      return this.receipt(operation, this.requireRow(namespace), nowMs);
    });
  }

  async read(
    namespace: string,
  ): Promise<SyntheticEnvironmentLeaseSnapshot | null> {
    namespace = validateNamespace(namespace, "namespace");
    await this.transactionTail;
    this.assertOpen();
    const nowMs = Date.now();
    const row = this.select(namespace);
    return row ? snapshot(row, nowMs) : null;
  }

  async heartbeat(
    input: RefreshSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    if (typeof input !== "object" || input === null) {
      throw invalidInput("heartbeat input must be an object");
    }
    const authority = validateAuthority(input.authority);
    const duration = validateDuration(input.leaseDurationMs);
    return this.transaction(authority.namespace, async (nowMs) => {
      assertAuthorityMatches(
        this.select(authority.namespace),
        authority,
        nowMs,
      );
      this.database
        .query(`
          UPDATE synthetic_environment_leases
          SET heartbeat_at_ms = ?, expires_at_ms = ?, revision = revision + 1
          WHERE namespace = ?
        `)
        .run(nowMs, nowMs + duration, authority.namespace);
      return this.receipt(
        "heartbeat",
        this.requireRow(authority.namespace),
        nowMs,
      );
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
    return this.transaction(authority.namespace, async (nowMs) => {
      const row = assertAuthorityMatches(
        this.select(authority.namespace),
        authority,
        nowMs,
      );
      const leaseId = randomUUID();
      this.database
        .query(`
          UPDATE synthetic_environment_leases
          SET generation = ?, lease_id = ?, acquired_at_ms = ?, heartbeat_at_ms = ?,
              expires_at_ms = ?, released_at_ms = NULL, revision = revision + 1
          WHERE namespace = ?
        `)
        .run(
          row.generation + 1,
          leaseId,
          nowMs,
          nowMs,
          nowMs + duration,
          authority.namespace,
        );
      return this.receipt(
        "rollover",
        this.requireRow(authority.namespace),
        nowMs,
      );
    });
  }

  async release(
    uncheckedAuthority: SyntheticEnvironmentLeaseAuthority,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    const authority = validateAuthority(uncheckedAuthority);
    return this.transaction(authority.namespace, async (nowMs) => {
      const row = assertAuthorityMatches(
        this.select(authority.namespace),
        authority,
        nowMs,
      );
      this.database
        .query(`
          UPDATE synthetic_environment_leases
          SET lease_id = NULL, owner_id = NULL, owner_process_id = NULL, owner_host = NULL,
              expires_at_ms = NULL, released_at_ms = ?, revision = revision + 1
          WHERE namespace = ?
        `)
        .run(nowMs, authority.namespace);
      const released = this.requireRow(authority.namespace);
      return {
        operation: "release",
        authority: authorityFromRow(row),
        snapshot: snapshot(released, nowMs),
      };
    });
  }

  async withActiveGeneration<T>(
    uncheckedAuthority: SyntheticEnvironmentLeaseAuthority,
    write: (database: Database) => T | Promise<T>,
  ): Promise<{ value: T; receipt: SyntheticEnvironmentLeaseReceipt }> {
    const authority = validateAuthority(uncheckedAuthority);
    return this.transaction(authority.namespace, async (nowMs) => {
      assertAuthorityMatches(
        this.select(authority.namespace),
        authority,
        nowMs,
      );
      const value = await write(this.database);
      const committedAt = Date.now();
      const row = assertAuthorityMatches(
        this.select(authority.namespace),
        authority,
        committedAt,
      );
      return {
        value,
        receipt: this.receipt("guarded-write", row, committedAt),
      };
    });
  }

  private select(namespace: string): LeaseRow | null {
    return (
      this.database
        .query<LeaseRow, [string]>(
          "SELECT * FROM synthetic_environment_leases WHERE namespace = ?",
        )
        .get(namespace) ?? null
    );
  }

  private requireRow(namespace: string): LeaseRow {
    const row = this.select(namespace);
    if (!row) {
      throw new ElizaError("Synthetic lease row disappeared", {
        code: "SYNTHETIC_LEASE_NOT_FOUND",
        severity: "fatal",
        context: { namespace },
      });
    }
    return row;
  }

  private receipt(
    operation: SyntheticEnvironmentLeaseReceipt["operation"],
    row: LeaseRow,
    nowMs: number,
  ): SyntheticEnvironmentLeaseReceipt {
    return {
      operation,
      authority: authorityFromRow(row),
      snapshot: snapshot(row, nowMs),
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw storageFailure(
        "Synthetic lease storage is closed",
        null,
        new Error("database closed"),
      );
    }
  }

  private async transaction<T>(
    namespace: string,
    operation: (nowMs: number) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    this.pendingTransactions += 1;
    const previous = this.transactionTail;
    let release: () => void = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      try {
        this.database.run("BEGIN IMMEDIATE");
      } catch (error) {
        // error-policy:J2 SQLite lock/open failures become the declared storage boundary error.
        throw storageFailure(
          "Synthetic lease transaction could not begin",
          namespace,
          error,
        );
      }
      try {
        const result = await operation(Date.now());
        try {
          this.database.run("COMMIT");
        } catch (error) {
          // error-policy:J2 A failed commit is ambiguous and must retain its storage cause.
          throw storageFailure(
            "Synthetic lease transaction commit was not confirmed",
            namespace,
            error,
          );
        }
        return result;
      } catch (error) {
        // error-policy:J2 rollback restores the atomic generation boundary;
        // the original typed failure is preserved for the caller.
        try {
          this.database.run("ROLLBACK");
        } catch (rollbackError) {
          // error-policy:J2 A rollback failure supersedes neither cause and makes storage unusable.
          throw storageFailure(
            "Synthetic lease transaction rollback was not confirmed",
            namespace,
            new AggregateError([error, rollbackError]),
          );
        }
        throw error;
      }
    } finally {
      this.pendingTransactions -= 1;
      release();
    }
  }
}
