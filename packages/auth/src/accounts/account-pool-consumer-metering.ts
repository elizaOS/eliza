/**
 * Consumer-key auth and usage metering for the account-pool broker boundary.
 * The broker owns account leases and OAuth refresh, while an external
 * Anthropic-compatible protocol proxy owns transport; this module is the
 * contract between them. The proxy validates a caller key here, strips caller
 * credentials before upstream, forwards bytes unchanged, then reports the
 * actual Anthropic usage it observed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

const STORE_DIR = "account-pool";
const KEY_FILE = "consumer-keys.json";
const TOTALS_FILE = "consumer-usage-totals.json";
const KEY_PREFIX = "eliza_cp_";
const MAX_LABEL_LENGTH = 128;
const MAX_MODEL_LENGTH = 256;
const RESERVATIONS_FILE = "consumer-usage-reservations.json";
const METERING_LOCK_DIR = "consumer-metering.lock";
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = LOCK_STALE_MS + 5_000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface AccountPoolConsumerKey {
  id: string;
  label: string;
  enabled: boolean;
  dailyTokenQuota: number | null;
  keyDigest: string;
  keyPrefix: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface AccountPoolConsumerKeyPublic {
  id: string;
  label: string;
  enabled: boolean;
  dailyTokenQuota: number | null;
  keyPrefix: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface AccountPoolConsumerKeyCreateInput {
  label?: unknown;
  enabled?: unknown;
  dailyTokenQuota?: unknown;
}

export interface AccountPoolConsumerKeyUpdateInput {
  label?: unknown;
  enabled?: unknown;
  dailyTokenQuota?: unknown;
}

export interface AccountPoolConsumerUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AccountPoolConsumerUsageRecord {
  ts: number;
  consumerId: string;
  consumerLabel: string;
  model: string | null;
  streaming: boolean;
  status: number;
  latencyMs: number;
  usage: AccountPoolConsumerUsage;
  totalTokens: number;
}

export interface AccountPoolConsumerUsageTotals {
  totals: {
    requests: number;
    tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    errors: number;
    latencyMs: number;
  };
  byConsumer: Record<string, AccountPoolConsumerUsageTotals["totals"]>;
  byDay: Record<string, AccountPoolConsumerUsageTotals["totals"]>;
  byConsumerDay: Record<string, AccountPoolConsumerUsageTotals["totals"]>;
}

export interface AccountPoolConsumerUsageQuery {
  consumerId?: string;
  startMs?: number;
  endMs?: number;
}

export interface AccountPoolConsumerUsageBreakdown {
  totals: AccountPoolConsumerUsageTotals["totals"];
  byDay: Record<string, AccountPoolConsumerUsageTotals["totals"]>;
  byConsumer: Record<string, AccountPoolConsumerUsageTotals["totals"]>;
  records: AccountPoolConsumerUsageRecord[];
}

export interface AccountPoolConsumerAdmission {
  id: string;
  consumerId: string;
  day: string;
  reservedTokens: number;
}

interface ConsumerReservationRecord {
  id: string;
  consumerId: string;
  day: string;
  tokens: number;
  createdAt: number;
  expiresAt: number;
}

interface ConsumerReservationsFile {
  version: 1;
  reservations: ConsumerReservationRecord[];
}

export type AccountPoolConsumerAuthResult =
  | {
      ok: true;
      mode: "legacy";
      consumer: null;
      admission: null;
      upstreamHeaders: Headers;
    }
  | {
      ok: true;
      mode: "consumer";
      consumer: AccountPoolConsumerKeyPublic;
      admission: AccountPoolConsumerAdmission;
      upstreamHeaders: Headers;
    }
  | {
      ok: false;
      status: 401 | 429;
      body: AnthropicErrorBody;
      upstreamHeaders: Headers;
    };

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type: "authentication_error" | "rate_limit_error";
    message: string;
  };
}

interface StoredKeysFile {
  version: 1;
  keys: AccountPoolConsumerKey[];
}

type HeaderInput = Headers | Record<string, string | string[] | undefined>;

const EMPTY_USAGE: AccountPoolConsumerUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function storeRoot(): string {
  return path.join(resolveStateDir(), STORE_DIR);
}

function ensureStoreRoot(): string {
  const root = storeRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function keysPath(): string {
  return path.join(ensureStoreRoot(), KEY_FILE);
}

function totalsPath(): string {
  return path.join(ensureStoreRoot(), TOTALS_FILE);
}

function reservationsPath(): string {
  return path.join(ensureStoreRoot(), RESERVATIONS_FILE);
}

function meteringLockPath(): string {
  return path.join(ensureStoreRoot(), METERING_LOCK_DIR);
}

function usageLogPath(ts: number): string {
  return path.join(
    ensureStoreRoot(),
    "consumer-usage",
    `${dayStamp(ts)}.jsonl`,
  );
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString(
      "hex",
    )}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, filePath);
}

function readKeysFile(): StoredKeysFile {
  const file = keysPath();
  if (!existsSync(file)) return { version: 1, keys: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredKeysFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
    throw new Error("invalid_consumer_key_store");
  }
  return parsed;
}

function writeKeysFile(file: StoredKeysFile): void {
  atomicWriteJson(keysPath(), file);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withMeteringLock<T>(work: () => T | Promise<T>): Promise<T> {
  const lockPath = meteringLockPath();
  const startedAt = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
      }
      if (stale) {
        const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
        try {
          renameSync(lockPath, stalePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw renameError;
          }
          continue;
        }
        rmSync(stalePath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error("consumer_metering_lock_timeout");
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  let result: T;
  try {
    result = await work();
  } catch (workError) {
    // Best-effort release; the primary failure must not be masked by cleanup.
    releaseMeteringLock(lockPath, { rethrow: false });
    throw workError;
  }
  releaseMeteringLock(lockPath, { rethrow: true });
  return result;
}

function releaseMeteringLock(
  lockPath: string,
  options: { rethrow: boolean },
): void {
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (options.rethrow) throw error;
  }
}

function publicKey(
  record: AccountPoolConsumerKey,
): AccountPoolConsumerKeyPublic {
  return {
    id: record.id,
    label: record.label,
    enabled: record.enabled,
    dailyTokenQuota: record.dailyTokenQuota,
    keyPrefix: record.keyPrefix,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastUsedAt !== undefined
      ? { lastUsedAt: record.lastUsedAt }
      : {}),
  };
}

function generateConsumerKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function digestConsumerKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function safeDigestEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeLabel(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LABEL_LENGTH) return null;
  return trimmed;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

function normalizeQuota(
  value: unknown,
  fallback: number | null,
): number | null | undefined {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "number") return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function makeConsumerId(): string {
  return `ck_${randomBytes(16).toString("base64url")}`;
}

export function createAccountPoolConsumerKey(
  input: AccountPoolConsumerKeyCreateInput = {},
): { key: string; consumer: AccountPoolConsumerKeyPublic } | null {
  const label = normalizeLabel(input.label, "consumer");
  const enabled = normalizeEnabled(input.enabled, true);
  const quota = normalizeQuota(input.dailyTokenQuota, null);
  if (label === null || enabled === null || quota === undefined) return null;

  const now = Date.now();
  const key = generateConsumerKey();
  const record: AccountPoolConsumerKey = {
    id: makeConsumerId(),
    label,
    enabled,
    dailyTokenQuota: quota,
    keyDigest: digestConsumerKey(key),
    keyPrefix: key.slice(0, 18),
    createdAt: now,
    updatedAt: now,
  };
  const file = readKeysFile();
  file.keys.push(record);
  writeKeysFile(file);
  return { key, consumer: publicKey(record) };
}

export function listAccountPoolConsumerKeys(): AccountPoolConsumerKeyPublic[] {
  return readKeysFile().keys.map(publicKey);
}

export function updateAccountPoolConsumerKey(
  id: string,
  input: AccountPoolConsumerKeyUpdateInput,
): AccountPoolConsumerKeyPublic | null | "invalid" {
  const file = readKeysFile();
  const index = file.keys.findIndex((record) => record.id === id);
  if (index < 0) return null;
  const current = file.keys[index];
  if (!current) return null;
  const label = normalizeLabel(input.label, current.label);
  const enabled = normalizeEnabled(input.enabled, current.enabled);
  const quota = normalizeQuota(input.dailyTokenQuota, current.dailyTokenQuota);
  if (label === null || enabled === null || quota === undefined) {
    return "invalid";
  }
  const next: AccountPoolConsumerKey = {
    ...current,
    label,
    enabled,
    dailyTokenQuota: quota,
    updatedAt: Date.now(),
  };
  file.keys[index] = next;
  writeKeysFile(file);
  return publicKey(next);
}

export function rotateAccountPoolConsumerKey(
  id: string,
): { key: string; consumer: AccountPoolConsumerKeyPublic } | null {
  const file = readKeysFile();
  const index = file.keys.findIndex((record) => record.id === id);
  if (index < 0) return null;
  const current = file.keys[index];
  if (!current) return null;
  const key = generateConsumerKey();
  const next: AccountPoolConsumerKey = {
    ...current,
    keyDigest: digestConsumerKey(key),
    keyPrefix: key.slice(0, 18),
    updatedAt: Date.now(),
  };
  file.keys[index] = next;
  writeKeysFile(file);
  return { key, consumer: publicKey(next) };
}

export function findAccountPoolConsumerByKey(
  key: string,
): AccountPoolConsumerKeyPublic | null | "disabled" {
  const digest = digestConsumerKey(key);
  for (const record of readKeysFile().keys) {
    if (!safeDigestEqual(record.keyDigest, digest)) continue;
    if (!record.enabled) return "disabled";
    // Authentication is deliberately read-only. Rewriting the whole key store
    // here could race an admin rotation and resurrect the revoked digest.
    return publicKey(record);
  }
  return null;
}

function publicConsumerAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw =
    env.ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function brokerSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ELIZA_ACCOUNT_POOL_BROKER_SECRET?.trim();
  return raw && raw.length >= 32 ? raw : null;
}

function headersToHeaders(input: HeaderInput): Headers {
  if (input instanceof Headers) return new Headers(input);
  const out = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return out;
}

function extractBearer(value: string | null): string | null {
  if (!value?.toLowerCase().startsWith("bearer ")) return null;
  const token = value.slice(7).trim();
  return token || null;
}

function extractConsumerCredential(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;
  return extractBearer(headers.get("authorization"));
}

export function stripAccountPoolConsumerCredentialHeaders(
  headers: HeaderInput,
): Headers {
  const out = headersToHeaders(headers);
  out.delete("x-api-key");
  out.delete("authorization");
  return out;
}

export function anthropicAuthError(
  message = "Invalid API key",
): AnthropicErrorBody {
  return {
    type: "error",
    error: { type: "authentication_error", message },
  };
}

export function anthropicQuotaError(
  message = "Daily token quota exceeded",
): AnthropicErrorBody {
  return {
    type: "error",
    error: { type: "rate_limit_error", message },
  };
}

export function estimateAnthropicRequestReservation(payload: unknown): number {
  let serializedBytes = 0;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
  } catch {
    // Cyclic/non-serializable input cannot be a valid JSON request. Reserving
    // one token keeps this helper total while the protocol parser rejects it.
    serializedBytes = 1;
  }
  const maxTokens =
    payload &&
    typeof payload === "object" &&
    "max_tokens" in payload &&
    typeof (payload as { max_tokens?: unknown }).max_tokens === "number" &&
    Number.isSafeInteger((payload as { max_tokens: number }).max_tokens) &&
    (payload as { max_tokens: number }).max_tokens > 0
      ? (payload as { max_tokens: number }).max_tokens
      : 0;
  // UTF-8 bytes are a conservative upper bound for input token count. Add the
  // requested output ceiling so quota admission happens before upstream work.
  return Math.max(1, serializedBytes + maxTokens);
}

export async function authenticateAccountPoolConsumerRequest(
  headers: HeaderInput,
  requestPayload: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccountPoolConsumerAuthResult> {
  const original = headersToHeaders(headers);
  const upstreamHeaders = stripAccountPoolConsumerCredentialHeaders(original);
  if (!publicConsumerAuthEnabled(env)) {
    return {
      ok: true,
      mode: "legacy",
      consumer: null,
      admission: null,
      upstreamHeaders,
    };
  }

  const credential = extractConsumerCredential(original);
  const adminBearer = extractBearer(original.get("authorization"));
  if (adminBearer && brokerSecret(env) === adminBearer) {
    return {
      ok: false,
      status: 401,
      body: anthropicAuthError("Broker admin bearer is not a consumer API key"),
      upstreamHeaders,
    };
  }
  if (!credential) {
    return {
      ok: false,
      status: 401,
      body: anthropicAuthError(),
      upstreamHeaders,
    };
  }
  const consumer = findAccountPoolConsumerByKey(credential);
  if (consumer === null || consumer === "disabled") {
    return {
      ok: false,
      status: 401,
      body: anthropicAuthError(),
      upstreamHeaders,
    };
  }
  const admission = await admitAccountPoolConsumerRequest(
    consumer,
    estimateAnthropicRequestReservation(requestPayload),
  );
  if ("ok" in admission) {
    return { ...admission, upstreamHeaders };
  }
  return {
    ok: true,
    mode: "consumer",
    consumer,
    admission,
    upstreamHeaders,
  };
}

function dayStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function emptyTotalsBucket(): AccountPoolConsumerUsageTotals["totals"] {
  return {
    requests: 0,
    tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    errors: 0,
    latencyMs: 0,
  };
}

function readTotalsFile(): AccountPoolConsumerUsageTotals {
  const file = totalsPath();
  if (!existsSync(file)) {
    return {
      totals: emptyTotalsBucket(),
      byConsumer: {},
      byDay: {},
      byConsumerDay: {},
    };
  }
  return JSON.parse(
    readFileSync(file, "utf8"),
  ) as AccountPoolConsumerUsageTotals;
}

function readReservationsFile(now = Date.now()): ConsumerReservationsFile {
  const file = reservationsPath();
  if (!existsSync(file)) return { version: 1, reservations: [] };
  const parsed = JSON.parse(
    readFileSync(file, "utf8"),
  ) as ConsumerReservationsFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.reservations)) {
    throw new Error("invalid_consumer_reservation_store");
  }
  return {
    version: 1,
    reservations: parsed.reservations.filter(
      (reservation) =>
        reservation &&
        typeof reservation.id === "string" &&
        typeof reservation.consumerId === "string" &&
        typeof reservation.day === "string" &&
        Number.isSafeInteger(reservation.tokens) &&
        reservation.tokens > 0 &&
        Number.isSafeInteger(reservation.expiresAt) &&
        reservation.expiresAt > now,
    ),
  };
}

function writeReservationsFile(file: ConsumerReservationsFile): void {
  atomicWriteJson(reservationsPath(), file);
}

function addRecordToBucket(
  bucket: AccountPoolConsumerUsageTotals["totals"],
  record: AccountPoolConsumerUsageRecord,
): void {
  bucket.requests += 1;
  bucket.tokens += record.totalTokens;
  bucket.input_tokens += record.usage.input_tokens;
  bucket.output_tokens += record.usage.output_tokens;
  bucket.cache_read_input_tokens += record.usage.cache_read_input_tokens;
  bucket.cache_creation_input_tokens +=
    record.usage.cache_creation_input_tokens;
  bucket.latencyMs += record.latencyMs;
  if (record.status >= 400) bucket.errors += 1;
}

let usageWriteQueue = Promise.resolve();

export function __resetAccountPoolConsumerMeteringForTests(): void {
  usageWriteQueue = Promise.resolve();
}

function enqueueUsageWrite<T>(work: () => T | Promise<T>): Promise<T> {
  const next = usageWriteQueue.then(work, work);
  usageWriteQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function reservationKey(consumerId: string, day: string): string {
  return `${consumerId}:${day}`;
}

function usageTotal(usage: AccountPoolConsumerUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function recordedConsumerDayTokens(consumerId: string, day: string): number {
  const startMs = dayStartMs(day);
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return readUsageRecords({ consumerId, startMs, endMs }).reduce(
    (total, record) => total + record.totalTokens,
    0,
  );
}

function reservedConsumerDayTokens(
  reservations: ConsumerReservationsFile,
  consumerId: string,
  day: string,
): number {
  return reservations.reservations.reduce(
    (total, reservation) =>
      reservation.consumerId === consumerId && reservation.day === day
        ? total + reservation.tokens
        : total,
    0,
  );
}

export async function admitAccountPoolConsumerRequest(
  consumer: AccountPoolConsumerKeyPublic,
  reservationTokens = 1,
): Promise<
  | AccountPoolConsumerAdmission
  | { ok: false; status: 429; body: AnthropicErrorBody }
> {
  return enqueueUsageWrite(() =>
    withMeteringLock(() => {
      const now = Date.now();
      const day = dayStamp(now);
      if (consumer.dailyTokenQuota === null) {
        return {
          id: randomBytes(12).toString("base64url"),
          consumerId: consumer.id,
          day,
          reservedTokens: 0,
        };
      }
      const reservations = readReservationsFile(now);
      const used = recordedConsumerDayTokens(consumer.id, day);
      const reserved = reservedConsumerDayTokens(
        reservations,
        consumer.id,
        day,
      );
      const normalizedReservation =
        typeof reservationTokens === "number" &&
        Number.isFinite(reservationTokens)
          ? Math.max(1, Math.floor(reservationTokens))
          : 1;
      if (used + reserved + normalizedReservation > consumer.dailyTokenQuota) {
        return { ok: false, status: 429, body: anthropicQuotaError() };
      }
      const id = randomBytes(12).toString("base64url");
      reservations.reservations.push({
        id,
        consumerId: consumer.id,
        day,
        tokens: normalizedReservation,
        createdAt: now,
        expiresAt: now + RESERVATION_TTL_MS,
      });
      writeReservationsFile(reservations);
      return {
        id,
        consumerId: consumer.id,
        day,
        reservedTokens: normalizedReservation,
      };
    }),
  );
}

export async function recordAccountPoolConsumerUsage(
  input: Omit<AccountPoolConsumerUsageRecord, "ts" | "totalTokens"> & {
    ts?: number;
    admission?: AccountPoolConsumerAdmission;
  },
): Promise<AccountPoolConsumerUsageRecord> {
  const usage = normalizeUsage(input.usage);
  const record: AccountPoolConsumerUsageRecord = {
    ts: input.ts ?? Date.now(),
    consumerId: input.consumerId,
    consumerLabel: input.consumerLabel,
    model: normalizeModel(input.model),
    streaming: input.streaming,
    status: input.status,
    latencyMs: normalizeNonNegativeInteger(input.latencyMs),
    usage,
    totalTokens: usageTotal(usage),
  };
  return enqueueUsageWrite(() =>
    withMeteringLock(() => {
      if (input.admission?.reservedTokens) {
        const reservations = readReservationsFile();
        const nextReservations = reservations.reservations.filter(
          (reservation) => reservation.id !== input.admission?.id,
        );
        if (nextReservations.length !== reservations.reservations.length) {
          writeReservationsFile({
            version: 1,
            reservations: nextReservations,
          });
        }
      }
      const file = usageLogPath(record.ts);
      const dir = path.dirname(file);
      // These synchronous writes are intentionally bounded to one compact JSONL
      // record plus small aggregate files. The async queue and cross-process lock
      // serialize this low-volume local broker path and prevent ledger races.
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify(record)}\n`, {
        flag: "a",
        mode: 0o600,
      });

      const totals = readTotalsFile();
      const day = dayStamp(record.ts);
      const consumerDay = reservationKey(record.consumerId, day);
      const consumerBucket =
        totals.byConsumer[record.consumerId] ?? emptyTotalsBucket();
      const dayBucket = totals.byDay[day] ?? emptyTotalsBucket();
      const consumerDayBucket =
        totals.byConsumerDay[consumerDay] ?? emptyTotalsBucket();
      totals.byConsumer[record.consumerId] = consumerBucket;
      totals.byDay[day] = dayBucket;
      totals.byConsumerDay[consumerDay] = consumerDayBucket;
      addRecordToBucket(totals.totals, record);
      addRecordToBucket(consumerBucket, record);
      addRecordToBucket(dayBucket, record);
      addRecordToBucket(consumerDayBucket, record);
      atomicWriteJson(totalsPath(), totals);
      return record;
    }),
  );
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeUsage(
  value: Partial<AccountPoolConsumerUsage> | undefined,
): AccountPoolConsumerUsage {
  return {
    input_tokens: normalizeNonNegativeInteger(value?.input_tokens),
    output_tokens: normalizeNonNegativeInteger(value?.output_tokens),
    cache_read_input_tokens: normalizeNonNegativeInteger(
      value?.cache_read_input_tokens,
    ),
    cache_creation_input_tokens: normalizeNonNegativeInteger(
      value?.cache_creation_input_tokens,
    ),
  };
}

function normalizePartialUsage(
  value: Partial<AccountPoolConsumerUsage> | undefined,
): Partial<AccountPoolConsumerUsage> {
  if (!value) return {};
  const out: Partial<AccountPoolConsumerUsage> = {};
  if (value.input_tokens !== undefined) {
    out.input_tokens = normalizeNonNegativeInteger(value.input_tokens);
  }
  if (value.output_tokens !== undefined) {
    out.output_tokens = normalizeNonNegativeInteger(value.output_tokens);
  }
  if (value.cache_read_input_tokens !== undefined) {
    out.cache_read_input_tokens = normalizeNonNegativeInteger(
      value.cache_read_input_tokens,
    );
  }
  if (value.cache_creation_input_tokens !== undefined) {
    out.cache_creation_input_tokens = normalizeNonNegativeInteger(
      value.cache_creation_input_tokens,
    );
  }
  return out;
}

function normalizeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_MODEL_LENGTH);
}

export function extractAnthropicUsageFromJson(
  payload: unknown,
): AccountPoolConsumerUsage {
  const usage =
    payload && typeof payload === "object" && "usage" in payload
      ? (payload as { usage?: Partial<AccountPoolConsumerUsage> }).usage
      : undefined;
  return normalizeUsage(usage);
}

function mergeStreamingUsage(
  target: AccountPoolConsumerUsage,
  next: Partial<AccountPoolConsumerUsage>,
): void {
  if (next.input_tokens !== undefined) {
    target.input_tokens = normalizeNonNegativeInteger(next.input_tokens);
  }
  if (next.cache_read_input_tokens !== undefined) {
    target.cache_read_input_tokens = normalizeNonNegativeInteger(
      next.cache_read_input_tokens,
    );
  }
  if (next.cache_creation_input_tokens !== undefined) {
    target.cache_creation_input_tokens = normalizeNonNegativeInteger(
      next.cache_creation_input_tokens,
    );
  }
  if (next.output_tokens !== undefined) {
    target.output_tokens = normalizeNonNegativeInteger(next.output_tokens);
  }
}

export function parseAnthropicSseEventUsage(
  payload: unknown,
): Partial<AccountPoolConsumerUsage> | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as {
    type?: unknown;
    message?: { usage?: Partial<AccountPoolConsumerUsage> };
    usage?: Partial<AccountPoolConsumerUsage>;
  };
  if (event.type === "message_start") {
    return normalizePartialUsage(event.message?.usage);
  }
  if (event.type === "message_delta") {
    return normalizePartialUsage(event.usage);
  }
  return null;
}

export interface AnthropicSseUsageMeter
  extends TransformStream<Uint8Array, Uint8Array> {
  /** Idempotent finalizer. Call from the proxy's finally block on abort/error. */
  finalizeUsage(): Promise<void>;
}

export function createAnthropicSseUsageMeter(
  onUsage: (usage: AccountPoolConsumerUsage) => void | Promise<void>,
): AnthropicSseUsageMeter {
  const decoder = new TextDecoder();
  const usage: AccountPoolConsumerUsage = { ...EMPTY_USAGE };
  let textBuffer = "";
  let pendingData: string[] = [];
  let finalized = false;

  function consumeText(text: string): void {
    textBuffer += text;
    let newlineIndex = textBuffer.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const rawLine = textBuffer.slice(0, newlineIndex);
      const newlineLength =
        textBuffer[newlineIndex] === "\r" &&
        textBuffer[newlineIndex + 1] === "\n"
          ? 2
          : 1;
      textBuffer = textBuffer.slice(newlineIndex + newlineLength);
      consumeLine(rawLine);
      newlineIndex = textBuffer.search(/\r?\n/);
    }
  }

  function consumeLine(line: string): void {
    if (!line) {
      consumeEvent();
      return;
    }
    if (line.startsWith("data:")) pendingData.push(line.slice(5).trimStart());
  }

  function consumeEvent(): void {
    if (pendingData.length === 0) return;
    const data = pendingData.join("\n");
    pendingData = [];
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      // error-policy:J3 upstream SSE data is untrusted input; malformed events
      // are invalid for metering but the already-enqueued passthrough bytes are
      // still owned by the transport proxy.
      return;
    }
    const eventUsage = parseAnthropicSseEventUsage(parsed);
    if (eventUsage) mergeStreamingUsage(usage, eventUsage);
  }

  async function finalizeUsage(): Promise<void> {
    if (finalized) return;
    finalized = true;
    const tail = decoder.decode();
    if (tail) consumeText(tail);
    if (textBuffer) consumeLine(textBuffer);
    consumeEvent();
    await onUsage({ ...usage });
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      consumeText(decoder.decode(chunk, { stream: true }));
    },
    flush: finalizeUsage,
  });
  return Object.assign(stream, { finalizeUsage });
}

export async function getAccountPoolConsumerUsageSummary(): Promise<AccountPoolConsumerUsageBreakdown> {
  const stored = readTotalsFile();
  return {
    totals: { ...stored.totals },
    byDay: Object.fromEntries(
      Object.entries(stored.byDay).map(([day, bucket]) => [day, { ...bucket }]),
    ),
    byConsumer: Object.fromEntries(
      Object.entries(stored.byConsumer).map(([id, bucket]) => [
        id,
        { ...bucket },
      ]),
    ),
    records: [],
  };
}

export async function queryAccountPoolConsumerUsage(
  query: AccountPoolConsumerUsageQuery = {},
): Promise<AccountPoolConsumerUsageBreakdown> {
  const records = readUsageRecords(query);
  const result: AccountPoolConsumerUsageBreakdown = {
    totals: emptyTotalsBucket(),
    byDay: {},
    byConsumer: {},
    records,
  };
  for (const record of records) {
    const day = dayStamp(record.ts);
    const dayBucket = result.byDay[day] ?? emptyTotalsBucket();
    const consumerBucket =
      result.byConsumer[record.consumerId] ?? emptyTotalsBucket();
    result.byDay[day] = dayBucket;
    result.byConsumer[record.consumerId] = consumerBucket;
    addRecordToBucket(result.totals, record);
    addRecordToBucket(dayBucket, record);
    addRecordToBucket(consumerBucket, record);
  }
  return result;
}

function readUsageRecords(
  query: AccountPoolConsumerUsageQuery,
): AccountPoolConsumerUsageRecord[] {
  const dir = path.join(ensureStoreRoot(), "consumer-usage");
  if (!existsSync(dir)) return [];
  const out: AccountPoolConsumerUsageRecord[] = [];
  const start = query.startMs ?? 0;
  const end = query.endMs ?? Number.MAX_SAFE_INTEGER;
  const files = existsSync(dir) ? readdirSync(dir) : [];
  for (const fileName of files.sort()) {
    if (!fileName.endsWith(".jsonl")) continue;
    const raw = readFileSync(path.join(dir, fileName), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as AccountPoolConsumerUsageRecord;
      if (query.consumerId && parsed.consumerId !== query.consumerId) continue;
      if (parsed.ts < start || parsed.ts >= end) continue;
      out.push(parsed);
    }
  }
  return out;
}
