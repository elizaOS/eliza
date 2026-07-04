/**
 * Durable, cross-restart replay guard for x402 payment credentials, backed
 * by the runtime's `cache` table (or `runtime.getCache`/`setCache` when the
 * SQL connection isn't reachable). Reservation is two-phase: `TryReserve`
 * atomically claims a replay key as "inflight" with a TTL (via `INSERT ...
 * ON CONFLICT DO NOTHING` when SQL is available, so concurrent requests for
 * the same credential can't both proceed), then callers either
 * `CommitReservation` on successful verification (marking the key
 * permanently "consumed") or `AbortReservation` on failure (freeing it for
 * retry). Expired inflight reservations can be stolen so a crashed request
 * doesn't permanently block retries.
 */
import { createHash, randomUUID } from "node:crypto";
import { type AgentRuntime, logger } from "@elizaos/core";
import { sql } from "drizzle-orm";

function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Stored in the runtime cache while verification owns a durable reservation. */
export type X402ReplayInflightPayload = {
  state: "inflight";
  owner: string;
  reservedAt: number;
  expiresAt: number;
};

/** Stored in the runtime cache after a successful payment verification. */
export type X402ReplayConsumedPayload = {
  state: "consumed";
  consumedAt: number;
};

export type X402ReplayPayload =
  | X402ReplayInflightPayload
  | X402ReplayConsumedPayload;

export type DurableReplayReservation =
  | { ok: true; owner: string; atomic: boolean }
  | { ok: false };

/**
 * Thrown when a successfully-verified payment credential could NOT be durably
 * recorded as consumed (SQL commit matched no reserved row, or the cache write
 * failed). This is security-critical: an un-recorded consumption leaves the
 * credential replayable once its inflight reservation TTL lapses, so callers
 * MUST fail closed (deny the unlock) rather than proceed on a consumption the
 * replay guard cannot back. Distinct type so the payment boundary can classify
 * it precisely rather than treating it as a generic verification error.
 * error-policy:J4 fail-closed.
 */
export class X402ReplayCommitError extends Error {
  readonly replayKeys: string[];
  constructor(message: string, replayKeys: string[]) {
    super(message);
    this.name = "X402ReplayCommitError";
    this.replayKeys = replayKeys;
  }
}

type QueryableDb = {
  execute: (query: unknown) => Promise<unknown>;
};

/**
 * Stable cache key for a replay credential, scoped by agent so two agents never
 * share the same cache row.
 */
export function durableReplayCacheKey(
  agentId: string | undefined,
  replayKey: string,
): string {
  const agent = agentId && agentId.trim().length > 0 ? agentId.trim() : "_";
  return `x402:replay:v1:${sha256Utf8(`${agent}::${replayKey}`)}`;
}

function replayReservationTtlMs(): number {
  const raw = process.env.X402_REPLAY_RESERVATION_TTL_MS;
  const n = Number.parseInt(raw ?? "120000", 10);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

function resultHadRows(result: unknown): boolean {
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length > 0;
    const rowCount = (result as { rowCount?: unknown }).rowCount;
    if (typeof rowCount === "number") return rowCount > 0;
  }
  return false;
}

async function getSqlDb(runtime: AgentRuntime): Promise<QueryableDb | null> {
  const db = await runtime.adapter?.getConnection?.();
  if (
    db &&
    typeof db === "object" &&
    typeof (db as { execute?: unknown }).execute === "function"
  ) {
    return db as QueryableDb;
  }
  return null;
}

async function insertInflightReservation(
  db: QueryableDb,
  agentId: string,
  cacheKey: string,
  payload: X402ReplayInflightPayload,
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO cache (key, agent_id, value)
    VALUES (${cacheKey}, ${agentId}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (key, agent_id) DO NOTHING
    RETURNING key
  `);
  return resultHadRows(result);
}

async function stealExpiredInflightReservation(
  db: QueryableDb,
  agentId: string,
  cacheKey: string,
  payload: X402ReplayInflightPayload,
  now: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE cache
    SET value = ${JSON.stringify(payload)}::jsonb
    WHERE key = ${cacheKey}
      AND agent_id = ${agentId}
      AND value->>'state' = 'inflight'
      AND COALESCE((value->>'expiresAt')::bigint, 0) <= ${now}
    RETURNING key
  `);
  return resultHadRows(result);
}

async function releaseSqlReservations(
  db: QueryableDb,
  agentId: string,
  cacheKeys: string[],
  owner: string,
): Promise<void> {
  for (const cacheKey of cacheKeys) {
    await db.execute(sql`
      DELETE FROM cache
      WHERE key = ${cacheKey}
        AND agent_id = ${agentId}
        AND value->>'state' = 'inflight'
        AND value->>'owner' = ${owner}
    `);
  }
}

async function commitSqlReservations(
  db: QueryableDb,
  agentId: string,
  cacheKeys: string[],
  owner: string,
): Promise<void> {
  const payload: X402ReplayConsumedPayload = {
    state: "consumed",
    consumedAt: Date.now(),
  };
  const uncommitted: string[] = [];
  for (const cacheKey of cacheKeys) {
    const result = await db.execute(sql`
      UPDATE cache
      SET value = ${JSON.stringify(payload)}::jsonb
      WHERE key = ${cacheKey}
        AND agent_id = ${agentId}
        AND value->>'state' = 'inflight'
        AND value->>'owner' = ${owner}
      RETURNING key
    `);
    if (!resultHadRows(result)) {
      // error-policy:J4 fail-closed — the reserved 'inflight' row we owned was
      // NOT transitioned to 'consumed' (stolen after TTL, released, or already
      // committed by a racing request). Do NOT silently continue: an
      // un-consumed credential becomes replayable once any lingering inflight
      // reservation lapses. Record it and throw so the payment boundary denies
      // the unlock instead of granting access the guard can't back.
      logger.error(
        `[x402] durable replay: failed to commit reserved replay key ${cacheKey}`,
      );
      uncommitted.push(cacheKey);
    }
  }
  if (uncommitted.length > 0) {
    throw new X402ReplayCommitError(
      `durable replay: ${uncommitted.length} replay key(s) not marked consumed on commit`,
      uncommitted,
    );
  }
}

function isConsumed(value: X402ReplayPayload | undefined): boolean {
  if (!value) return false;
  return value.state === "consumed" || "consumedAt" in value;
}

export async function durableReplayTryReserve(
  runtime: AgentRuntime,
  agentId: string | undefined,
  keys: string[],
): Promise<DurableReplayReservation> {
  if (keys.length === 0) return { ok: true, owner: randomUUID(), atomic: true };

  const db = await getSqlDb(runtime);
  const resolvedAgentId =
    agentId && agentId.trim().length > 0
      ? agentId.trim()
      : runtime.agentId
        ? String(runtime.agentId)
        : undefined;

  if (db && resolvedAgentId) {
    const owner = randomUUID();
    const now = Date.now();
    const payload: X402ReplayInflightPayload = {
      state: "inflight",
      owner,
      reservedAt: now,
      expiresAt: now + replayReservationTtlMs(),
    };
    const acquired: string[] = [];
    try {
      for (const replayKey of keys) {
        const cacheKey = durableReplayCacheKey(resolvedAgentId, replayKey);
        if (
          (await insertInflightReservation(
            db,
            resolvedAgentId,
            cacheKey,
            payload,
          )) ||
          (await stealExpiredInflightReservation(
            db,
            resolvedAgentId,
            cacheKey,
            payload,
            now,
          ))
        ) {
          acquired.push(cacheKey);
          continue;
        }

        await releaseSqlReservations(db, resolvedAgentId, acquired, owner);
        return { ok: false };
      }
      return { ok: true, owner, atomic: true };
    } catch (err) {
      // error-policy:J4 fail-closed — a durable reservation that faults mid-way
      // must DENY (`ok: false`), never fabricate a reservation; the inner
      // release .catch is error-policy:J6 best-effort teardown of the partial
      // reservations we already acquired on this failed path.
      await releaseSqlReservations(db, resolvedAgentId, acquired, owner).catch(
        () => {},
      );
      logger.error(
        `[x402] durable replay: atomic reservation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false };
    }
  }

  const owner = randomUUID();
  for (const replayKey of keys) {
    const cacheKey = durableReplayCacheKey(agentId, replayKey);
    const v = await runtime.getCache<X402ReplayPayload>(cacheKey);
    if (isConsumed(v)) return { ok: false };
    if (v?.state === "inflight" && v.expiresAt > Date.now()) {
      return { ok: false };
    }
  }
  const now = Date.now();
  const payload: X402ReplayInflightPayload = {
    state: "inflight",
    owner,
    reservedAt: now,
    expiresAt: now + replayReservationTtlMs(),
  };
  for (const replayKey of keys) {
    await runtime.setCache(durableReplayCacheKey(agentId, replayKey), payload);
  }
  return { ok: true, owner, atomic: false };
}

export async function durableReplayAbortReservation(
  runtime: AgentRuntime,
  agentId: string | undefined,
  keys: string[],
  owner?: string,
): Promise<void> {
  if (!owner || keys.length === 0) return;
  const db = await getSqlDb(runtime);
  const resolvedAgentId =
    agentId && agentId.trim().length > 0
      ? agentId.trim()
      : runtime.agentId
        ? String(runtime.agentId)
        : undefined;
  if (db && resolvedAgentId) {
    await releaseSqlReservations(
      db,
      resolvedAgentId,
      keys.map((k) => durableReplayCacheKey(resolvedAgentId, k)),
      owner,
    );
    return;
  }
  for (const replayKey of keys) {
    const cacheKey = durableReplayCacheKey(agentId, replayKey);
    const v = await runtime.getCache<X402ReplayPayload>(cacheKey);
    if (v?.state === "inflight" && v.owner === owner) {
      await runtime.deleteCache(cacheKey);
    }
  }
}

export async function durableReplayCommitReservation(
  runtime: AgentRuntime,
  agentId: string | undefined,
  keys: string[],
  owner?: string,
): Promise<void> {
  if (keys.length === 0) return;
  const db = await getSqlDb(runtime);
  const resolvedAgentId =
    agentId && agentId.trim().length > 0
      ? agentId.trim()
      : runtime.agentId
        ? String(runtime.agentId)
        : undefined;
  if (db && resolvedAgentId && owner) {
    await commitSqlReservations(
      db,
      resolvedAgentId,
      keys.map((k) => durableReplayCacheKey(resolvedAgentId, k)),
      owner,
    );
    return;
  }

  const payload: X402ReplayConsumedPayload = {
    state: "consumed",
    consumedAt: Date.now(),
  };
  const uncommitted: string[] = [];
  for (const replayKey of keys) {
    const ok = await runtime.setCache(
      durableReplayCacheKey(agentId, replayKey),
      payload,
    );
    if (!ok) {
      // error-policy:J4 fail-closed — same invariant as the SQL path: a
      // credential we could not persist as 'consumed' stays replayable. Surface
      // + throw so the caller denies the unlock rather than fabricating a
      // durable consumption that never landed.
      logger.error(
        `[x402] durable replay: setCache failed for replay key ${replayKey.slice(
          0,
          80,
        )} (consumption not persisted — failing closed)`,
      );
      uncommitted.push(replayKey);
    }
  }
  if (uncommitted.length > 0) {
    throw new X402ReplayCommitError(
      `durable replay: ${uncommitted.length} replay key(s) not persisted as consumed`,
      uncommitted,
    );
  }
}
