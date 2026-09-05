/**
 * Tamper-evident audit log writer & verifier.
 *
 * Every audit event extends a per-tenant HMAC chain. Each row's `hmac`
 * commits to `prev_hash || canonical_json(event)` keyed by
 * STEWARD_AUDIT_HMAC_KEY. Mutating any historical row breaks verification
 * of every subsequent row.
 *
 * Trust boundary: the HMAC key is held in app config, separate from
 * Postgres credentials. An attacker with DB-only write access cannot
 * forge rows that pass verification.
 *
 * Concurrency: writers serialize chain extensions per tenant with
 * `pg_advisory_xact_lock(hashtextextended('steward_audit_'||tenant_id, 0))`.
 * Cross-tenant writes do not contend.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@elizaos/logger";
import { sql } from "drizzle-orm";
import {
  type AppendRequiredAudit,
  type AuditEventInput,
  appendAuditEvent,
  appendAuditEventWithinTx,
  auditCheckpoints,
  getDb,
  waitUntilRequestDatabaseTask,
  withTenantAuditedTransaction,
  withTenantAuditQueue,
  writeAuditEvent,
} from "../../../db/src/index.ts";
import {
  observeAuditCheckpoint,
  redactedThrownDiagnostics,
} from "../../../shared/src/index.ts";
import {
  type CheckpointEventContent,
  type CheckpointPayload,
  eventsContentDigest,
  getCheckpointSigner,
} from "./audit-checkpoint";
import {
  AuditCheckpointAnchorError,
  type AuditCheckpointAnchorProof,
  configuredAuditCheckpointAnchor,
  maybeAnchorAuditCheckpoint,
} from "./audit-checkpoint-anchor";
import { API_VERSION } from "./version";

/**
 * The canonicalization contract an offline verifier must reproduce per event.
 * Single source of truth (spec §6.2): the route re-exports this. Bumped only
 * alongside a verifier change.
 */
export const BUNDLE_CANONICALIZATION_SPEC =
  "steward-audit-hmac-chain/v1: hmac = HMAC-SHA256(key, prev_hash_bytes || " +
  "canonical_json(event)); canonical_json sorts object keys, drops whitespace, " +
  "encodes null for absent fields and ISO-8601 for timestamps. Offline verifier " +
  "checks event linkage (each prevHash === prior hmac) + head == checkpoint, and " +
  "the Ed25519 signature over the canonical checkpoint payload. Per-row HMAC " +
  "recomputation requires the operator's secret key and is NOT part of offline " +
  "verification.";

export type { AuditActorType as ActorType } from "../../../db/src/index.ts";

/**
 * Minimal read surface a snapshot transaction (or the db) must expose so the
 * The case correlator can run `verifyAuditChain` + `readAuditBundleData` inside
 * ONE coherent snapshot. Both the Drizzle db and a Drizzle tx satisfy this; we
 * alias to the db's own type so the internal `.execute(sql\`...\`)` calls keep
 * their existing typing when an executor is supplied.
 */
export type AuditReadExecutor = Pick<ReturnType<typeof getDb>, "execute">;

/** Build the high-water aggregate read, bounded when doctor supplies maxRows. */
export function auditRowAggregateQuery(
  tenantId: string,
  genesisSeq: number,
  maxRows?: number,
) {
  return maxRows === undefined
    ? sql`SELECT MAX(seq) AS max_seq, COUNT(*) AS cnt FROM audit_events WHERE tenant_id = ${tenantId} AND seq >= ${genesisSeq}`
    : sql`SELECT MAX(seq) AS max_seq, COUNT(*) AS cnt
          FROM (
            SELECT seq FROM audit_events
            WHERE tenant_id = ${tenantId} AND seq >= ${genesisSeq}
            ORDER BY seq ASC
            LIMIT ${maxRows + 1}
          ) AS bounded_audit_events`;
}
// The tamper-evident audit-chain WRITE core (append/transaction primitives, the
// HMAC key handling, and metadata redaction) now lives in `@stwd/db` so the
// proxy package can extend the chain atomically without importing `@stwd/api`
// (which would be a dependency cycle). This file re-exports them so its existing
// importers are unaffected, and keeps the API-only READ side below
// (verifyAuditChain, evidence bundles, ActorType, trackAuditEvent).
export type { AppendRequiredAudit, AuditEventInput };
export {
  appendAuditEvent,
  appendAuditEventWithinTx,
  withTenantAuditedTransaction,
  withTenantAuditQueue,
  writeAuditEvent,
};

const ZERO_HASH = new Uint8Array(32);

function toU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    // Postgres bytea hex format: `\x...` or hex string.
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }
  throw new Error("toU8: unsupported value");
}

function u8Equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Minimum entropy for the audit HMAC key: 32 bytes. Hex-encoded keys must be
// >= 64 hex chars (= 32 bytes); raw/passphrase keys must be >= 32 chars.
const MIN_HMAC_RAW_BYTES = 32;

let warnedDevFallback = false;
let cachedKey: Uint8Array | null = null;
function getHmacKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const env = process.env.STEWARD_AUDIT_HMAC_KEY;
  if (env && env.length > 0) {
    const isHex = /^[0-9a-fA-F]+$/.test(env) && env.length % 2 === 0;
    // Hex keys decode to env.length/2 bytes; raw keys count chars directly.
    const effectiveBytes = isHex ? env.length / 2 : env.length;
    if (effectiveBytes < MIN_HMAC_RAW_BYTES) {
      throw new Error(
        `STEWARD_AUDIT_HMAC_KEY is too weak: needs >= ${MIN_HMAC_RAW_BYTES} bytes of entropy ` +
          `(>= ${MIN_HMAC_RAW_BYTES * 2} hex chars, or >= ${MIN_HMAC_RAW_BYTES} raw chars). ` +
          "Generate with `openssl rand -hex 32`.",
      );
    }
    cachedKey =
      isHex && env.length >= MIN_HMAC_RAW_BYTES * 2
        ? toU8(env)
        : new TextEncoder().encode(env);
    return cachedKey;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "STEWARD_AUDIT_HMAC_KEY is required in production. Generate with `openssl rand -hex 32`.",
    );
  }
  // Default-deny: the dev fallback is only allowed with an explicit opt-in
  // consistent with the rest of the repo (STEWARD_ALLOW_DEV_SECRETS).
  if (process.env.STEWARD_ALLOW_DEV_SECRETS !== "true") {
    throw new Error(
      "STEWARD_AUDIT_HMAC_KEY is required. For local development only, set " +
        "STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev key.",
    );
  }
  if (!warnedDevFallback) {
    warnedDevFallback = true;
    logger.warn(
      {
        details: [
          "⚠️ [audit] STEWARD_AUDIT_HMAC_KEY not set — using INSECURE dev fallback " +
            "(STEWARD_ALLOW_DEV_SECRETS=true). Audit chain is NOT tamper-evident. Never use in production.",
        ],
      },
      "[Login:audit] warn",
    );
  }
  cachedKey = new TextEncoder().encode(
    "dev-audit-hmac-key-do-not-use-in-production-aaaaaaaaaaaaaaaaaaaaaaaa",
  );
  return cachedKey;
}

/**
 * Canonical JSON: keys sorted, no whitespace, ISO timestamps. The HMAC commits
 * to this exact byte sequence — changing any field changes the digest.
 */
function canonicalJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.map((item) => canonicalJsonValue(item));
  if (typeof value === "object") {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      ordered[key] = canonicalJsonValue(
        (value as Record<string, unknown>)[key],
      );
    }
    return ordered;
  }
  return value;
}

function canonicalize(fields: Record<string, unknown>): string {
  return JSON.stringify(canonicalJsonValue(fields));
}

function computeHmac(
  key: Uint8Array,
  prevHash: Uint8Array,
  canonical: string,
): Uint8Array {
  const h = createHmac("sha256", key);
  h.update(prevHash);
  h.update(canonical);
  return new Uint8Array(h.digest());
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Records best-effort telemetry after an operation has committed, logging failures.
 * Security-sensitive operations must await writeAuditEvent and fail if their
 * durable audit record cannot be written.
 */
export function trackAuditEvent(ev: AuditEventInput): Promise<void> {
  return waitUntilRequestDatabaseTask(() =>
    writeAuditEvent(ev).catch((err) => {
      logger.error(
        {
          details: [
            `[audit] Failed to write event ${ev.action} for tenant ${ev.tenantId}`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:audit] error",
      );
    }),
  );
}

/**
 * Walk the chain for a tenant and verify every HMAC.
 *
 * Returns `{ valid: true, count }` if the entire range verifies, otherwise
 * `{ valid: false, brokenAt }` pointing to the first row whose digest does
 * not match the expected value computed from its predecessor.
 */
export async function verifyAuditChain(
  tenantId: string,
  opts: {
    fromSeq?: number;
    toSeq?: number;
    requireHead?: boolean;
    /** Hard cap enforced by the SQL read itself (LIMIT maxRows + 1). */
    maxRows?: number;
    /**
     * Optional read executor (a snapshot transaction) so callers can verify a
     * chain segment WITHIN a single coherent snapshot alongside other reads
     * (§4.1/§4.3 KC06). Defaults to `getDb()`; behavior is otherwise
     * identical. Must expose `.execute(sql)` like the Drizzle db/tx.
     */
    executor?: AuditReadExecutor;
  } = {},
): Promise<
  | { valid: true; count: number }
  | { valid: false; brokenAt: number; limitExceeded?: boolean }
> {
  const key = getHmacKey();
  const db = opts.executor ?? getDb();
  const requestedFromSeq = opts.fromSeq ?? 1;
  const toSeq = opts.toSeq;
  const maxRows = opts.maxRows;
  if (
    maxRows !== undefined &&
    (!Number.isSafeInteger(maxRows) || maxRows <= 0 || maxRows > 1_000_000)
  ) {
    throw new Error(
      "maxRows must be a positive safe integer no greater than 1000000",
    );
  }

  // Out-of-band high-water-mark: persisted atomically with each append. Lets us
  // detect tail-truncation / whole-chain deletion that walking the surviving
  // rows alone cannot (an open-ended walk of a truncated chain still "verifies").
  const headRows = rowsFromExecute<{
    expected_seq: number | string;
    expected_count: number | string;
    head_hmac: unknown;
    floor_seq: number | string | null;
    floor_hmac: unknown;
  }>(
    await db.execute(
      sql`SELECT expected_seq, expected_count, head_hmac, floor_seq, floor_hmac
          FROM audit_chain_heads WHERE tenant_id = ${tenantId} LIMIT 1`,
    ),
  );
  const head = headRows[0];
  if (!head && opts.requireHead) {
    return { valid: false, brokenAt: requestedFromSeq };
  }
  const floorSeq = head?.floor_seq != null ? Number(head.floor_seq) : 0;
  const floorHmac = head?.floor_hmac != null ? toU8(head.floor_hmac) : null;

  // Genesis prevHash: after a retention archive+drop, the chain restarts from a
  // stored floor anchor rather than the public ZERO_HASH (which an attacker
  // could re-derive to forge a fresh seq=1). Below the floor, rows are gone.
  const genesisSeq = floorSeq + 1;
  let prevHash: Uint8Array = floorSeq > 0 && floorHmac ? floorHmac : ZERO_HASH;

  // Full-chain verification (request starts at or before the live genesis):
  // compare on-disk reality against the high-water-mark to catch truncation.
  const isFullChainVerify = requestedFromSeq <= genesisSeq;
  if (isFullChainVerify && head) {
    const expectedSeqHwm = Number(head.expected_seq);
    const expectedCount = Number(head.expected_count);
    const aggRows = rowsFromExecute<{
      max_seq: number | string | null;
      cnt: number | string;
    }>(await db.execute(auditRowAggregateQuery(tenantId, genesisSeq, maxRows)));
    const actualMaxSeq =
      aggRows[0]?.max_seq != null ? Number(aggRows[0].max_seq) : 0;
    const actualCount = aggRows[0]?.cnt != null ? Number(aggRows[0].cnt) : 0;
    const expectedLiveCount = expectedCount - (genesisSeq - 1);
    if (maxRows !== undefined && actualCount > maxRows) {
      return {
        valid: false,
        brokenAt: genesisSeq + maxRows,
        limitExceeded: true,
      };
    }
    // Missing newest rows (tail truncation) or whole-chain deletion: the stored
    // head outranks / outcounts what survives on disk. Point brokenAt at the
    // first missing seq.
    if (actualMaxSeq < expectedSeqHwm || actualCount < expectedLiveCount) {
      return {
        valid: false,
        brokenAt: actualMaxSeq + 1 < genesisSeq ? genesisSeq : actualMaxSeq + 1,
      };
    }
  }
  // A request that starts at genesis but there is NO head row yet means either a
  // never-written tenant (count 0, fine) or a head row that was itself deleted
  // alongside the chain — handled by the walk + final count comparison below.

  // Rows below the floor have been archived+dropped; never expect them on disk.
  const effectiveFromSeq = Math.max(requestedFromSeq, genesisSeq);

  if (effectiveFromSeq > genesisSeq) {
    const predecessorRows = rowsFromExecute<{ hmac: unknown }>(
      await db.execute(
        sql`SELECT hmac FROM audit_events WHERE tenant_id = ${tenantId} AND seq = ${effectiveFromSeq - 1} LIMIT 1`,
      ),
    );
    const predecessor = predecessorRows[0];
    if (predecessor) {
      prevHash = toU8(predecessor.hmac);
    }
  }

  const rows = rowsFromExecute<{
    tenant_id: string;
    seq: number | string;
    prev_hash: unknown;
    hmac: unknown;
    actor_type: string;
    actor_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    metadata: Record<string, unknown> | null;
    ip_address: string | null;
    user_agent: string | null;
    request_id: string | null;
    created_at: Date | string;
  }>(
    await db.execute(
      toSeq !== undefined
        ? maxRows !== undefined
          ? sql`SELECT * FROM audit_events WHERE tenant_id = ${tenantId} AND seq BETWEEN ${effectiveFromSeq} AND ${toSeq} ORDER BY seq ASC LIMIT ${maxRows + 1}`
          : sql`SELECT * FROM audit_events WHERE tenant_id = ${tenantId} AND seq BETWEEN ${effectiveFromSeq} AND ${toSeq} ORDER BY seq ASC`
        : maxRows !== undefined
          ? sql`SELECT * FROM audit_events WHERE tenant_id = ${tenantId} AND seq >= ${effectiveFromSeq} ORDER BY seq ASC LIMIT ${maxRows + 1}`
          : sql`SELECT * FROM audit_events WHERE tenant_id = ${tenantId} AND seq >= ${effectiveFromSeq} ORDER BY seq ASC`,
    ),
  );

  if (maxRows !== undefined && rows.length > maxRows) {
    return {
      valid: false,
      brokenAt: effectiveFromSeq + maxRows,
      limitExceeded: true,
    };
  }

  let count = 0;
  let expectedSeq = effectiveFromSeq;
  for (const row of rows) {
    const rowSeq = Number(row.seq);
    if (rowSeq !== expectedSeq) {
      return { valid: false, brokenAt: expectedSeq };
    }

    const rowHmac = toU8(row.hmac);
    const rowPrev = toU8(row.prev_hash);

    if (!u8Equals(rowPrev, prevHash)) {
      return { valid: false, brokenAt: rowSeq };
    }

    const created =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);
    const canonical = canonicalize({
      tenant_id: row.tenant_id,
      seq: Number(row.seq),
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      metadata: row.metadata ?? {},
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      request_id: row.request_id,
      created_at: created.toISOString(),
    });
    const expected = computeHmac(key, prevHash, canonical);
    if (!u8Equals(rowHmac, expected)) {
      return { valid: false, brokenAt: rowSeq };
    }

    prevHash = rowHmac;
    count++;
    expectedSeq++;
  }

  if (toSeq !== undefined && expectedSeq <= toSeq) {
    return { valid: false, brokenAt: expectedSeq };
  }

  return { valid: true, count };
}

// ─── Evidence bundle support ──────────────────────────────────────────────────

function toHex(value: unknown): string {
  const bytes = toU8(value);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * A single event as it appears in an offline-verifiable evidence bundle. All
 * fields that feed the row's canonicalization are included so an third-party
 * verifier can reconstruct linkage (prevHash === prior hmac) WITHOUT the HMAC
 * key. `prevHash`/`hmac` are hex. Row HMACs are NOT recomputable offline (that
 * needs the secret key) — the bundle proves linkage + head match, not per-row
 * recomputation.
 */
export interface BundleEvent {
  seq: number;
  prevHash: string;
  hmac: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface AuditChainHeadInfo {
  /** Head sequence per the out-of-band high-water-mark. */
  expectedSeq: number;
  /** Live event count committed by the high-water-mark. */
  expectedCount: number;
  /** Hex HMAC of the head event. */
  headHmac: string;
  /** Retention floor (0 when nothing archived). */
  floorSeq: number;
}

export interface AuditBundleData {
  head: AuditChainHeadInfo | null;
  events: BundleEvent[];
  /** Hex HMAC of the newest event actually present in `events` (bundle head). */
  bundleHeadHmac: string | null;
  /** Seq of the newest event in `events`. */
  bundleHeadSeq: number | null;
}

/**
 * Read the events in [fromSeq, toSeq] for a tenant plus the chain-head
 * high-water-mark, formatted for an evidence bundle. Pure read; does not touch
 * the HMAC writer or verifier state.
 */
export async function readAuditBundleData(
  tenantId: string,
  fromSeq: number,
  toSeq: number,
  executor?: AuditReadExecutor,
): Promise<AuditBundleData> {
  const db = executor ?? getDb();

  const headRows = rowsFromExecute<{
    expected_seq: number | string;
    expected_count: number | string;
    head_hmac: unknown;
    floor_seq: number | string | null;
  }>(
    await db.execute(
      sql`SELECT expected_seq, expected_count, head_hmac, floor_seq
          FROM audit_chain_heads WHERE tenant_id = ${tenantId} LIMIT 1`,
    ),
  );
  const headRow = headRows[0];
  const head: AuditChainHeadInfo | null = headRow
    ? {
        expectedSeq: Number(headRow.expected_seq),
        expectedCount: Number(headRow.expected_count),
        headHmac: toHex(headRow.head_hmac),
        floorSeq: headRow.floor_seq != null ? Number(headRow.floor_seq) : 0,
      }
    : null;

  const rows = rowsFromExecute<{
    seq: number | string;
    prev_hash: unknown;
    hmac: unknown;
    actor_type: string;
    actor_id: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    metadata: Record<string, unknown> | null;
    ip_address: string | null;
    user_agent: string | null;
    request_id: string | null;
    created_at: Date | string;
  }>(
    await db.execute(
      sql`SELECT seq, prev_hash, hmac, actor_type, actor_id, action, resource_type,
                 resource_id, metadata, ip_address, user_agent, request_id, created_at
          FROM audit_events
          WHERE tenant_id = ${tenantId} AND seq BETWEEN ${fromSeq} AND ${toSeq}
          ORDER BY seq ASC`,
    ),
  );

  const events: BundleEvent[] = rows.map((row) => {
    const created =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);
    return {
      seq: Number(row.seq),
      prevHash: toHex(row.prev_hash),
      hmac: toHex(row.hmac),
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: row.metadata ?? {},
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      requestId: row.request_id,
      createdAt: created.toISOString(),
    };
  });

  const last = events.length > 0 ? events[events.length - 1] : null;

  return {
    head,
    events,
    bundleHeadHmac: last ? last.hmac : null,
    bundleHeadSeq: last ? last.seq : null,
  };
}

// ─── Signed bundle assembly (single source of signing truth) ──────────────────

/**
 * The self-contained, offline-verifiable signed bundle envelope shared by
 * `/audit/bundle` and `/v2/provider-actions/:id/evidence`. Factored out of
 * the route (spec §6.2) so both surfaces sign identically — one signing path,
 * one checkpoint-persistence policy, one canonicalization contract.
 */
export interface SignedAuditBundle {
  version: 1;
  tenantId: string;
  range: { from: number; to: number; includesHead: boolean };
  canonicalizationSpec: string;
  events: BundleEvent[];
  checkpoint: {
    payload: CheckpointPayload;
    signature: string;
    publicKey: string;
    anchor?: AuditCheckpointAnchorProof;
  };
  generatedAt: string;
}

/**
 * Sign a checkpoint over the chain head + a content digest over exactly the
 * bundle's events, persist the checkpoint best-effort (provenance only; the
 * bundle is authoritative regardless), and return the self-contained
 * signed bundle envelope.
 *
 * `bundleData` MUST come from `readAuditBundleData(tenantId, from, to)` (ideally
 * within the SAME snapshot executor as the caller's other reads). `from`/`to`
 * are the requested range bounds used only for the advisory `range` field; the
 * signed digest brackets the events actually present.
 *
 * Throws `AuditSigningKeyError` if the signing key is unavailable (the caller
 * maps it to 503). All other signing failures throw a generic Error.
 */
export async function signAuditBundle(
  tenantId: string,
  from: number,
  to: number,
  bundleData: AuditBundleData,
): Promise<SignedAuditBundle> {
  // Imported lazily-at-module-eval via require-style static imports below.
  const { head, events } = bundleData;

  const digestEvents: CheckpointEventContent[] = events.map((ev) => ({
    tenantId,
    seq: ev.seq,
    actorType: ev.actorType,
    actorId: ev.actorId,
    action: ev.action,
    resourceType: ev.resourceType,
    resourceId: ev.resourceId,
    metadata: ev.metadata,
    ipAddress: ev.ipAddress,
    userAgent: ev.userAgent,
    requestId: ev.requestId,
    createdAt: ev.createdAt,
  }));

  const signer = getCheckpointSigner();
  const nowIso = new Date().toISOString();
  const checkpointPayload: CheckpointPayload = {
    v: 1,
    tenantId,
    seq: head?.expectedSeq ?? 0,
    headHmac: head?.headHmac ?? "",
    expectedCount: head?.expectedCount ?? 0,
    floorSeq: head?.floorSeq ?? 0,
    timestamp: nowIso,
    softwareVersion: API_VERSION,
    eventsDigest: eventsContentDigest(digestEvents),
    eventsFromSeq: events.length > 0 ? events[0].seq : 0,
    eventsToSeq: events.length > 0 ? events[events.length - 1].seq : 0,
  };
  const signed = signer.sign(checkpointPayload);
  // Default/off mode returns synchronously without constructing a sink or
  // touching the network. Required mode throws instead of emitting an
  // unanchored bundle; best-effort mode logs and preserves the v1 envelope.
  const anchorConfiguration = configuredAuditCheckpointAnchor();
  const anchor = await maybeAnchorAuditCheckpoint(signed, anchorConfiguration);
  // Process-local operational gauge only. Durable checkpoint evidence is the
  // signed payload/table below and remains authoritative across restarts.
  try {
    observeAuditCheckpoint(Date.parse(checkpointPayload.timestamp));
  } catch {
    // Monitoring is best-effort and cannot affect evidence generation.
  }

  // Persist the checkpoint (append-only provenance). Best-effort: a persistence
  // failure must not deny the auditor their signed bundle (self-contained).
  // Unanchored empty exports retain the historical no-row behavior. Once a
  // third-party proof exists, however, persist it even for the signed empty
  // checkpoint: required mode must never return a proof that has no durable
  // checkpoint binding.
  if (head || anchor) {
    try {
      await getDb()
        .insert(auditCheckpoints)
        .values({
          tenantId,
          seq: checkpointPayload.seq,
          headHmac: hexToBytesLocal(checkpointPayload.headHmac),
          payload: checkpointPayload as unknown as Record<string, unknown>,
          signature: signed.signature,
          publicKey: signed.publicKey,
          anchorProof: anchor as unknown as Record<string, unknown> | undefined,
          anchorVerifiedAt: anchor ? new Date(anchor.verifiedAt) : undefined,
        });
    } catch (err) {
      if (anchor && anchorConfiguration.mode === "required") {
        throw new AuditCheckpointAnchorError(
          "Required RFC 3161 checkpoint proof could not be persisted atomically",
          { cause: err },
        );
      }
      logger.error(
        {
          details: [
            `[audit] checkpoint persistence failed for tenant ${tenantId}`,
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:audit] error",
      );
    }
  }

  const includesHead =
    head != null &&
    bundleData.bundleHeadSeq != null &&
    bundleData.bundleHeadSeq === head.expectedSeq;

  return {
    version: 1,
    tenantId,
    range: { from, to, includesHead },
    canonicalizationSpec: BUNDLE_CANONICALIZATION_SPEC,
    events,
    checkpoint: {
      payload: signed.payload,
      signature: signed.signature,
      publicKey: signed.publicKey,
      ...(anchor ? { anchor } : {}),
    },
    generatedAt: new Date().toISOString(),
  };
}

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
