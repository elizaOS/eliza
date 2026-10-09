/** Owner-only encrypted capture persistence. No plaintext or organization-export fallback. */
import type { EncryptedField } from "../../../db/crypto/field-crypto";
import type { RuntimeR2Bucket } from "../../storage/r2-runtime-binding";
import {
  createOwnerCaptureBuffer,
  type OwnerCapturePayload,
  type OwnerCaptureScope,
  type OwnerModelCapture,
  parseOwnerCapturePayload,
} from "./shared-owner-model-capture";

export interface OwnerCapturePolicy {
  version: 1;
  sessionId: string;
  organizationId: string;
  userId: string;
  readerUserId: string;
  roomId: string;
  issuedAt: number;
  expiresAt: number;
  retainUntil: number;
  maxTurns: number;
  maxCalls: number;
  maxBytes: number;
}
export interface OwnerCaptureBudgetStorage {
  transaction<T>(
    fn: (tx: {
      get<T>(key: string): Promise<T | undefined>;
      put<T>(key: string, value: T): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}
export interface OwnerCaptureLocator {
  sessionId: string;
  captureId: string;
}
export type OwnerCaptureStatus =
  | "pending"
  | "stored"
  | "failed"
  | "unknown"
  | "deleted"
  | "cleanup-failed";
interface Reservation {
  captureId: string;
  traceId: string;
  reservedAt: number;
  status: OwnerCaptureStatus;
  statusAt: number;
  cleanupAttempts?: number;
}
interface Budget {
  policy: OwnerCapturePolicy;
  captures: Reservation[];
}
export interface OwnerCapturePrincipal {
  organizationId: string;
  userId: string;
  authenticatedOwner: boolean;
  verifiedAdmin?: boolean;
}
export interface OwnerCaptureAdmission {
  state:
    | "disabled"
    | "scope-mismatch"
    | "expired"
    | "exhausted"
    | "unavailable"
    | "admitted";
  capture?: OwnerModelCapture;
  locator?: OwnerCaptureLocator;
  cleanupAt?: number;
  sessionCreated?: boolean;
  persistence: { state: "not-started" | OwnerCaptureStatus };
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE = /^[0-9a-f]{32}$/;
const SESSION_INDEX = "owner-model-capture-sessions";
const PREFIX = "private/owner-model-capture/v1/";
const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const policyFields = [
  "version",
  "sessionId",
  "organizationId",
  "userId",
  "readerUserId",
  "roomId",
  "issuedAt",
  "expiresAt",
  "retainUntil",
  "maxTurns",
  "maxCalls",
  "maxBytes",
] as const;
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function integer(v: unknown, low: number, high: number): v is number {
  return (
    typeof v === "number" && Number.isSafeInteger(v) && v >= low && v <= high
  );
}
function id(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}
export function parseOwnerCapturePolicy(
  value: unknown,
): Readonly<OwnerCapturePolicy> | undefined {
  if (typeof value !== "string" || encoder.encode(value).byteLength > 4096)
    return undefined;
  let p: unknown;
  try {
    p = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !record(p) ||
    Object.keys(p).sort().join(",") !== [...policyFields].sort().join(",")
  )
    return undefined;
  if (
    p.version !== 1 ||
    !id(p.sessionId) ||
    !id(p.organizationId) ||
    !id(p.userId) ||
    !id(p.readerUserId) ||
    !id(p.roomId)
  )
    return undefined;
  if (
    !integer(p.issuedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(p.expiresAt, 0, Number.MAX_SAFE_INTEGER) ||
    p.expiresAt <= p.issuedAt ||
    p.expiresAt - p.issuedAt > 3_600_000
  )
    return undefined;
  if (
    !integer(p.retainUntil, 0, Number.MAX_SAFE_INTEGER) ||
    p.retainUntil <= p.expiresAt ||
    p.retainUntil - p.issuedAt > 86_400_000
  )
    return undefined;
  if (
    !integer(p.maxTurns, 1, 16) ||
    !integer(p.maxCalls, 1, 32) ||
    !integer(p.maxBytes, 65_536, MAX_BYTES)
  )
    return undefined;
  return Object.freeze({
    version: 1,
    sessionId: p.sessionId,
    organizationId: p.organizationId,
    userId: p.userId,
    readerUserId: p.readerUserId,
    roomId: p.roomId,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    retainUntil: p.retainUntil,
    maxTurns: p.maxTurns,
    maxCalls: p.maxCalls,
    maxBytes: p.maxBytes,
  });
}
function samePolicy(a: OwnerCapturePolicy, b: OwnerCapturePolicy): boolean {
  return policyFields.every((field) => a[field] === b[field]);
}
function matches(
  p: OwnerCapturePolicy,
  scope: Pick<OwnerCaptureScope, "organizationId" | "userId" | "roomId">,
): boolean {
  return (
    p.organizationId === scope.organizationId &&
    p.userId === scope.userId &&
    p.roomId === scope.roomId
  );
}
function objectKey(locator: OwnerCaptureLocator): string {
  if (!id(locator.sessionId) || !id(locator.captureId))
    throw new Error("OWNER_CAPTURE_LOCATOR_INVALID");
  return PREFIX + locator.sessionId + "/" + locator.captureId + ".json";
}
function budgetKey(sessionId: string): string {
  if (!id(sessionId)) throw new Error("OWNER_CAPTURE_SESSION_INVALID");
  return "owner-model-capture-budget:" + sessionId;
}
function coords(p: OwnerCapturePolicy, locator: OwnerCaptureLocator) {
  return {
    table: "private_owner_model_capture",
    rowId:
      p.organizationId +
      ":" +
      p.userId +
      ":" +
      p.roomId +
      ":" +
      objectKey(locator),
    column: "payload",
  };
}
async function terminalStatus(
  storage: OwnerCaptureBudgetStorage,
  policy: OwnerCapturePolicy,
  locator: OwnerCaptureLocator,
  status: OwnerCaptureStatus,
  at: number,
): Promise<void> {
  await storage.transaction(async (tx) => {
    const b = await tx.get<Budget>(budgetKey(locator.sessionId));
    if (!b || !samePolicy(b.policy, policy))
      throw new Error("OWNER_CAPTURE_ADMISSION_DRIFT");
    const entry = b.captures.find(
      (item) => item.captureId === locator.captureId,
    );
    if (!entry) throw new Error("OWNER_CAPTURE_NOT_ADMITTED");
    entry.status = status;
    entry.statusAt = at;
    await tx.put(budgetKey(locator.sessionId), b);
  });
}
class CaptureWriteError extends Error {
  constructor(readonly uncertain: boolean) {
    super(
      uncertain ? "OWNER_CAPTURE_WRITE_UNKNOWN" : "OWNER_CAPTURE_WRITE_FAILED",
    );
  }
}
async function boundedObservation<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("OWNER_CAPTURE_OPERATION_UNKNOWN")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Only the server's verified account/room path may construct this capability. */
export async function reserveOwnerModelCapture(params: {
  policyValue: unknown;
  verifiedPersonalShared: boolean;
  requiresSessionContext?: true;
  scope: OwnerCaptureScope;
  storage: OwnerCaptureBudgetStorage;
  bucket: RuntimeR2Bucket;
  waitUntil: (work: Promise<unknown>) => void;
  now?: () => number;
}): Promise<OwnerCaptureAdmission> {
  const storage = params.storage;
  const bucket = params.bucket;
  const waitUntil = params.waitUntil;
  const persistence: OwnerCaptureAdmission["persistence"] = {
    state: "not-started",
  };
  const policy = parseOwnerCapturePolicy(params.policyValue);
  if (!policy) return { state: "disabled", persistence };
  const scope = Object.freeze({ ...params.scope });
  if (
    !params.verifiedPersonalShared ||
    !matches(policy, scope) ||
    !TRACE.test(scope.traceId)
  )
    return { state: "scope-mismatch", persistence };
  const now = params.now ?? Date.now;
  if (now() < policy.issuedAt || now() >= policy.expiresAt)
    return { state: "expired", persistence };
  const locator = Object.freeze({
    sessionId: policy.sessionId,
    captureId: crypto.randomUUID(),
  });
  let admitted = false;
  let sessionCreated = false;
  try {
    admitted = await storage.transaction(async (tx) => {
      const sessions = (await tx.get<string[]>(SESSION_INDEX)) ?? [];
      if (!sessions.includes(policy.sessionId) && sessions.length >= 16)
        return false;
      const prior = await tx.get<Budget>(budgetKey(policy.sessionId));
      if (
        now() >= policy.expiresAt ||
        (prior && !samePolicy(prior.policy, policy))
      )
        return false;
      if (
        prior &&
        params.requiresSessionContext &&
        !(await tx.get("owner-capture-context:" + policy.sessionId))
      )
        return false;
      sessionCreated = !prior;
      const captures = prior?.captures ?? [];
      if (captures.length >= policy.maxTurns) return false;
      const reservation: Reservation = {
        captureId: locator.captureId,
        traceId: scope.traceId,
        reservedAt: now(),
        status: "pending",
        statusAt: now(),
      };
      // Durable reservation is authoritative before any buffer/cache is created.
      await tx.put(budgetKey(policy.sessionId), {
        policy,
        captures: [...captures, reservation],
      } satisfies Budget);
      if (!sessions.includes(policy.sessionId))
        await tx.put(SESSION_INDEX, [...sessions, policy.sessionId]);
      return true;
    });
  } catch {
    return { state: "unavailable", persistence };
  }
  if (!admitted) return { state: "exhausted", persistence };
  const capture = createOwnerCaptureBuffer(
    scope,
    policy,
    (payload) => {
      persistence.state = "pending";
      const work = writeEncryptedOwnerCapture(
        bucket,
        policy,
        locator,
        payload,
        now,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Exactly one background durable terminal-status write. A native R2 timeout
      // is uncertain; no cancellation claim, automatic retry, or late-state guess.
      const outcome = Promise.race<OwnerCaptureStatus>([
        work.then<OwnerCaptureStatus, OwnerCaptureStatus>(
          () => "stored",
          (error: unknown) =>
            error instanceof CaptureWriteError && error.uncertain
              ? "unknown"
              : "failed",
        ),
        new Promise<OwnerCaptureStatus>((resolve) => {
          timer = setTimeout(() => resolve("unknown"), 15_000);
        }),
      ]);
      const observed = outcome
        .then(async (status) => {
          try {
            await boundedObservation(
              terminalStatus(storage, policy, locator, status, now()),
              5_000,
            );
            persistence.state = status;
          } catch {
            persistence.state = "unknown";
          }
        })
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        })
        .catch(() => {
          persistence.state = "unknown";
        });
      try {
        waitUntil(observed);
      } catch {
        persistence.state = "unknown";
      }
    },
    now,
  );
  return {
    state: "admitted",
    capture,
    locator,
    cleanupAt: policy.retainUntil,
    sessionCreated,
    persistence,
  };
}

async function writeEncryptedOwnerCapture(
  bucket: RuntimeR2Bucket,
  policy: OwnerCapturePolicy,
  locator: OwnerCaptureLocator,
  payload: OwnerCapturePayload,
  now: () => number = Date.now,
): Promise<void> {
  if (
    !matches(policy, payload.scope) ||
    locator.sessionId !== policy.sessionId ||
    now() >= policy.retainUntil
  )
    throw new CaptureWriteError(false);
  const plaintext = JSON.stringify({ policy, locator, payload });
  if (encoder.encode(plaintext).byteLength > policy.maxBytes)
    throw new CaptureWriteError(false);
  const [{ encryptField }, { orgKey }] = await Promise.all([
    import("../../../db/crypto/field-crypto"),
    import("@elizaos/auth/kms"),
  ]);
  const encrypted = await encryptField(
    policy.organizationId,
    plaintext,
    coords(policy, locator),
  );
  if (
    encrypted.kms_key_id !== orgKey(policy.organizationId, "dek") ||
    now() >= policy.retainUntil
  )
    throw new CaptureWriteError(false);
  const { kms_key_id: _derivedKeyId, ...ciphertext } = encrypted;
  const body = JSON.stringify({ version: 1, ...ciphertext });
  if (encoder.encode(body).byteLength > Math.ceil(policy.maxBytes * 1.4) + 4096)
    throw new CaptureWriteError(false);
  try {
    const stored = await bucket.put(objectKey(locator), body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (!stored) throw new CaptureWriteError(true);
  } catch {
    throw new CaptureWriteError(true);
  }
}

async function authorizedAdmission(params: {
  storage: OwnerCaptureBudgetStorage;
  locator: OwnerCaptureLocator;
  principal: OwnerCapturePrincipal;
  roomId: string;
}): Promise<{
  policy: Readonly<OwnerCapturePolicy>;
  reservation: Reservation;
}> {
  const b = await params.storage.transaction((tx) =>
    tx.get<Budget>(budgetKey(params.locator.sessionId)),
  );
  const policy = b
    ? parseOwnerCapturePolicy(JSON.stringify(b.policy))
    : undefined;
  if (!b || !policy || policy.roomId !== params.roomId)
    throw new Error("OWNER_CAPTURE_READ_FORBIDDEN");
  const owner =
    params.principal.authenticatedOwner &&
    matches(policy, { ...params.principal, roomId: params.roomId });
  const approvedAdmin =
    params.principal.verifiedAdmin === true &&
    params.principal.userId === policy.readerUserId;
  if (!owner && !approvedAdmin) throw new Error("OWNER_CAPTURE_READ_FORBIDDEN");
  const reservation = b.captures.find(
    (entry) => entry.captureId === params.locator.captureId,
  );
  if (!reservation || !TRACE.test(reservation.traceId))
    throw new Error("OWNER_CAPTURE_NOT_ADMITTED");
  objectKey(params.locator);
  return { policy, reservation: { ...reservation } };
}
async function authenticatedPayload(
  bucket: RuntimeR2Bucket,
  policy: OwnerCapturePolicy,
  locator: OwnerCaptureLocator,
  reservation: Reservation,
): Promise<OwnerCapturePayload | null> {
  const object = await bucket.get(objectKey(locator));
  if (!object) return null;
  const ceiling = Math.ceil(policy.maxBytes * 1.4) + 4096;
  if (object.size === undefined || object.size > ceiling || !object.body)
    throw new Error("OWNER_CAPTURE_READ_BOUND");
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > ceiling) throw new Error("OWNER_CAPTURE_READ_BOUND");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("OWNER_CAPTURE_CIPHERTEXT_INVALID");
  }
  if (
    !record(envelope) ||
    Object.keys(envelope).sort().join(",") !==
      "auth_tag,ciphertext,kms_key_version,nonce,version" ||
    envelope.version !== 1 ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.auth_tag !== "string" ||
    !integer(envelope.kms_key_version, 1, Number.MAX_SAFE_INTEGER)
  )
    throw new Error("OWNER_CAPTURE_CIPHERTEXT_INVALID");
  const [{ decryptField }, { orgKey }] = await Promise.all([
    import("../../../db/crypto/field-crypto"),
    import("@elizaos/auth/kms"),
  ]);
  const field: EncryptedField = {
    ciphertext: envelope.ciphertext,
    nonce: envelope.nonce,
    auth_tag: envelope.auth_tag,
    kms_key_id: orgKey(policy.organizationId, "dek"),
    kms_key_version: envelope.kms_key_version,
  };
  const plaintext = await decryptField(field, coords(policy, locator));
  if (encoder.encode(plaintext).byteLength > policy.maxBytes)
    throw new Error("OWNER_CAPTURE_READ_BOUND");
  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch {
    throw new Error("OWNER_CAPTURE_PAYLOAD_INVALID");
  }
  if (
    !record(decoded) ||
    !record(decoded.locator) ||
    !record(decoded.payload) ||
    !record(decoded.payload.scope)
  )
    throw new Error("OWNER_CAPTURE_PAYLOAD_INVALID");
  const originalPolicy = parseOwnerCapturePolicy(
    JSON.stringify(decoded.policy),
  );
  if (
    !originalPolicy ||
    !samePolicy(originalPolicy, policy) ||
    decoded.locator.sessionId !== locator.sessionId ||
    decoded.locator.captureId !== locator.captureId ||
    decoded.payload.scope.organizationId !== policy.organizationId ||
    decoded.payload.scope.userId !== policy.userId ||
    decoded.payload.scope.roomId !== policy.roomId ||
    decoded.payload.scope.traceId !== reservation.traceId
  )
    throw new Error("OWNER_CAPTURE_AUTHENTICATED_SCOPE_MISMATCH");
  const payload = parseOwnerCapturePayload(decoded.payload);
  if (!payload) throw new Error("OWNER_CAPTURE_PAYLOAD_INVALID");
  return payload;
}

export async function readEncryptedOwnerCapture(params: {
  bucket: RuntimeR2Bucket;
  storage: OwnerCaptureBudgetStorage;
  locator: OwnerCaptureLocator;
  principal: OwnerCapturePrincipal;
  roomId: string;
  now?: () => number;
}): Promise<{
  durableStatus: OwnerCaptureStatus;
  objectAuthenticated: boolean;
  payload: OwnerCapturePayload | null;
}> {
  const now = params.now ?? Date.now;
  const { policy, reservation } = await authorizedAdmission(params);
  // Reads never delete. Retention is the original immutable admission, not today's config.
  if (now() >= policy.retainUntil)
    throw new Error("OWNER_CAPTURE_READ_EXPIRED");
  let payload: OwnerCapturePayload | null;
  try {
    payload = await boundedObservation(
      authenticatedPayload(params.bucket, policy, params.locator, reservation),
      15_000,
    );
  } catch {
    throw new Error("OWNER_CAPTURE_READ_UNAVAILABLE");
  }
  if (now() >= policy.retainUntil)
    throw new Error("OWNER_CAPTURE_READ_EXPIRED");
  return {
    durableStatus: reservation.status,
    objectAuthenticated: payload !== null,
    payload,
  };
}

/** Cleanup uses only an authoritative reserved locator and proves original AAD before delete. */
export async function cleanupExpiredOwnerCapture(params: {
  bucket: RuntimeR2Bucket;
  storage: OwnerCaptureBudgetStorage;
  locator: OwnerCaptureLocator;
  principal: OwnerCapturePrincipal;
  roomId: string;
  now?: () => number;
}): Promise<void> {
  const now = params.now ?? Date.now;
  const { policy, reservation } = await authorizedAdmission(params);
  if (now() < policy.retainUntil)
    throw new Error("OWNER_CAPTURE_CLEANUP_NOT_DUE");
  const payload = await boundedObservation(
    authenticatedPayload(params.bucket, policy, params.locator, reservation),
    15_000,
  );
  if (!payload) throw new Error("OWNER_CAPTURE_CLEANUP_OBJECT_UNAVAILABLE");
  await params.bucket.delete(objectKey(params.locator));
  await terminalStatus(
    params.storage,
    policy,
    params.locator,
    "deleted",
    now(),
  );
}

/** Alarm work is bounded to two admitted objects; remaining work uses the same DO alarm. */
export async function cleanupDueOwnerCaptures(params: {
  bucket: RuntimeR2Bucket;
  storage: OwnerCaptureBudgetStorage;
  now?: () => number;
}): Promise<{ nextDeadline?: number; cleanupExhausted: number }> {
  const now = params.now ?? Date.now;
  const sessions = await params.storage.transaction((tx) =>
    tx.get<string[]>(SESSION_INDEX),
  );
  if (!sessions) return { cleanupExhausted: 0 };
  if (sessions.length > 16 || sessions.some((session) => !id(session)))
    throw new Error("OWNER_CAPTURE_CLEANUP_INDEX_INVALID");
  let processed = 0;
  let cleanupExhausted = 0;
  let next: number | undefined;
  for (const sessionId of sessions) {
    const b = await params.storage.transaction((tx) =>
      tx.get<Budget>(budgetKey(sessionId)),
    );
    const policy = b
      ? parseOwnerCapturePolicy(JSON.stringify(b.policy))
      : undefined;
    if (!b || !policy || b.captures.length > 16)
      throw new Error("OWNER_CAPTURE_CLEANUP_INDEX_INVALID");
    if (b.captures.every((entry) => entry.status === "deleted")) continue;
    if (policy.retainUntil > now()) {
      next = Math.min(next ?? Infinity, policy.retainUntil);
      continue;
    }
    for (const entry of b.captures) {
      if (entry.status === "deleted") continue;
      if ((entry.cleanupAttempts ?? 0) >= 3) continue;
      if (processed >= 2) {
        next = Math.min(next ?? Infinity, now() + 60_000);
        break;
      }
      processed += 1;
      await params.storage.transaction(async (tx) => {
        const current = await tx.get<Budget>(budgetKey(sessionId));
        const reserved = current?.captures.find(
          (candidate) => candidate.captureId === entry.captureId,
        );
        if (!current || !reserved)
          throw new Error("OWNER_CAPTURE_NOT_ADMITTED");
        reserved.cleanupAttempts = (reserved.cleanupAttempts ?? 0) + 1;
        await tx.put(budgetKey(sessionId), current);
      });
      try {
        await cleanupExpiredOwnerCapture({
          ...params,
          locator: { sessionId, captureId: entry.captureId },
          principal: {
            organizationId: policy.organizationId,
            userId: policy.userId,
            authenticatedOwner: true,
          },
          roomId: policy.roomId,
          now,
        });
      } catch {
        if ((entry.cleanupAttempts ?? 0) + 1 < 3)
          next = Math.min(next ?? Infinity, now() + 60_000);
        else {
          await terminalStatus(
            params.storage,
            policy,
            { sessionId, captureId: entry.captureId },
            "cleanup-failed",
            now(),
          );
          cleanupExhausted += 1;
        }
      }
    }
  }
  // Keep immutable budget/terminal records; retire only fully cleaned session index entries.
  await params.storage.transaction(async (tx) => {
    const current = (await tx.get<string[]>(SESSION_INDEX)) ?? [];
    const retained: string[] = [];
    for (const sessionId of current) {
      const b = await tx.get<Budget>(budgetKey(sessionId));
      if (!b?.captures.every((entry) => entry.status === "deleted"))
        retained.push(sessionId);
    }
    await tx.put(SESSION_INDEX, retained);
  });
  return { nextDeadline: next, cleanupExhausted };
}

/** Private locator discovery; never decrypts or exports a model/tool payload. */
export async function listOwnerCaptureReservations(params: {
  storage: OwnerCaptureBudgetStorage;
  sessionId: string;
  principal: OwnerCapturePrincipal;
  roomId: string;
  now?: () => number;
}): Promise<{
  sessionId: string;
  admissionExpiresAt: number;
  retainUntil: number;
  captures: Reservation[];
}> {
  const b = await params.storage.transaction((tx) =>
    tx.get<Budget>(budgetKey(params.sessionId)),
  );
  const policy = b
    ? parseOwnerCapturePolicy(JSON.stringify(b.policy))
    : undefined;
  if (
    !b ||
    !policy ||
    policy.roomId !== params.roomId ||
    b.captures.length > 16 ||
    !(
      (params.principal.verifiedAdmin === true &&
        params.principal.userId === policy.readerUserId) ||
      (params.principal.authenticatedOwner &&
        matches(policy, { ...params.principal, roomId: params.roomId }))
    )
  ) {
    throw new Error("OWNER_CAPTURE_READ_FORBIDDEN");
  }
  if ((params.now ?? Date.now)() >= policy.retainUntil)
    throw new Error("OWNER_CAPTURE_READ_EXPIRED");
  return {
    sessionId: policy.sessionId,
    admissionExpiresAt: policy.expiresAt,
    retainUntil: policy.retainUntil,
    captures: b.captures.map((entry) => ({ ...entry })),
  };
}
