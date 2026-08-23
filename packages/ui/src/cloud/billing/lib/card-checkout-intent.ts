/**
 * Browser coordinator for durable Stripe card-checkout intent identity.
 *
 * A single strict record per organization is serialized through one global Web
 * Lock so tabs for the same authenticated user reuse one server idempotency key
 * without sharing checkout URLs. A user change rotates the slot because the
 * server pins each durable checkout order to its initiating user as well as org.
 * Every mutation is an exact compare-and-swap; unavailable or untrustworthy
 * browser coordination fails closed before callers perform network work.
 */

import { ElizaError } from "@elizaos/core/errors";
import { runAsPrivilegedShell } from "../../../surface-realm-channel";

export const CARD_CHECKOUT_INTENT_TTL_MS = 25 * 60 * 60 * 1000;
export const CARD_CHECKOUT_INTENT_STORAGE_PREFIX =
  "eliza:billing:card-checkout-intent:v1:";
export const CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY =
  "eliza:billing:card-checkout-tab-pointer:v1";
export const CARD_CHECKOUT_INTENT_LOCK_NAME =
  "eliza:billing:card-checkout-intent:v1";
export const CARD_CHECKOUT_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const CARD_CHECKOUT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/;
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

const INTENT_KEYS = [
  "version",
  "organizationId",
  "initiatedByUserId",
  "amountCents",
  "idempotencyKey",
  "createdAt",
  "staleAt",
  "sessionId",
] as const;

const POINTER_KEYS = [
  "version",
  "organizationId",
  "initiatedByUserId",
  "amountCents",
  "idempotencyKey",
  "sessionId",
] as const;

export type CardCheckoutIntentCoordinationErrorCode =
  | "CARD_CHECKOUT_COORDINATION_INVALID_INPUT"
  | "CARD_CHECKOUT_COORDINATION_STALE_AMOUNT_CONFLICT"
  | "CARD_CHECKOUT_COORDINATION_SESSION_MISMATCH"
  | "CARD_CHECKOUT_COORDINATION_STORAGE_UNAVAILABLE"
  | "CARD_CHECKOUT_COORDINATION_STORAGE_ACCESS_FAILED"
  | "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT"
  | "CARD_CHECKOUT_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH"
  | "CARD_CHECKOUT_COORDINATION_LOCK_UNAVAILABLE"
  | "CARD_CHECKOUT_COORDINATION_LOCK_TIMEOUT"
  | "CARD_CHECKOUT_COORDINATION_LOCK_FAILED"
  | "CARD_CHECKOUT_COORDINATION_UUID_UNAVAILABLE"
  | "CARD_CHECKOUT_COORDINATION_UUID_FAILED";

/** A fail-closed browser coordination error suitable for a visible UI state. */
export class CardCheckoutIntentCoordinationError extends ElizaError {
  override readonly name = "CardCheckoutIntentCoordinationError";
  override readonly code: CardCheckoutIntentCoordinationErrorCode;

  constructor(
    message: string,
    options: {
      code: CardCheckoutIntentCoordinationErrorCode;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, { ...options, severity: "ephemeral" });
    this.code = options.code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Validated public handle sent to the checkout endpoint as request identity. */
export interface CardCheckoutIntentHandle {
  organizationId: string;
  initiatedByUserId: string;
  amountCents: number;
  idempotencyKey: string;
  createdAt: number;
  staleAt: number;
  sessionId: string | null;
}

export interface ReserveCardCheckoutIntentInput {
  organizationId: string;
  initiatedByUserId: string;
  amountCents: number;
}

export interface ExactCardCheckoutIntentInput
  extends ReserveCardCheckoutIntentInput {
  idempotencyKey: string;
}

export interface BindCardCheckoutSessionInput
  extends ExactCardCheckoutIntentInput {
  sessionId: string;
}

export interface ClearVerifiedCardCheckoutSessionInput {
  sessionId: string;
}

export type CardCheckoutBindResult =
  | { status: "bound"; intent: CardCheckoutIntentHandle }
  | { status: "superseded" };

export type CardCheckoutExactClearResult =
  | { status: "cleared" }
  | { status: "superseded" };

export type CardCheckoutVerifiedClearResult =
  | { status: "cleared"; source: "tab-pointer" | "namespace-scan" }
  | { status: "not-found" };

export interface CardCheckoutIntentCoordinator {
  reserve(
    input: ReserveCardCheckoutIntentInput,
  ): Promise<CardCheckoutIntentHandle>;
  bindSession(
    input: BindCardCheckoutSessionInput,
  ): Promise<CardCheckoutBindResult>;
  clearDefinitiveRejection(
    input: ExactCardCheckoutIntentInput,
  ): Promise<CardCheckoutExactClearResult>;
  clearVerifiedSession(
    input: ClearVerifiedCardCheckoutSessionInput,
  ): Promise<CardCheckoutVerifiedClearResult>;
}

export interface CardCheckoutIntentStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface CardCheckoutIntentLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface CardCheckoutIntentDependencies {
  localStorage?: CardCheckoutIntentStorage | null;
  sessionStorage?: CardCheckoutIntentStorage | null;
  lockManager?: CardCheckoutIntentLockManager | null;
  now?: () => number;
  randomUUID?: () => string;
  lockTimeoutMs?: number;
}

interface PersistedCardCheckoutIntentV1 extends CardCheckoutIntentHandle {
  version: 1;
}

interface PersistedCardCheckoutTabPointerV1 {
  version: 1;
  organizationId: string;
  initiatedByUserId: string;
  amountCents: number;
  idempotencyKey: string;
  sessionId: string;
}

type StorageArea = "localStorage" | "sessionStorage";

function coordinationError(
  message: string,
  code: CardCheckoutIntentCoordinationErrorCode,
  context?: Record<string, unknown>,
  cause?: unknown,
): CardCheckoutIntentCoordinationError {
  return new CardCheckoutIntentCoordinationError(message, {
    code,
    context,
    cause,
  });
}

function isValidOrganizationId(value: unknown): value is string {
  return typeof value === "string" && ORGANIZATION_ID_PATTERN.test(value);
}

function validateOrganizationId(
  organizationId: unknown,
): asserts organizationId is string {
  if (!isValidOrganizationId(organizationId)) {
    throw coordinationError(
      "The billing organization identifier is invalid.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "organizationId" },
    );
  }
}

function isValidUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID_PATTERN.test(value);
}

function validateUserId(userId: unknown): asserts userId is string {
  if (!isValidUserId(userId)) {
    throw coordinationError(
      "The initiating billing user identifier is invalid.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "initiatedByUserId" },
    );
  }
}

function isValidAmountCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateAmountCents(
  amountCents: unknown,
): asserts amountCents is number {
  if (!isValidAmountCents(amountCents)) {
    throw coordinationError(
      "The card checkout amount must be a positive safe integer in cents.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "amountCents" },
    );
  }
}

function isValidIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CARD_CHECKOUT_IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

function validateIdempotencyKey(
  idempotencyKey: unknown,
): asserts idempotencyKey is string {
  if (!isValidIdempotencyKey(idempotencyKey)) {
    throw coordinationError(
      "The card checkout idempotency key violates the server contract.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "idempotencyKey" },
    );
  }
}

function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === "string" && CARD_CHECKOUT_SESSION_ID_PATTERN.test(value)
  );
}

function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (!isValidSessionId(sessionId)) {
    throw coordinationError(
      "The card checkout session identifier is invalid.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "sessionId" },
    );
  }
}

function isValidEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function persistedFieldError(
  area: StorageArea,
  key: string,
  field: string,
): CardCheckoutIntentCoordinationError {
  return coordinationError(
    "Persisted card checkout coordination data contains an invalid field.",
    "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
    { area, key, field },
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic localStorage key for the organization's sole checkout slot. */
export function cardCheckoutIntentStorageKey(organizationId: string): string {
  validateOrganizationId(organizationId);
  return `${CARD_CHECKOUT_INTENT_STORAGE_PREFIX}${organizationId}`;
}

function parseJson(raw: string, area: StorageArea, key: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 Malformed persisted JSON is an explicit invalid state.
    throw coordinationError(
      "Persisted card checkout coordination data is malformed.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area, key },
      cause,
    );
  }
}

function parseIntent(
  raw: string,
  key: string,
  expectedOrganizationId?: string,
): PersistedCardCheckoutIntentV1 {
  const value = parseJson(raw, "localStorage", key);
  if (!isRecord(value) || !hasExactKeys(value, INTENT_KEYS)) {
    throw coordinationError(
      "Persisted card checkout intent does not match the v1 schema.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "localStorage", key },
    );
  }
  if (value.version !== 1) {
    throw coordinationError(
      "Persisted card checkout intent has an unsupported version.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "localStorage", key },
    );
  }

  if (!isValidOrganizationId(value.organizationId)) {
    throw persistedFieldError("localStorage", key, "organizationId");
  }
  if (!isValidUserId(value.initiatedByUserId)) {
    throw persistedFieldError("localStorage", key, "initiatedByUserId");
  }
  if (!isValidAmountCents(value.amountCents)) {
    throw persistedFieldError("localStorage", key, "amountCents");
  }
  if (!isValidIdempotencyKey(value.idempotencyKey)) {
    throw persistedFieldError("localStorage", key, "idempotencyKey");
  }
  if (!isValidEpochMs(value.createdAt)) {
    throw persistedFieldError("localStorage", key, "createdAt");
  }
  if (!isValidEpochMs(value.staleAt)) {
    throw persistedFieldError("localStorage", key, "staleAt");
  }
  if (value.staleAt !== value.createdAt + CARD_CHECKOUT_INTENT_TTL_MS) {
    throw coordinationError(
      "Persisted card checkout intent has an invalid expiry boundary.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "localStorage", key, field: "staleAt" },
    );
  }
  if (value.sessionId !== null && !isValidSessionId(value.sessionId)) {
    throw persistedFieldError("localStorage", key, "sessionId");
  }
  if (
    expectedOrganizationId !== undefined &&
    value.organizationId !== expectedOrganizationId
  ) {
    throw coordinationError(
      "Persisted card checkout intent belongs to a different organization.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "localStorage", key },
    );
  }
  if (cardCheckoutIntentStorageKey(value.organizationId) !== key) {
    throw coordinationError(
      "Persisted card checkout intent is stored under the wrong organization slot.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "localStorage", key },
    );
  }

  return {
    version: 1,
    organizationId: value.organizationId,
    initiatedByUserId: value.initiatedByUserId,
    amountCents: value.amountCents,
    idempotencyKey: value.idempotencyKey,
    createdAt: value.createdAt,
    staleAt: value.staleAt,
    sessionId: value.sessionId,
  };
}

function parsePointer(raw: string): PersistedCardCheckoutTabPointerV1 {
  const key = CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY;
  const value = parseJson(raw, "sessionStorage", key);
  if (!isRecord(value) || !hasExactKeys(value, POINTER_KEYS)) {
    throw coordinationError(
      "Persisted card checkout tab pointer does not match the v1 schema.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "sessionStorage", key },
    );
  }
  if (value.version !== 1) {
    throw coordinationError(
      "Persisted card checkout tab pointer has an unsupported version.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "sessionStorage", key },
    );
  }

  if (!isValidOrganizationId(value.organizationId)) {
    throw persistedFieldError("sessionStorage", key, "organizationId");
  }
  if (!isValidUserId(value.initiatedByUserId)) {
    throw persistedFieldError("sessionStorage", key, "initiatedByUserId");
  }
  if (!isValidAmountCents(value.amountCents)) {
    throw persistedFieldError("sessionStorage", key, "amountCents");
  }
  if (!isValidIdempotencyKey(value.idempotencyKey)) {
    throw persistedFieldError("sessionStorage", key, "idempotencyKey");
  }
  if (!isValidSessionId(value.sessionId)) {
    throw persistedFieldError("sessionStorage", key, "sessionId");
  }
  return {
    version: 1,
    organizationId: value.organizationId,
    initiatedByUserId: value.initiatedByUserId,
    amountCents: value.amountCents,
    idempotencyKey: value.idempotencyKey,
    sessionId: value.sessionId,
  };
}

function publicHandle(
  intent: PersistedCardCheckoutIntentV1,
): CardCheckoutIntentHandle {
  return {
    organizationId: intent.organizationId,
    initiatedByUserId: intent.initiatedByUserId,
    amountCents: intent.amountCents,
    idempotencyKey: intent.idempotencyKey,
    createdAt: intent.createdAt,
    staleAt: intent.staleAt,
    sessionId: intent.sessionId,
  };
}

function sameExactIntent(
  intent: PersistedCardCheckoutIntentV1,
  input: ExactCardCheckoutIntentInput,
): boolean {
  return (
    intent.organizationId === input.organizationId &&
    intent.initiatedByUserId === input.initiatedByUserId &&
    intent.amountCents === input.amountCents &&
    intent.idempotencyKey === input.idempotencyKey
  );
}

function samePointer(
  left: PersistedCardCheckoutTabPointerV1,
  right: PersistedCardCheckoutTabPointerV1,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.initiatedByUserId === right.initiatedByUserId &&
    left.amountCents === right.amountCents &&
    left.idempotencyKey === right.idempotencyKey &&
    left.sessionId === right.sessionId
  );
}

function getStorageItem(
  storage: CardCheckoutIntentStorage,
  key: string,
  area: StorageArea,
): string | null {
  try {
    return storage.getItem(key);
  } catch (cause) {
    // error-policy:J2 Surface browser storage denial instead of treating it as empty.
    throw coordinationError(
      "Card checkout coordination storage could not be read.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ACCESS_FAILED",
      { area, key, operation: "read" },
      cause,
    );
  }
}

function setStorageItem(
  storage: CardCheckoutIntentStorage,
  key: string,
  raw: string,
  area: StorageArea,
): void {
  try {
    storage.setItem(key, raw);
  } catch (cause) {
    // error-policy:J2 Surface quota/privacy failures before checkout navigation.
    throw coordinationError(
      "Card checkout coordination storage could not be written.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ACCESS_FAILED",
      { area, key, operation: "write" },
      cause,
    );
  }
  const observed = getStorageItem(storage, key, area);
  if (observed !== raw) {
    throw coordinationError(
      "Card checkout coordination storage failed its write/read check.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH",
      { area, key },
    );
  }
}

function removeStorageItem(
  storage: CardCheckoutIntentStorage,
  key: string,
  area: StorageArea,
): void {
  try {
    storage.removeItem(key);
  } catch (cause) {
    // error-policy:J2 Surface deletion failures so callers never assume cleanup.
    throw coordinationError(
      "Card checkout coordination storage could not be cleared.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ACCESS_FAILED",
      { area, key, operation: "remove" },
      cause,
    );
  }
  if (getStorageItem(storage, key, area) !== null) {
    throw coordinationError(
      "Card checkout coordination storage failed its remove/read check.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH",
      { area, key },
    );
  }
}

function storageLength(
  storage: CardCheckoutIntentStorage,
  area: StorageArea,
): number {
  try {
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw coordinationError(
        "Card checkout coordination storage reported an invalid length.",
        "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
        { area, operation: "length" },
      );
    }
    return length;
  } catch (cause) {
    if (cause instanceof CardCheckoutIntentCoordinationError) throw cause;
    // error-policy:J2 Surface storage enumeration failures during exact cleanup.
    throw coordinationError(
      "Card checkout coordination storage could not be enumerated.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ACCESS_FAILED",
      { area, operation: "length" },
      cause,
    );
  }
}

function storageKey(
  storage: CardCheckoutIntentStorage,
  index: number,
  area: StorageArea,
): string | null {
  try {
    return storage.key(index);
  } catch (cause) {
    // error-policy:J2 Surface storage enumeration failures during exact cleanup.
    throw coordinationError(
      "Card checkout coordination storage key could not be read.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_ACCESS_FAILED",
      { area, index, operation: "key" },
      cause,
    );
  }
}

function readIntent(
  storage: CardCheckoutIntentStorage,
  organizationId: string,
): PersistedCardCheckoutIntentV1 | null {
  const key = cardCheckoutIntentStorageKey(organizationId);
  const raw = getStorageItem(storage, key, "localStorage");
  return raw === null ? null : parseIntent(raw, key, organizationId);
}

function writeIntent(
  storage: CardCheckoutIntentStorage,
  intent: PersistedCardCheckoutIntentV1,
): void {
  const key = cardCheckoutIntentStorageKey(intent.organizationId);
  const raw = JSON.stringify(intent);
  setStorageItem(storage, key, raw, "localStorage");
  parseIntent(raw, key, intent.organizationId);
}

function removeIntent(
  storage: CardCheckoutIntentStorage,
  organizationId: string,
): void {
  removeStorageItem(
    storage,
    cardCheckoutIntentStorageKey(organizationId),
    "localStorage",
  );
}

function readPointer(
  storage: CardCheckoutIntentStorage,
): PersistedCardCheckoutTabPointerV1 | null {
  const raw = getStorageItem(
    storage,
    CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY,
    "sessionStorage",
  );
  return raw === null ? null : parsePointer(raw);
}

function writePointer(
  storage: CardCheckoutIntentStorage,
  pointer: PersistedCardCheckoutTabPointerV1,
): void {
  const raw = JSON.stringify(pointer);
  setStorageItem(
    storage,
    CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY,
    raw,
    "sessionStorage",
  );
  parsePointer(raw);
}

function removePointerIfExact(
  storage: CardCheckoutIntentStorage,
  expected: PersistedCardCheckoutTabPointerV1,
): void {
  const current = readPointer(storage);
  if (!current || !samePointer(current, expected)) return;
  removeStorageItem(
    storage,
    CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY,
    "sessionStorage",
  );
}

interface BestEffortPointerState {
  pointer: PersistedCardCheckoutTabPointerV1 | null;
  storage: CardCheckoutIntentStorage;
}

/**
 * The localStorage intent is the sole checkout authority. The per-tab pointer
 * only accelerates exact success cleanup, so denied/corrupt sessionStorage must
 * fall back to the locked localStorage namespace scan rather than strand a
 * server-created checkout after POST.
 */
function readPointerBestEffort(
  dependencies: CardCheckoutIntentDependencies,
): BestEffortPointerState | null {
  try {
    const storage = resolveBrowserStorage(
      dependencies.sessionStorage,
      "sessionStorage",
    );
    return { pointer: readPointer(storage), storage };
  } catch (error) {
    // error-policy:J3 A denied/corrupt non-authoritative pointer falls back to the locked authority scan.
    if (error instanceof CardCheckoutIntentCoordinationError) return null;
    throw error;
  }
}

function writePointerBestEffort(
  dependencies: CardCheckoutIntentDependencies,
  pointer: PersistedCardCheckoutTabPointerV1,
): void {
  try {
    const storage = resolveBrowserStorage(
      dependencies.sessionStorage,
      "sessionStorage",
    );
    writePointer(storage, pointer);
  } catch (error) {
    // error-policy:J3 An unavailable pointer accelerator leaves the authoritative bound intent intact.
    if (error instanceof CardCheckoutIntentCoordinationError) return;
    throw error;
  }
}

function removePointerBestEffort(
  state: BestEffortPointerState | null,
  expected: PersistedCardCheckoutTabPointerV1,
): void {
  if (!state) return;
  try {
    removePointerIfExact(state.storage, expected);
  } catch (error) {
    if (error instanceof CardCheckoutIntentCoordinationError) {
      // error-policy:J6 Pointer teardown is best-effort and its failure is warned.
      console.warn(
        "[Billing checkout] Could not remove the non-authoritative session pointer",
        error,
      );
      return;
    }
    throw error;
  }
}

function resolveBrowserStorage(
  configured: CardCheckoutIntentStorage | null | undefined,
  area: StorageArea,
): CardCheckoutIntentStorage {
  if (configured !== undefined) {
    if (configured !== null) return configured;
    throw coordinationError(
      `Browser ${area} is unavailable for card checkout coordination.`,
      "CARD_CHECKOUT_COORDINATION_STORAGE_UNAVAILABLE",
      { area },
    );
  }
  if (typeof window === "undefined") {
    throw coordinationError(
      `Browser ${area} is unavailable outside a window.`,
      "CARD_CHECKOUT_COORDINATION_STORAGE_UNAVAILABLE",
      { area },
    );
  }
  try {
    const browserStorage =
      area === "localStorage" ? window.localStorage : window.sessionStorage;
    if (area === "sessionStorage") return browserStorage;

    // Billing owns a shell-reserved `eliza:*` namespace. Route only the
    // production localStorage mutations through the established privileged
    // channel; injected stores remain ordinary deterministic dependencies.
    return {
      get length() {
        return browserStorage.length;
      },
      getItem: (key) => browserStorage.getItem(key),
      key: (index) => browserStorage.key(index),
      removeItem: (key) =>
        runAsPrivilegedShell(() => browserStorage.removeItem(key)),
      setItem: (key, value) =>
        runAsPrivilegedShell(() => browserStorage.setItem(key, value)),
    };
  } catch (cause) {
    // error-policy:J2 Preserve privacy/security denial from the browser boundary.
    throw coordinationError(
      `Browser ${area} is unavailable for card checkout coordination.`,
      "CARD_CHECKOUT_COORDINATION_STORAGE_UNAVAILABLE",
      { area },
      cause,
    );
  }
}

function resolveLockManager(
  configured: CardCheckoutIntentLockManager | null | undefined,
): CardCheckoutIntentLockManager {
  if (configured !== undefined) {
    if (configured !== null) return configured;
    throw coordinationError(
      "Web Locks are unavailable for card checkout coordination.",
      "CARD_CHECKOUT_COORDINATION_LOCK_UNAVAILABLE",
    );
  }
  if (typeof navigator === "undefined" || globalThis.isSecureContext !== true) {
    throw coordinationError(
      "A secure Web Locks context is unavailable for card checkout coordination.",
      "CARD_CHECKOUT_COORDINATION_LOCK_UNAVAILABLE",
    );
  }
  try {
    const browserLocks = navigator.locks;
    if (!browserLocks) {
      throw coordinationError(
        "Web Locks are unavailable for card checkout coordination.",
        "CARD_CHECKOUT_COORDINATION_LOCK_UNAVAILABLE",
      );
    }
    return {
      request: (name, options, callback) =>
        browserLocks.request(name, options, callback),
    };
  } catch (cause) {
    if (cause instanceof CardCheckoutIntentCoordinationError) throw cause;
    // error-policy:J2 Preserve browser capability-access denial as unavailable.
    throw coordinationError(
      "Web Locks are unavailable for card checkout coordination.",
      "CARD_CHECKOUT_COORDINATION_LOCK_UNAVAILABLE",
      undefined,
      cause,
    );
  }
}

function resolveNow(now: (() => number) | undefined): number {
  let value: number;
  try {
    value = (now ?? Date.now)();
  } catch (cause) {
    // error-policy:J2 Preserve an injected/browser clock failure as invalid input.
    throw coordinationError(
      "The card checkout coordination clock failed.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "now" },
      cause,
    );
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw coordinationError(
      "The card checkout coordination clock returned an invalid timestamp.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "now" },
    );
  }
  if (!Number.isSafeInteger(value + CARD_CHECKOUT_INTENT_TTL_MS)) {
    throw coordinationError(
      "The card checkout coordination expiry exceeds the safe timestamp range.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "now" },
    );
  }
  return value;
}

function createIdempotencyKey(randomUUID: (() => string) | undefined): string {
  let value: string;
  try {
    if (randomUUID) {
      value = randomUUID();
    } else {
      if (!globalThis.crypto?.randomUUID) {
        throw coordinationError(
          "Secure UUID generation is unavailable for card checkout coordination.",
          "CARD_CHECKOUT_COORDINATION_UUID_UNAVAILABLE",
        );
      }
      value = globalThis.crypto.randomUUID();
    }
  } catch (cause) {
    if (cause instanceof CardCheckoutIntentCoordinationError) throw cause;
    // error-policy:J2 Preserve secure random generation failure and block checkout.
    throw coordinationError(
      "A card checkout idempotency key could not be generated.",
      "CARD_CHECKOUT_COORDINATION_UUID_FAILED",
      undefined,
      cause,
    );
  }
  validateIdempotencyKey(value);
  return value;
}

function validateLockTimeout(lockTimeoutMs: number | undefined): number {
  const value = lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw coordinationError(
      "The card checkout coordination lock timeout is invalid.",
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      { field: "lockTimeoutMs" },
    );
  }
  return value;
}

async function withGlobalLock<T>(
  dependencies: CardCheckoutIntentDependencies,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  const lockManager = resolveLockManager(dependencies.lockManager);
  const timeoutMs = validateLockTimeout(dependencies.lockTimeoutMs);
  const abortController = new AbortController();
  let acquired = false;
  const timeout = setTimeout(() => {
    if (!acquired) abortController.abort();
  }, timeoutMs);

  try {
    const result = await lockManager.request(
      CARD_CHECKOUT_INTENT_LOCK_NAME,
      { mode: "exclusive", signal: abortController.signal },
      async () => {
        if (acquired) {
          throw coordinationError(
            "The Web Lock callback ran more than once.",
            "CARD_CHECKOUT_COORDINATION_LOCK_FAILED",
          );
        }
        acquired = true;
        clearTimeout(timeout);
        return operation();
      },
    );
    if (!acquired) {
      throw coordinationError(
        "The Web Lock request completed without exclusive ownership.",
        "CARD_CHECKOUT_COORDINATION_LOCK_FAILED",
      );
    }
    return result;
  } catch (cause) {
    if (cause instanceof CardCheckoutIntentCoordinationError) throw cause;
    if (abortController.signal.aborted && !acquired) {
      // error-policy:J2 Translate bounded Web Lock expiry to a stable typed error.
      throw coordinationError(
        "Timed out waiting for exclusive card checkout coordination.",
        "CARD_CHECKOUT_COORDINATION_LOCK_TIMEOUT",
        { timeoutMs },
        cause,
      );
    }
    // error-policy:J2 Preserve browser Web Lock failure and block network work.
    throw coordinationError(
      "Exclusive card checkout coordination failed.",
      "CARD_CHECKOUT_COORDINATION_LOCK_FAILED",
      undefined,
      cause,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function findIntentBySessionId(
  storage: CardCheckoutIntentStorage,
  sessionId: string,
): PersistedCardCheckoutIntentV1 | null {
  const matches: PersistedCardCheckoutIntentV1[] = [];
  const length = storageLength(storage, "localStorage");
  for (let index = 0; index < length; index += 1) {
    const key = storageKey(storage, index, "localStorage");
    if (key === null) {
      throw coordinationError(
        "Card checkout coordination storage changed during its locked scan.",
        "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
        { area: "localStorage", index },
      );
    }
    if (!key.startsWith(CARD_CHECKOUT_INTENT_STORAGE_PREFIX)) continue;
    const raw = getStorageItem(storage, key, "localStorage");
    if (raw === null) {
      throw coordinationError(
        "A card checkout intent disappeared during its locked scan.",
        "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
        { area: "localStorage", key },
      );
    }
    const intent = parseIntent(raw, key);
    if (intent.sessionId === sessionId) matches.push(intent);
  }
  if (matches.length > 1) {
    throw coordinationError(
      "A checkout session is bound to more than one organization slot.",
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
      { area: "localStorage", matchCount: matches.length },
    );
  }
  return matches[0] ?? null;
}

/**
 * Creates a coordinator. Dependencies stay lazy so the exported browser
 * singleton remains safe to import during server rendering.
 */
export function createCardCheckoutIntentCoordinator(
  dependencies: CardCheckoutIntentDependencies = {},
): CardCheckoutIntentCoordinator {
  return {
    reserve: async ({ organizationId, initiatedByUserId, amountCents }) => {
      validateOrganizationId(organizationId);
      validateUserId(initiatedByUserId);
      validateAmountCents(amountCents);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(
          dependencies.localStorage,
          "localStorage",
        );
        const existing = readIntent(storage, organizationId);
        if (
          existing?.initiatedByUserId === initiatedByUserId &&
          existing.amountCents === amountCents
        ) {
          return publicHandle(existing);
        }

        const now = resolveNow(dependencies.now);
        if (
          existing?.initiatedByUserId === initiatedByUserId &&
          now >= existing.staleAt
        ) {
          throw coordinationError(
            "A stale checkout intent for a different amount requires explicit reconciliation.",
            "CARD_CHECKOUT_COORDINATION_STALE_AMOUNT_CONFLICT",
            { organizationId },
          );
        }

        const intent: PersistedCardCheckoutIntentV1 = {
          version: 1,
          organizationId,
          initiatedByUserId,
          amountCents,
          idempotencyKey: createIdempotencyKey(dependencies.randomUUID),
          createdAt: now,
          staleAt: now + CARD_CHECKOUT_INTENT_TTL_MS,
          sessionId: null,
        };
        writeIntent(storage, intent);
        return publicHandle(intent);
      });
    },

    bindSession: async (input) => {
      validateOrganizationId(input.organizationId);
      validateUserId(input.initiatedByUserId);
      validateAmountCents(input.amountCents);
      validateIdempotencyKey(input.idempotencyKey);
      validateSessionId(input.sessionId);
      return withGlobalLock(dependencies, () => {
        const localStorage = resolveBrowserStorage(
          dependencies.localStorage,
          "localStorage",
        );
        const current = readIntent(localStorage, input.organizationId);
        if (!current || !sameExactIntent(current, input)) {
          return { status: "superseded" } as const;
        }
        if (
          current.sessionId !== null &&
          current.sessionId !== input.sessionId
        ) {
          throw coordinationError(
            "One idempotency key resolved to conflicting checkout sessions.",
            "CARD_CHECKOUT_COORDINATION_SESSION_MISMATCH",
            { organizationId: input.organizationId },
          );
        }
        const bound: PersistedCardCheckoutIntentV1 = {
          ...current,
          sessionId: input.sessionId,
        };
        if (current.sessionId === null) writeIntent(localStorage, bound);
        writePointerBestEffort(dependencies, {
          version: 1,
          organizationId: input.organizationId,
          initiatedByUserId: input.initiatedByUserId,
          amountCents: input.amountCents,
          idempotencyKey: input.idempotencyKey,
          sessionId: input.sessionId,
        });
        return { status: "bound", intent: publicHandle(bound) } as const;
      });
    },

    clearDefinitiveRejection: async (input) => {
      validateOrganizationId(input.organizationId);
      validateUserId(input.initiatedByUserId);
      validateAmountCents(input.amountCents);
      validateIdempotencyKey(input.idempotencyKey);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(
          dependencies.localStorage,
          "localStorage",
        );
        const current = readIntent(storage, input.organizationId);
        if (
          !current ||
          !sameExactIntent(current, input) ||
          current.sessionId !== null
        ) {
          return { status: "superseded" } as const;
        }
        removeIntent(storage, input.organizationId);
        return { status: "cleared" } as const;
      });
    },

    clearVerifiedSession: async ({ sessionId }) => {
      validateSessionId(sessionId);
      return withGlobalLock(dependencies, () => {
        const localStorage = resolveBrowserStorage(
          dependencies.localStorage,
          "localStorage",
        );
        const pointerState = readPointerBestEffort(dependencies);
        const pointer = pointerState?.pointer ?? null;

        if (pointer?.sessionId === sessionId) {
          const pointedIntent = readIntent(
            localStorage,
            pointer.organizationId,
          );
          if (
            pointedIntent &&
            sameExactIntent(pointedIntent, pointer) &&
            pointedIntent.sessionId === sessionId
          ) {
            removeIntent(localStorage, pointer.organizationId);
            removePointerBestEffort(pointerState, pointer);
            return { status: "cleared", source: "tab-pointer" } as const;
          }
        }

        const scannedIntent = findIntentBySessionId(localStorage, sessionId);
        if (scannedIntent) {
          const current = readIntent(
            localStorage,
            scannedIntent.organizationId,
          );
          if (
            current &&
            sameExactIntent(current, scannedIntent) &&
            current.sessionId === sessionId
          ) {
            removeIntent(localStorage, current.organizationId);
            if (pointer?.sessionId === sessionId) {
              removePointerBestEffort(pointerState, pointer);
            }
            return { status: "cleared", source: "namespace-scan" } as const;
          }
        }

        if (pointer?.sessionId === sessionId) {
          removePointerBestEffort(pointerState, pointer);
        }
        return { status: "not-found" } as const;
      });
    },
  };
}

/** Lazy production coordinator backed by browser storage, UUIDs, and Web Locks. */
export const browserCardCheckoutIntentCoordinator =
  createCardCheckoutIntentCoordinator();
