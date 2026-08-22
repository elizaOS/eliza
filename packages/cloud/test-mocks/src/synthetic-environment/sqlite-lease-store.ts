/**
 * Implements synthetic-environment fencing on a file-backed SQLite database.
 * SQLite's cross-process write transaction is the local production boundary;
 * guarded mutations receive that same transaction connection.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
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
import { SYNTHETIC_ENVIRONMENT_LEASE_VERSION } from "@elizaos/shared/contracts/synthetic-environment-lease";

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

function invalidInput(message: string): ElizaError {
  return new ElizaError(message, {
    code: "SYNTHETIC_LEASE_INVALID_INPUT",
    severity: "fatal",
  });
}

function validateIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw invalidInput(
      `${field} must be 1-128 safe identifier characters and start alphanumeric`,
    );
  }
  return value;
}

function validateOwner(
  owner: SyntheticEnvironmentLeaseOwner,
): SyntheticEnvironmentLeaseOwner {
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
  const host = owner.host.trim();
  if (host.length === 0 || host.length > 255 || /[\r\n\0]/.test(host)) {
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
  if (authority.version !== SYNTHETIC_ENVIRONMENT_LEASE_VERSION) {
    throw invalidInput("authority.version is unsupported");
  }
  validateIdentifier(authority.namespace, "authority.namespace");
  validateIdentifier(authority.leaseId, "authority.leaseId");
  validateOwner(authority.owner);
  if (!Number.isSafeInteger(authority.generation) || authority.generation < 1) {
    throw invalidInput("authority.generation must be a positive integer");
  }
  return authority;
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

  constructor(databasePath: string) {
    if (!path.isAbsolute(databasePath)) {
      throw invalidInput("databasePath must be absolute");
    }
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath, { create: true, strict: true });
    chmodSync(databasePath, 0o600);
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
    this.database.close(false);
  }

  async acquire(
    input: AcquireSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    const namespace = validateIdentifier(input.namespace, "namespace");
    const owner = validateOwner(input.owner);
    const duration = validateDuration(input.leaseDurationMs);
    return this.transaction(async (nowMs) => {
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
    validateIdentifier(namespace, "namespace");
    const nowMs = Date.now();
    const row = this.select(namespace);
    return row ? snapshot(row, nowMs) : null;
  }

  async heartbeat(
    input: RefreshSyntheticEnvironmentLeaseInput,
  ): Promise<SyntheticEnvironmentLeaseReceipt> {
    const authority = validateAuthority(input.authority);
    const duration = validateDuration(input.leaseDurationMs);
    return this.transaction(async (nowMs) => {
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
    const authority = validateAuthority(input.authority);
    const duration = validateDuration(input.leaseDurationMs);
    return this.transaction(async (nowMs) => {
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
    return this.transaction(async (nowMs) => {
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
    return this.transaction(async (nowMs) => {
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

  private async transaction<T>(
    operation: (nowMs: number) => Promise<T>,
  ): Promise<T> {
    const previous = this.transactionTail;
    let release: () => void = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.database.run("BEGIN IMMEDIATE");
      try {
        const result = await operation(Date.now());
        this.database.run("COMMIT");
        return result;
      } catch (error) {
        // error-policy:J2 rollback restores the atomic generation boundary;
        // the original typed failure is preserved for the caller.
        this.database.run("ROLLBACK");
        throw error;
      }
    } finally {
      release();
    }
  }
}
