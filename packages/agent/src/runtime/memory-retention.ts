/**
 * Bounded memory retention for the append-only `memories` partitions (and the
 * `embeddings` rows that cascade with them). This is the mechanism that keeps
 * the core memory store from growing without bound — the failure class behind
 * the historical PGlite disk-fill: `memories` + `embeddings` accrete one row
 * per turn/fact/fragment forever, and nothing upstream prunes them.
 *
 * Two orthogonal, config-driven bounds, applied per (room, partition):
 *   - AGE: delete rows older than `retentionDays`.
 *   - COUNT: keep at most `maxRowsPerRoom` most-recent rows.
 * A row is a deletion candidate if EITHER bound would evict it; the newest
 * `maxRowsPerRoom` rows within the age window are always preserved. Deletion is
 * batched (via `deleteManyMemories`, which drops each memory's embeddings in the
 * same transaction) so a prune never issues one giant statement.
 *
 * SAFE DEFAULTS: retention is OFF unless explicitly configured. An unset or
 * non-positive `retentionDays` AND an unset/non-positive `maxRowsPerRoom` yields
 * an empty plan — the sweep is a no-op, so simply shipping this code changes no
 * behavior until an operator opts in.
 *
 * This module is pure: it computes a deletion plan from a snapshot of memory
 * ids + timestamps. All I/O (querying candidates, issuing deletes, scheduling)
 * lives in `memory-retention-service.ts`, so the eviction policy is unit-testable
 * without a database. It NEVER references any table other than the memory
 * partitions it is handed; other tables (auth audit, logs, central_messages)
 * are out of scope by construction.
 */

/** A minimal row descriptor: enough to decide eviction, nothing more. */
export interface RetainableRow {
  /** Memory id (opaque; only used to name the row in the plan). */
  id: string;
  /** Room the row belongs to (bounds are applied per room). */
  roomId: string;
  /** Creation time, ms since epoch. Rows without one are treated as newest. */
  createdAt: number;
}

/** Resolved, validated retention bounds for a single sweep. */
export interface RetentionPolicy {
  /**
   * Delete rows strictly older than this many days. `<= 0` or undefined
   * disables the age bound.
   */
  retentionDays?: number;
  /**
   * Keep at most this many most-recent rows per (room, partition). `<= 0` or
   * undefined disables the count bound.
   */
  maxRowsPerRoom?: number;
  /**
   * Cap on how many ids a single sweep will delete, across all rooms. Protects
   * against a first-ever prune of a huge backlog issuing an unbounded delete
   * set. `<= 0` or undefined means no cap (delete everything the bounds evict).
   * The sweep is idempotent, so a capped sweep simply finishes on the next run.
   */
  maxDeletePerSweep?: number;
}

/** The computed outcome of planning a sweep for one partition. */
export interface RetentionPlan {
  /** Ids to delete, oldest-first. Safe to pass straight to a batch delete. */
  deleteIds: string[];
  /** How many rows the bounds would evict before `maxDeletePerSweep` clamping. */
  evictable: number;
  /** True when `maxDeletePerSweep` clamped the plan (more remains next sweep). */
  clamped: boolean;
}

/** True when the policy has at least one active bound. */
export function policyIsActive(policy: RetentionPolicy): boolean {
  return (
    (typeof policy.retentionDays === "number" && policy.retentionDays > 0) ||
    (typeof policy.maxRowsPerRoom === "number" && policy.maxRowsPerRoom > 0)
  );
}

/**
 * Compute the deletion plan for a set of rows in ONE partition.
 *
 * @param rows  All rows in the partition (any order). Not mutated.
 * @param policy Resolved bounds.
 * @param nowMs Current time in ms (injected for deterministic tests).
 *
 * Contract:
 *   - Returns `{ deleteIds: [], evictable: 0, clamped: false }` when the policy
 *     is inactive — a hard guarantee that an unconfigured runtime prunes nothing.
 *   - Groups by roomId; within each room, sorts newest-first and preserves the
 *     first `maxRowsPerRoom` (count bound) and everything inside the age window
 *     (age bound). A row survives iff BOTH bounds would retain it.
 *   - `deleteIds` is globally sorted oldest-first so a clamp drops the oldest
 *     backlog first and the plan is deterministic regardless of input order.
 */
export function planRetention(
  rows: RetainableRow[],
  policy: RetentionPolicy,
  nowMs: number,
): RetentionPlan {
  if (!policyIsActive(policy)) {
    return { deleteIds: [], evictable: 0, clamped: false };
  }

  const ageCutoff =
    typeof policy.retentionDays === "number" && policy.retentionDays > 0
      ? nowMs - policy.retentionDays * 24 * 60 * 60 * 1000
      : undefined;
  const maxRows =
    typeof policy.maxRowsPerRoom === "number" && policy.maxRowsPerRoom > 0
      ? Math.floor(policy.maxRowsPerRoom)
      : undefined;

  // Bucket rows by room so the count bound is per-room, not global.
  const byRoom = new Map<string, RetainableRow[]>();
  for (const row of rows) {
    const bucket = byRoom.get(row.roomId);
    if (bucket) bucket.push(row);
    else byRoom.set(row.roomId, [row]);
  }

  const evicted: RetainableRow[] = [];
  for (const bucket of byRoom.values()) {
    // Newest-first; missing createdAt sorts as "now" (never evicted by age,
    // treated as most-recent for the count bound — fail safe, keep the row).
    const sorted = [...bucket].sort((a, b) => tsOf(b, nowMs) - tsOf(a, nowMs));
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const overCount = maxRows !== undefined && i >= maxRows;
      const overAge = ageCutoff !== undefined && tsOf(row, nowMs) < ageCutoff;
      if (overCount || overAge) evicted.push(row);
    }
  }

  // Oldest-first globally: deterministic, and a clamp sheds the oldest backlog.
  evicted.sort((a, b) => tsOf(a, nowMs) - tsOf(b, nowMs));

  const evictable = evicted.length;
  const cap =
    typeof policy.maxDeletePerSweep === "number" && policy.maxDeletePerSweep > 0
      ? Math.floor(policy.maxDeletePerSweep)
      : undefined;
  const clamped = cap !== undefined && evictable > cap;
  const deleteRows = clamped ? evicted.slice(0, cap) : evicted;

  return {
    deleteIds: deleteRows.map((r) => r.id),
    evictable,
    clamped,
  };
}

/** Row timestamp, defaulting a missing/NaN value to `nowMs` (keep-safe). */
function tsOf(row: RetainableRow, nowMs: number): number {
  return typeof row.createdAt === "number" && Number.isFinite(row.createdAt)
    ? row.createdAt
    : nowMs;
}

/**
 * Resolve a {@link RetentionPolicy} from a settings/env-style string map.
 * Kept separate from `process.env` so a host can fold config in however it
 * likes (see the runtime's `getSetting` invariant: it never reads env directly).
 *
 * Recognised keys (all optional; absent/blank => bound disabled):
 *   - `ELIZA_MEMORY_RETENTION_DAYS`
 *   - `ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM`
 *   - `ELIZA_MEMORY_RETENTION_MAX_DELETE_PER_SWEEP`
 *   - `ELIZA_MEMORY_RETENTION_INTERVAL_MINUTES` (service uses; parsed here too)
 *
 * Invalid/non-numeric values are treated as "unset" (fail safe: OFF), never as
 * zero-retention-delete-everything.
 */
export interface ResolvedRetentionConfig extends RetentionPolicy {
  /** Sweep cadence in minutes. Undefined => service default. */
  intervalMinutes?: number;
}

export function resolveRetentionConfig(
  get: (key: string) => string | undefined,
): ResolvedRetentionConfig {
  return resolveRetentionConfigWithPrefix(get, "ELIZA_MEMORY_RETENTION");
}

/**
 * Generic resolver shared by every table-scoped retention subsystem. Reads the
 * same four bound keys under a caller-chosen prefix so a second surface (logs,
 * central_messages, ...) gets an INDEPENDENT, separately-defaulted-OFF config
 * without duplicating the parse/fail-safe logic.
 *
 * Keys read (all optional; absent/blank/non-positive => bound disabled):
 *   - `${prefix}_DAYS`
 *   - `${prefix}_MAX_ROWS_PER_ROOM`
 *   - `${prefix}_MAX_DELETE_PER_SWEEP`
 *   - `${prefix}_INTERVAL_MINUTES`
 */
export function resolveRetentionConfigWithPrefix(
  get: (key: string) => string | undefined,
  prefix: string,
): ResolvedRetentionConfig {
  return {
    retentionDays: positiveNumberOrUndefined(get(`${prefix}_DAYS`)),
    maxRowsPerRoom: positiveIntegerOrUndefined(
      get(`${prefix}_MAX_ROWS_PER_ROOM`),
    ),
    maxDeletePerSweep: positiveIntegerOrUndefined(
      get(`${prefix}_MAX_DELETE_PER_SWEEP`),
    ),
    intervalMinutes: positiveNumberOrUndefined(
      get(`${prefix}_INTERVAL_MINUTES`),
    ),
  };
}

function positiveNumberOrUndefined(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function positiveIntegerOrUndefined(
  raw: string | undefined,
): number | undefined {
  const value = positiveNumberOrUndefined(raw);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}
