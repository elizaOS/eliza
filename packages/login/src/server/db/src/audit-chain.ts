/**
 * Shared tamper-evident audit-chain WRITE core.
 *
 * This module holds the append/transaction primitives that BOTH the API and
 * proxy packages need so a state transition and its required audit event can be
 * committed atomically (spec section 7.1 / invariant I14, "evidence before
 * visibility"). It deliberately lives in `@stwd/db` — the lowest package both
 * `@stwd/api` and `@stwd/proxy` already depend on — so the proxy can extend the
 * audit chain WITHOUT importing `@stwd/api` (which would be a dependency-cycle /
 * wrong-direction edge; nothing depends on `@stwd/proxy` from here).
 *
 * The verifier / evidence-bundle / actor-shaping helpers stay in
 * `packages/api/src/services/audit.ts`, which re-exports everything here so its
 * existing importers are unaffected.
 *
 * Every audit event extends a per-tenant HMAC chain. Each row's `hmac` commits
 * to `prev_hash || canonical_json(event)` keyed by STEWARD_AUDIT_HMAC_KEY.
 * Mutating any historical row breaks verification of every subsequent row.
 *
 * Concurrency: writers serialize chain extensions per tenant with
 * `pg_advisory_xact_lock` (real Postgres) or the in-process per-tenant queue
 * (PGLite). Cross-tenant writes do not contend.
 */

import { createHmac } from "node:crypto";
import { logger } from "@elizaos/logger";
import { sql } from "drizzle-orm";
import { observeSecurityAuditEvent } from "../../shared/src/index.ts";
import { DatabaseDeadlineExceededError, getDb } from "./client";

const ZERO_HASH = new Uint8Array(32);

function isPGLiteRuntime(): boolean {
  return (
    process.env.STEWARD_DB_MODE === "pglite" ||
    process.env.STEWARD_PGLITE_MEMORY === "true"
  );
}

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

// ─── Webhook / secret redaction (moved from api; pure, no deps) ────────────────

const SENSITIVE_WEBHOOK_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "claimtoken",
  "claimtokenhash",
  "credentialsecret",
  "clientsecret",
  "idtoken",
  "jwt",
  "mnemonic",
  "password",
  "privatekey",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "seedphrase",
  "signersecret",
]);

const SENSITIVE_WEBHOOK_KEY_SUFFIXES = [
  "accesstoken",
  "apikey",
  "bearertoken",
  "claimtoken",
  "claimtokenhash",
  "clientsecret",
  "credentialsecret",
  "idtoken",
  "mnemonic",
  "privatekey",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "seedphrase",
  "sessiontoken",
  "signersecret",
  "tokenhash",
];

function normalizeWebhookKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveWebhookKey(key: string): boolean {
  const normalized = normalizeWebhookKey(key);
  return (
    SENSITIVE_WEBHOOK_KEYS.has(normalized) ||
    SENSITIVE_WEBHOOK_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/**
 * Recursively replace values under sensitive keys with `[REDACTED]`. Used to
 * scrub audit-event metadata before it is canonicalized/persisted.
 */
export function redactWebhookSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactWebhookSecrets(item)) as T;
  }
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    redacted[key] = isSensitiveWebhookKey(key)
      ? "[REDACTED]"
      : redactWebhookSecrets(nestedValue);
  }
  return redacted as T;
}

// ─── HMAC key ─────────────────────────────────────────────────────────────────

// Minimum entropy for the audit HMAC key: 32 bytes. Hex-encoded keys must be
// >= 64 hex chars (= 32 bytes); raw/passphrase keys must be >= 32 chars.
const MIN_HMAC_RAW_BYTES = 32;

let warnedDevFallback = false;
let cachedKey: Uint8Array | null = null;

/** @internal test hook: forget the memoized HMAC key so env changes take effect. */
export function __resetAuditHmacKeyCacheForTests(): void {
  cachedKey = null;
  warnedDevFallback = false;
}

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
      "[Login:audit-chain] warn",
    );
  }
  cachedKey = new TextEncoder().encode(
    "dev-audit-hmac-key-do-not-use-in-production-aaaaaaaaaaaaaaaaaaaaaaaa",
  );
  return cachedKey;
}

export type ActorType = "user" | "agent" | "platform" | "system" | "api-key";

export interface AuditEventInput {
  tenantId: string;
  actorType: ActorType;
  actorId?: string | null;
  /** Dotted action name, e.g. "vault.sign", "auth.login", "policy.update". */
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
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

function isAuditSequenceConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? (err as { code?: unknown }).code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  // Serialization failures (SQLSTATE 40001) are always transient — retry.
  if (code === "40001" || message.includes("could not serialize access"))
    return true;
  // Unique violations (23505) are retried ONLY when they name the per-tenant
  // seq index — i.e. an actual audit-chain seq race. SEC-167: matching the
  // bare 23505 code / generic duplicate-key text retried ANY unique violation
  // raised inside withTenantAuditedTransaction's fn (e.g. a genuine conflict
  // in the caller's own mutations) 5 times — wasted work, and it leaned on
  // every caller's retry-idempotency contract for no reason.
  const constraint =
    "constraint_name" in err
      ? (err as { constraint_name?: unknown }).constraint_name
      : "constraint" in err
        ? (err as { constraint?: unknown }).constraint
        : undefined;
  if (constraint === "audit_events_tenant_seq_idx") return true;
  return message.includes("audit_events_tenant_seq_idx");
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

const tenantAuditQueues = new Map<string, Promise<void>>();

/**
 * Serialize `fn` per tenant in-process. This is the PGLite chain-serialization
 * guarantee and also gates the real-Postgres advisory-lock acquisition so
 * concurrent appends within one process cannot interleave the seq read/insert.
 */
export async function withTenantAuditQueue<T>(
  tenantId: string,
  fn: () => Promise<T>,
  deadlineAt?: number,
): Promise<T> {
  const prior = tenantAuditQueues.get(tenantId) ?? Promise.resolve();
  let cancelled = false;
  let started = false;
  const run = prior
    .catch(() => undefined)
    .then(() => {
      if (cancelled || (deadlineAt !== undefined && Date.now() >= deadlineAt)) {
        throw new DatabaseDeadlineExceededError();
      }
      started = true;
      return fn();
    });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tenantAuditQueues.set(tenantId, tail);
  void tail.then(() => {
    if (tenantAuditQueues.get(tenantId) === tail) {
      tenantAuditQueues.delete(tenantId);
    }
  });
  if (deadlineAt === undefined) return run;

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    cancelled = true;
    throw new DatabaseDeadlineExceededError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waitingDeadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Once fn has begun, its driver owns cancellation and rollback. Rejecting
      // here would abandon an in-flight mutation and let it complete after the
      // caller regained control.
      if (started) return;
      cancelled = true;
      reject(new DatabaseDeadlineExceededError());
    }, remainingMs);
  });
  try {
    return await Promise.race([run, waitingDeadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Minimal transaction handle the audit writer needs. Both Drizzle transaction
 * objects (postgres-js / neon-http / PGLite) and the top-level db satisfy this,
 * so the same append core works standalone or joined to a caller's tx.
 */
export type AuditTxLike = { execute: (query: unknown) => Promise<unknown> };

/**
 * Extend the tenant's audit chain using an EXISTING transaction. The head read,
 * event insert, and chain-head high-water-mark update all execute against `tx`,
 * so they commit or roll back atomically with whatever else the caller did in
 * the same transaction. This is the primitive that lets a state transition and
 * its required audit event be both-or-neither (spec I14, evidence before
 * visibility).
 *
 * Callers MUST hold the per-tenant advisory lock (real Postgres) or the
 * per-tenant in-process queue (PGLite) for the duration of `tx` so concurrent
 * appends cannot interleave the seq read/insert. `withTenantAuditedTransaction`
 * arranges both; do not call this directly outside that helper.
 */
export async function appendAuditEventWithinTx(
  tx: AuditTxLike,
  ev: AuditEventInput,
): Promise<void> {
  const key = getHmacKey();

  const headRows = rowsFromExecute<{ seq: number | string; hmac: unknown }>(
    await tx.execute(
      sql`SELECT seq, hmac FROM audit_events WHERE tenant_id = ${ev.tenantId} ORDER BY seq DESC LIMIT 1`,
    ),
  );
  const head = headRows[0];
  const seq = head ? Number(head.seq) + 1 : 1;
  const prevHash = head ? toU8(head.hmac) : ZERO_HASH;

  const createdAt = new Date();
  // postgres-js does not auto-stringify Date objects in raw sql template
  // params. Convert to ISO and cast on the SQL side instead. See dcf772e.
  const createdAtIso = createdAt.toISOString();
  // SEC-089: normalize metadata through the SAME canonicalization that feeds
  // the HMAC preimage. canonicalJsonValue maps undefined → null (key kept)
  // while JSON.stringify drops undefined-valued keys, so persisting the
  // un-normalized form stored a row that could never re-canonicalize to its
  // written HMAC — verification failed from that seq onward, indistinguishable
  // from tampering. Persisting the canonicalized form makes HMAC and INSERT
  // commit to identical bytes.
  const metadata = canonicalJsonValue(
    redactWebhookSecrets(ev.metadata ?? {}),
  ) as Record<string, unknown>;
  const canonical = canonicalize({
    tenant_id: ev.tenantId,
    seq,
    actor_type: ev.actorType,
    actor_id: ev.actorId ?? null,
    action: ev.action,
    resource_type: ev.resourceType ?? null,
    resource_id: ev.resourceId ?? null,
    metadata,
    ip_address: ev.ipAddress ?? null,
    user_agent: ev.userAgent ?? null,
    request_id: ev.requestId ?? null,
    created_at: createdAt.toISOString(),
  });

  const hmac = computeHmac(key, prevHash, canonical);

  await tx.execute(sql`
    INSERT INTO audit_events
      (tenant_id, seq, prev_hash, hmac, actor_type, actor_id, action,
       resource_type, resource_id, metadata, ip_address, user_agent,
       request_id, created_at)
    VALUES
      (${ev.tenantId}, ${seq}, ${prevHash}, ${hmac}, ${ev.actorType},
       ${ev.actorId ?? null}, ${ev.action}, ${ev.resourceType ?? null},
       ${ev.resourceId ?? null}, ${JSON.stringify(metadata)}::jsonb,
       ${ev.ipAddress ?? null}, ${ev.userAgent ?? null},
       ${ev.requestId ?? null}, ${createdAtIso}::timestamptz)
  `);

  // Advance the out-of-band high-water-mark in the SAME transaction so an
  // attacker with DB-only write access who later deletes the tail/whole
  // chain cannot also roll this back without breaking verification.
  // expected_count increments by 1 per appended row (independent of any
  // archived floor); head_hmac/expected_seq track the newest row.
  await tx.execute(sql`
    INSERT INTO audit_chain_heads (tenant_id, expected_seq, expected_count, head_hmac, updated_at)
    VALUES (${ev.tenantId}, ${seq}, 1, ${hmac}, now())
    ON CONFLICT (tenant_id) DO UPDATE
      SET expected_seq = ${seq},
          expected_count = audit_chain_heads.expected_count + 1,
          head_hmac = ${hmac},
          updated_at = now()
  `);
}

/**
 * Append the event on its own transaction (standalone chain extension). Throws
 * on failure. Serialization / seq conflicts retry the whole append.
 */
export async function appendAuditEvent(ev: AuditEventInput): Promise<void> {
  const db = getDb();

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.transaction(async (tx) => {
        if (!isPGLiteRuntime()) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`steward_audit_${ev.tenantId}`}, 0))`,
          );
        }
        // PGLite (embedded, single-process) does not implement
        // pg_advisory_xact_lock. The guarantee still holds there: all writers
        // share one process, serialized per tenant by withTenantAuditQueue, and
        // the audit_events_tenant_seq_idx UNIQUE index + the conflict-retry loop
        // below catches any residual seq race. So the advisory lock is a no-op
        // we can safely skip in embedded mode.
        await appendAuditEventWithinTx(tx as AuditTxLike, ev);
      });
      // Metrics are deliberately post-commit and best-effort. They cannot roll
      // back or otherwise affect the audited authority transition.
      try {
        observeSecurityAuditEvent(ev.action, ev.metadata);
      } catch {
        // Monitoring must never become part of the security decision path.
      }
      return;
    } catch (err) {
      if (attempt < 4 && isAuditSequenceConflict(err)) {
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Append an event to the tenant's audit chain. Throws on failure — callers
 * MUST treat audit-write failure as an action failure for sensitive
 * operations (auth, signing, policy mutations).
 */
export async function writeAuditEvent(ev: AuditEventInput): Promise<void> {
  return withTenantAuditQueue(ev.tenantId, () => appendAuditEvent(ev));
}

/**
 * Callback signature handed to `withTenantAuditedTransaction`. Appending a
 * required audit event uses the SAME transaction as the caller's row mutations,
 * so the state change and its audit record are atomic.
 */
export type AppendRequiredAudit = (event: AuditEventInput) => Promise<void>;

/**
 * Run `fn` inside one tenant-audited transaction. The state mutations the caller
 * performs on `tx` and every `appendRequiredAudit(...)` event commit or roll
 * back together, closing the non-atomic "mutate then audit in a separate
 * transaction" gap (spec section 7.1 / invariant I14).
 *
 * Guarantees:
 *  - one `db.transaction` wraps the whole unit of work;
 *  - the per-tenant advisory lock (real Postgres) is acquired before any audit
 *    read, matching `writeAuditEvent`'s chain-serialization contract;
 *  - PGLite runs are serialized per tenant in-process (advisory lock is a no-op
 *    there, exactly as in `appendAuditEvent`);
 *  - serialization / seq conflicts retry the WHOLE unit of work before it is
 *    known committed, so a retried transition never double-applies or duplicates
 *    an audit row (the mutations use guarded `WHERE status = ...` predicates and
 *    are idempotent on retry).
 *
 * The caller must not open a nested transaction inside `fn`; use the provided
 * `tx`. The caller must not call `writeAuditEvent` inside `fn` (that would open
 * a second transaction and deadlock on the advisory lock); use
 * `appendRequiredAudit` instead.
 */
export async function withTenantAuditedTransaction<T>(
  tenantId: string,
  fn: (tx: unknown, appendRequiredAudit: AppendRequiredAudit) => Promise<T>,
): Promise<T> {
  const db = getDb();

  return withTenantAuditedTransactionOnDb(db, tenantId, fn);
}

/** Deadline-aware form used by bounded credential-lease lifecycles. The
 * supplied handle is dedicated to that lifecycle, so all reads and audited
 * mutations share one driver cancellation boundary. */
export async function withTenantAuditedTransactionOnDb<T>(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  fn: (tx: unknown, appendRequiredAudit: AppendRequiredAudit) => Promise<T>,
  deadlineAt?: number,
): Promise<T> {
  const assertRemaining = () => {
    if (deadlineAt !== undefined && deadlineAt - Date.now() < 1_000) {
      throw new Error("database operation deadline exceeded");
    }
  };

  const execute = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        assertRemaining();
        const committedEvents: AuditEventInput[] = [];
        const result = await db.transaction(async (tx) => {
          if (!isPGLiteRuntime()) {
            if (deadlineAt !== undefined) {
              const remaining = Math.max(1, deadlineAt - Date.now());
              await tx.execute(
                sql.raw(`SET LOCAL statement_timeout = '${remaining}ms'`),
              );
              await tx.execute(
                sql.raw(`SET LOCAL lock_timeout = '${remaining}ms'`),
              );
              await tx.execute(
                sql.raw(
                  `SET LOCAL idle_in_transaction_session_timeout = '${remaining}ms'`,
                ),
              );
            }
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`steward_audit_${tenantId}`}, 0))`,
            );
          }
          const appendRequiredAudit: AppendRequiredAudit = async (event) => {
            if (event.tenantId !== tenantId) {
              throw new Error(
                "withTenantAuditedTransaction: audit event tenant does not match transaction tenant",
              );
            }
            await appendAuditEventWithinTx(tx as AuditTxLike, event);
            committedEvents.push(event);
          };
          return await fn(tx, appendRequiredAudit);
        });
        for (const event of committedEvents) {
          try {
            observeSecurityAuditEvent(event.action, event.metadata);
          } catch {
            // Monitoring must never become part of the security decision path.
          }
        }
        return result;
      } catch (err) {
        if (attempt < 4 && isAuditSequenceConflict(err)) {
          assertRemaining();
          await new Promise((resolve) =>
            setTimeout(resolve, 5 * (attempt + 1)),
          );
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new Error("withTenantAuditedTransaction: exhausted retries");
  };

  return withTenantAuditQueue(tenantId, execute, deadlineAt);
}
