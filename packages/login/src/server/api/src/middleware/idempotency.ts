import { logger } from "@elizaos/logger";
import { createMiddleware } from "hono/factory";
import { redactedThrownDiagnostics } from "../../../shared/src/index.ts";
import type { ApiResponse, AppVariables } from "../services/context";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import { getRedisClient } from "./redis";

type IdempotencyStatus = "processing" | "completed";

type IdempotencyEntry = {
  fingerprint: string;
  status: IdempotencyStatus;
  createdAt: number;
  expiresAt: number;
  response?: {
    status: number;
    headers: [string, string][];
    body: ArrayBuffer;
  };
};

export type IdempotencyMetricCounters = {
  observed: number;
  reserved: number;
  completed: number;
  replayed: number;
  conflicts: number;
  inFlightConflicts: number;
  suppressedAuthResponses: number;
  invalidKeys: number;
  storeErrors: number;
  skippedUnsafeContext: number;
  releasedOnError: number;
};

export type TenantIdempotencyMetricsSnapshot = {
  tenantId: string;
  generatedAt: string;
  windowStartedAt: string;
  lastSeenAt: string | null;
  ttlMs: number;
  counters: IdempotencyMetricCounters;
};

export type IdempotencyStore = {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  reserve?(
    key: string,
    entry: Omit<IdempotencyEntry, "status" | "response">,
  ): Promise<IdempotencyEntry | undefined>;
  setProcessing(
    key: string,
    entry: Omit<IdempotencyEntry, "status" | "response">,
  ): Promise<void>;
  setCompleted(
    key: string,
    response?: NonNullable<IdempotencyEntry["response"]>,
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_METRIC_TENANTS = 500;
const DEFAULT_METRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{8,255}$/;
const PUBLIC_AUTH_IDEMPOTENCY_PATHS = new Set([
  "/auth/sso/discover",
  "/auth/telegram/challenge",
  "/auth/telegram/verify",
  "/auth/farcaster/verify",
  "/auth/jwt/login",
  "/auth/test/token",
  "/auth/sms/send",
  "/auth/sms/verify",
  "/auth/whatsapp/send",
  "/auth/whatsapp/verify",
  "/auth/verify",
  "/auth/verify/solana",
  "/auth/refresh",
  "/auth/revoke",
  "/auth/logout",
  "/auth/passkey/login/options",
  "/auth/passkey/login/verify",
  "/auth/email/send",
  "/auth/email/verify",
  "/auth/oauth/exchange",
]);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function emptyIdempotencyCounters(): IdempotencyMetricCounters {
  return {
    observed: 0,
    reserved: 0,
    completed: 0,
    replayed: 0,
    conflicts: 0,
    inFlightConflicts: 0,
    suppressedAuthResponses: 0,
    invalidKeys: 0,
    storeErrors: 0,
    skippedUnsafeContext: 0,
    releasedOnError: 0,
  };
}

const IDEMPOTENCY_COUNTER_KEYS = Object.keys(
  emptyIdempotencyCounters(),
) as Array<keyof IdempotencyMetricCounters>;

type IdempotencyMetricBucket = {
  windowStartedAt: number;
  lastSeenAt: number | null;
  counters: IdempotencyMetricCounters;
};

const idempotencyMetricBuckets = new Map<string, IdempotencyMetricBucket>();

function metricsRedisKey(tenantId: string): string {
  return `idempotency:metrics:${encodeURIComponent(tenantId)}`;
}

function metricsTtlSeconds(): number {
  const ttlMs = parsePositiveInt(
    process.env.STEWARD_IDEMPOTENCY_METRICS_TTL_MS,
    DEFAULT_METRICS_TTL_MS,
  );
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

function tenantIdFromPath(pathname: string): string | null {
  const match = /^\/tenants\/([^/]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function metricTenantId(c: {
  get: (key: keyof AppVariables) => unknown;
  req: { path: string; header: (name: string) => string | undefined };
}) {
  const tenantId = c.get("tenantId");
  if (typeof tenantId === "string" && tenantId.trim()) return tenantId.trim();
  const tenantHeader = c.req.header("X-Steward-Tenant");
  if (typeof tenantHeader === "string" && tenantHeader.trim())
    return tenantHeader.trim();
  return tenantIdFromPath(c.req.path) ?? "unknown";
}

function recordIdempotencyMetric(
  tenantId: string,
  counter: keyof IdempotencyMetricCounters,
  now = Date.now(),
) {
  let bucket = idempotencyMetricBuckets.get(tenantId);
  if (!bucket) {
    if (idempotencyMetricBuckets.size >= MAX_METRIC_TENANTS) {
      const oldest = idempotencyMetricBuckets.keys().next().value;
      if (oldest) idempotencyMetricBuckets.delete(oldest);
    }
    bucket = {
      windowStartedAt: now,
      lastSeenAt: null,
      counters: emptyIdempotencyCounters(),
    };
    idempotencyMetricBuckets.set(tenantId, bucket);
  }
  bucket.counters[counter] += 1;
  bucket.lastSeenAt = now;
  void recordIdempotencyMetricInRedis(tenantId, counter, now);
}

async function recordIdempotencyMetricInRedis(
  tenantId: string,
  counter: keyof IdempotencyMetricCounters,
  now: number,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const key = metricsRedisKey(tenantId);
  try {
    const existingWindow = await redis.hget(key, "windowStartedAt");
    const pipeline = redis.multi();
    if (!existingWindow) pipeline.hset(key, "windowStartedAt", String(now));
    pipeline.hset(key, "lastSeenAt", String(now));
    pipeline.hincrby(key, counter, 1);
    pipeline.expire(key, metricsTtlSeconds());
    await pipeline.exec();
  } catch (error) {
    logger.error(
      {
        details: [
          "[steward:idempotency] Failed to record Redis idempotency metrics",
          redactedThrownDiagnostics(error),
        ],
      },
      "[Login:idempotency] error",
    );
  }
}

function snapshotFromBucket(
  tenantId: string,
  bucket: IdempotencyMetricBucket | undefined,
  ttlMs: number,
  now: number,
): TenantIdempotencyMetricsSnapshot {
  return {
    tenantId,
    generatedAt: new Date(now).toISOString(),
    windowStartedAt: new Date(bucket?.windowStartedAt ?? now).toISOString(),
    lastSeenAt: bucket?.lastSeenAt
      ? new Date(bucket.lastSeenAt).toISOString()
      : null,
    ttlMs,
    counters: { ...(bucket?.counters ?? emptyIdempotencyCounters()) },
  };
}

async function snapshotFromRedis(
  tenantId: string,
  ttlMs: number,
  now: number,
): Promise<TenantIdempotencyMetricsSnapshot | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  const fields = await redis.hgetall(metricsRedisKey(tenantId));
  if (!fields || Object.keys(fields).length === 0) return null;

  const counters = emptyIdempotencyCounters();
  for (const counter of IDEMPOTENCY_COUNTER_KEYS) {
    const value = Number(fields[counter]);
    counters[counter] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  const windowStartedAt = Number(fields.windowStartedAt);
  const lastSeenAt = Number(fields.lastSeenAt);
  return {
    tenantId,
    generatedAt: new Date(now).toISOString(),
    windowStartedAt: new Date(
      Number.isFinite(windowStartedAt) && windowStartedAt > 0
        ? windowStartedAt
        : now,
    ).toISOString(),
    lastSeenAt:
      Number.isFinite(lastSeenAt) && lastSeenAt > 0
        ? new Date(lastSeenAt).toISOString()
        : null,
    ttlMs,
    counters,
  };
}

export async function getTenantIdempotencyMetrics(
  tenantId: string,
  ttlMs = parsePositiveInt(
    process.env.STEWARD_IDEMPOTENCY_TTL_MS,
    DEFAULT_TTL_MS,
  ),
): Promise<TenantIdempotencyMetricsSnapshot> {
  const bucket = idempotencyMetricBuckets.get(tenantId);
  const now = Date.now();
  return (
    (await snapshotFromRedis(tenantId, ttlMs, now)) ??
    snapshotFromBucket(tenantId, bucket, ttlMs, now)
  );
}

export function resetIdempotencyMetricsForTests(): void {
  idempotencyMetricBuckets.clear();
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function responseHeadersForReplay(headers: Headers): [string, string][] {
  const pairs: [string, string][] = [];
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "set-cookie" ||
      lower === "content-encoding" ||
      lower === "content-length"
    ) {
      return;
    }
    pairs.push([key, value]);
  });
  return pairs;
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

type SerializedIdempotencyEntry = Omit<IdempotencyEntry, "response"> & {
  response?: Omit<NonNullable<IdempotencyEntry["response"]>, "body"> & {
    bodyBase64: string;
  };
};

function serializeEntry(entry: IdempotencyEntry): string {
  const serialized: SerializedIdempotencyEntry = {
    fingerprint: entry.fingerprint,
    status: entry.status,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    response: entry.response
      ? {
          status: entry.response.status,
          headers: entry.response.headers,
          bodyBase64: bytesToBase64(entry.response.body),
        }
      : undefined,
  };
  return JSON.stringify(serialized);
}

function parseEntry(value: string | null): IdempotencyEntry | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as SerializedIdempotencyEntry;
  if (
    typeof parsed.fingerprint !== "string" ||
    (parsed.status !== "processing" && parsed.status !== "completed") ||
    typeof parsed.createdAt !== "number" ||
    typeof parsed.expiresAt !== "number"
  ) {
    return undefined;
  }
  return {
    fingerprint: parsed.fingerprint,
    status: parsed.status,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    response: parsed.response
      ? {
          status: parsed.response.status,
          headers: parsed.response.headers,
          body: base64ToBytes(parsed.response.bodyBase64),
        }
      : undefined,
  };
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async setProcessing(
    key: string,
    entry: Omit<IdempotencyEntry, "status" | "response">,
  ): Promise<void> {
    await this.reserve(key, entry);
  }

  async reserve(
    key: string,
    entry: Omit<IdempotencyEntry, "status" | "response">,
  ): Promise<IdempotencyEntry | undefined> {
    this.collectExpired();
    const existing = this.entries.get(key);
    if (existing) return existing;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { ...entry, status: "processing" });
    return undefined;
  }

  async setCompleted(
    key: string,
    response?: NonNullable<IdempotencyEntry["response"]>,
  ): Promise<void> {
    const entry = await this.get(key);
    if (!entry) return;
    this.entries.set(key, { ...entry, status: "completed", response });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private collectExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly fallback = new MemoryIdempotencyStore(
    parsePositiveInt(
      process.env.STEWARD_IDEMPOTENCY_MAX_ENTRIES,
      DEFAULT_MAX_ENTRIES,
    ),
  );

  private client() {
    const redis = getRedisClient();
    if (redis) return redis;
    if (process.env.NODE_ENV !== "production") return null;
    throw new Error("Durable idempotency store unavailable");
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const redis = this.client();
    if (!redis) return this.fallback.get(key);
    return parseEntry(await redis.get(`idempotency:${key}`));
  }

  async setProcessing(
    key: string,
    entry: Omit<IdempotencyEntry, "status" | "response">,
  ): Promise<void> {
    await this.reserve(key, entry);
  }

  async reserve(
    key: string,
    entry: Omit<IdempotencyEntry, "status" | "response">,
  ): Promise<IdempotencyEntry | undefined> {
    const redis = this.client();
    if (!redis) return this.fallback.reserve(key, entry);
    const redisKey = `idempotency:${key}`;
    const value = serializeEntry({ ...entry, status: "processing" });
    const ttlMs = Math.max(1, entry.expiresAt - Date.now());
    const reserved = await redis.set(redisKey, value, "PX", ttlMs, "NX");
    if (reserved) return undefined;
    return this.get(key);
  }

  async setCompleted(
    key: string,
    response?: NonNullable<IdempotencyEntry["response"]>,
  ): Promise<void> {
    const redis = this.client();
    if (!redis) return this.fallback.setCompleted(key, response);
    const existing = await this.get(key);
    if (!existing) return;
    const ttlMs = Math.max(1, existing.expiresAt - Date.now());
    await redis.set(
      `idempotency:${key}`,
      serializeEntry({ ...existing, status: "completed", response }),
      "PX",
      ttlMs,
    );
  }

  async delete(key: string): Promise<void> {
    const redis = this.client();
    if (!redis) return this.fallback.delete(key);
    await redis.del(`idempotency:${key}`);
  }
}

export const defaultIdempotencyStore = new RedisIdempotencyStore();

async function buildFingerprint(request: Request): Promise<string> {
  const url = new URL(request.url);
  const body = await request.clone().arrayBuffer();
  const bodyHash = await sha256Hex(body);
  const authHash = await sha256Hex(request.headers.get("authorization") ?? "");
  const apiKeyHash = await sha256Hex(
    request.headers.get("x-steward-key") ?? "",
  );
  const signerIdHash = await sha256Hex(
    request.headers.get("x-steward-signer-id") ?? "",
  );
  const signerSecretHash = await sha256Hex(
    request.headers.get("x-steward-signer-secret") ?? "",
  );
  const quorumIdHash = await sha256Hex(
    request.headers.get("x-steward-key-quorum-id") ?? "",
  );
  const quorumCredentialsHash = await sha256Hex(
    request.headers.get("x-steward-key-quorum-credentials") ?? "",
  );
  const tenant = request.headers.get("x-steward-tenant") ?? "";
  return [
    request.method.toUpperCase(),
    url.pathname,
    url.search,
    tenant,
    authHash,
    apiKeyHash,
    signerIdHash,
    signerSecretHash,
    quorumIdHash,
    quorumCredentialsHash,
    bodyHash,
  ].join("\n");
}

async function buildStorageKey(request: Request, key: string): Promise<string> {
  const url = new URL(request.url);
  const tenant = request.headers.get("x-steward-tenant") ?? "";
  const appId = request.headers.get("x-steward-app-id") ?? "";
  const origin = request.headers.get("origin") ?? "";
  const authHash = await sha256Hex(request.headers.get("authorization") ?? "");
  const apiKeyHash = await sha256Hex(
    request.headers.get("x-steward-key") ?? "",
  );
  const platformKeyHash = await sha256Hex(
    request.headers.get("x-steward-platform-key") ?? "",
  );
  const signerIdHash = await sha256Hex(
    request.headers.get("x-steward-signer-id") ?? "",
  );
  const signerSecretHash = await sha256Hex(
    request.headers.get("x-steward-signer-secret") ?? "",
  );
  const quorumIdHash = await sha256Hex(
    request.headers.get("x-steward-key-quorum-id") ?? "",
  );
  const quorumCredentialsHash = await sha256Hex(
    request.headers.get("x-steward-key-quorum-credentials") ?? "",
  );
  const hasCredentialScope = Boolean(
    request.headers.get("authorization") ||
      request.headers.get("x-steward-key") ||
      request.headers.get("x-steward-platform-key") ||
      request.headers.get("x-steward-signer-id") ||
      request.headers.get("x-steward-signer-secret") ||
      request.headers.get("x-steward-key-quorum-id") ||
      request.headers.get("x-steward-key-quorum-credentials"),
  );
  return sha256Hex(
    [
      hasCredentialScope ? "" : "public-auth",
      hasCredentialScope ? "" : request.method.toUpperCase(),
      hasCredentialScope ? "" : url.pathname,
      hasCredentialScope ? "" : url.search,
      hasCredentialScope ? "" : origin,
      hasCredentialScope ? "" : appId,
      tenant,
      authHash,
      apiKeyHash,
      platformKeyHash,
      signerIdHash,
      signerSecretHash,
      quorumIdHash,
      quorumCredentialsHash,
      key,
    ].join("\n"),
  );
}

function replayResponse(entry: IdempotencyEntry): Response {
  if (!entry.response) {
    return Response.json(
      { ok: false, error: "Idempotency key has already been used" },
      {
        status: 409,
        headers: { "Retry-After": "1" },
      },
    );
  }

  const headers = new Headers(entry.response.headers);
  headers.set("Idempotency-Replayed", "true");
  return new Response(entry.response.body.slice(0), {
    status: entry.response.status,
    headers,
  });
}

function hasIdempotencyAuthMaterial(
  request: Request,
  signatureVerified: boolean,
): boolean {
  return Boolean(
    request.headers.get("authorization") ||
      request.headers.get("x-steward-key") ||
      request.headers.get("x-steward-platform-key") ||
      (signatureVerified && request.headers.get("x-steward-signature")),
  );
}

function isPublicAuthIdempotencyPath(pathname: string): boolean {
  return (
    PUBLIC_AUTH_IDEMPOTENCY_PATHS.has(pathname) ||
    /^\/auth\/oauth\/[^/]+\/token$/.test(pathname) ||
    /^\/auth\/saml\/[^/]+\/acs$/.test(pathname)
  );
}

function isAuthTokenResponseReplaySuppressedPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

// SEC-070: secret-bearing mutating routes must never have their response
// bodies persisted to the idempotency store (Redis or memory, up to 24h).
// The reservation itself is still recorded (409-on-reuse semantics are
// preserved); the completed body is suppressed exactly like /auth token
// responses. Named per the audit: wallet export key material, KMS decrypt
// plaintext, and the /secrets value plane.
const SECRET_BEARING_RESPONSE_PATTERNS = [
  /^\/vault\/[^/]+\/export$/, // POST /vault/:agentId/export — wallet key material
  /^\/user\/me\/wallet\/export$/, // POST /user/me/wallet/export — user wallet key material
  /^\/v1\/kms\/keys\/[^/]+\/decrypt$/, // POST /v1/kms/keys/:keyId/decrypt — plaintext
  /^\/secrets(?:\/|$)/, // POST /secrets — secret values
  /^\/(?:v1\/)?capabilities\/manifest\/[^/]+\/(?:issue|renew)\/?$/, // POST …/issue|renew — one-time upstream credential
  // Review-wave extension of the audit's named list (same issue class):
  // recovery setup returns the one-time BIP39 mnemonic ("shown once, not
  // stored"), so its body must never land in the idempotency store either.
  /^\/user\/me\/wallet\/recovery\/setup$/, // POST …/recovery/setup — one-time BIP39 mnemonic
];

function isSecretBearingResponseReplaySuppressedPath(
  pathname: string,
): boolean {
  return SECRET_BEARING_RESPONSE_PATTERNS.some((pattern) =>
    pattern.test(pathname),
  );
}

function hasReplaySafeAuthenticatedContext(c: {
  get: (key: keyof AppVariables) => unknown;
}) {
  if (c.get("requestSignatureVerified")) return true;
  const authType = c.get("authType");
  if (
    authType === "api-key" ||
    authType === "agent-token" ||
    c.get("platformKeyHash")
  ) {
    return true;
  }
  if (authType !== "session-jwt") return false;
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), 5 * 60_000);
}

function hasReplaySafePublicContext(c: { req: { path: string } }) {
  return isPublicAuthIdempotencyPath(c.req.path);
}

export function idempotencyMiddleware(options?: {
  store?: IdempotencyStore;
  ttlMs?: number;
}) {
  const store = options?.store ?? defaultIdempotencyStore;
  const ttlMs =
    options?.ttlMs ??
    parsePositiveInt(process.env.STEWARD_IDEMPOTENCY_TTL_MS, DEFAULT_TTL_MS);

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) return next();

    const key = c.req.header("Idempotency-Key");
    if (!key) return next();
    const metricsTenantId = metricTenantId(c);
    recordIdempotencyMetric(metricsTenantId, "observed");
    const hasAuthMaterial = hasIdempotencyAuthMaterial(
      c.req.raw,
      Boolean(c.get("requestSignatureVerified")),
    );
    if (hasAuthMaterial) {
      if (!hasReplaySafeAuthenticatedContext(c)) {
        recordIdempotencyMetric(metricsTenantId, "skippedUnsafeContext");
        return next();
      }
    } else if (!hasReplaySafePublicContext(c)) {
      recordIdempotencyMetric(metricsTenantId, "skippedUnsafeContext");
      return next();
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      recordIdempotencyMetric(metricsTenantId, "invalidKeys");
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid Idempotency-Key header" },
        400,
      );
    }
    // Solana broadcast requests bind this key to their durable transaction row.
    // Let that database state machine serve every auth mode consistently,
    // including recovery after a process dies while this cache says processing.
    if (/^\/vault\/[^/]+\/sign-solana$/.test(c.req.path)) {
      const body = await c.req.raw
        .clone()
        .json()
        .catch(() => null);
      if (
        body &&
        typeof body === "object" &&
        (body as { broadcast?: unknown }).broadcast !== false
      ) {
        return next();
      }
    }

    const [fingerprint, storageKey] = await Promise.all([
      buildFingerprint(c.req.raw),
      buildStorageKey(c.req.raw, key),
    ]);
    const reservation = {
      fingerprint,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    let existing: IdempotencyEntry | undefined;
    try {
      existing = store.reserve
        ? await store.reserve(storageKey, reservation)
        : await (async () => {
            const current = await store.get(storageKey);
            if (!current) await store.setProcessing(storageKey, reservation);
            return current;
          })();
    } catch {
      recordIdempotencyMetric(metricsTenantId, "storeErrors");
      return c.json<ApiResponse>(
        { ok: false, error: "Durable idempotency store unavailable" },
        503,
      );
    }
    if (existing) {
      if (!timingSafeEqualString(existing.fingerprint, fingerprint)) {
        recordIdempotencyMetric(metricsTenantId, "conflicts");
        return c.json<ApiResponse>(
          {
            ok: false,
            error: "Idempotency-Key was already used for a different request",
          },
          409,
        );
      }
      if (existing.status === "completed") {
        recordIdempotencyMetric(
          metricsTenantId,
          existing.response ? "replayed" : "suppressedAuthResponses",
        );
        return replayResponse(existing);
      }
      recordIdempotencyMetric(metricsTenantId, "inFlightConflicts");
      return c.json<ApiResponse>(
        { ok: false, error: "Idempotency key is already processing" },
        409,
        { "Retry-After": "1" },
      );
    }
    recordIdempotencyMetric(metricsTenantId, "reserved");

    try {
      await next();
      // Never cache transient server errors (5xx). A handler that *returns* a
      // 500/502/503 as a normal Response is a retryable outcome, not a settled
      // one — caching it as "completed" for the full TTL would replay the error
      // and poison every legitimate retry of this Idempotency-Key. Release the
      // reservation so a retry re-executes the handler.
      if (c.res.status >= 500) {
        try {
          await store.delete(storageKey);
          recordIdempotencyMetric(metricsTenantId, "releasedOnError");
        } catch {
          recordIdempotencyMetric(metricsTenantId, "storeErrors");
          logger.error(
            {
              details: [
                "[steward:idempotency] Failed to release reservation after 5xx",
              ],
            },
            "[Login:idempotency] error",
          );
        }
        c.header("Idempotency-Replayed", "false");
        return;
      }
      try {
        if (
          isAuthTokenResponseReplaySuppressedPath(c.req.path) ||
          isSecretBearingResponseReplaySuppressedPath(c.req.path)
        ) {
          await store.setCompleted(storageKey);
          recordIdempotencyMetric(metricsTenantId, "suppressedAuthResponses");
        } else {
          const response = c.res.clone();
          await store.setCompleted(storageKey, {
            status: response.status,
            headers: responseHeadersForReplay(response.headers),
            body: await response.arrayBuffer(),
          });
        }
        recordIdempotencyMetric(metricsTenantId, "completed");
      } catch {
        recordIdempotencyMetric(metricsTenantId, "storeErrors");
        logger.error(
          {
            details: [
              "[steward:idempotency] Failed to persist completed response",
            ],
          },
          "[Login:idempotency] error",
        );
      }
      c.header("Idempotency-Replayed", "false");
    } catch (error) {
      try {
        await store.delete(storageKey);
        recordIdempotencyMetric(metricsTenantId, "releasedOnError");
      } catch {
        recordIdempotencyMetric(metricsTenantId, "storeErrors");
        logger.error(
          {
            details: [
              "[steward:idempotency] Failed to release idempotency reservation",
            ],
          },
          "[Login:idempotency] error",
        );
      }
      throw error;
    }
  });
}
