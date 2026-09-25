/**
 * Browser coordinator for one durable billable-resource cancellation intent.
 *
 * Each organization/resource pair owns one strict localStorage slot. The
 * authenticated user, lifecycle revision, and server-projected endpoint are
 * part of the exact intent identity, so a changed authority rotates an unbound
 * idempotency key. A receipt already bound for the same principal and resource
 * survives revision or endpoint drift until it reaches a terminal state. Every
 * mutation runs under one Web Lock and uses exact compare-and-swap semantics.
 * Missing browser capabilities fail closed before callers perform network
 * work.
 */

import { ElizaError } from "@elizaos/core/errors";
import { runAsPrivilegedShell } from "../../../surface-realm-channel";

export const BILLING_CANCEL_INTENT_STORAGE_PREFIX =
  "eliza:billing:cancel-intent:v1:";
export const BILLING_CANCEL_INTENT_LOCK_NAME = "eliza:billing:cancel-intent:v1";
export const BILLING_CANCEL_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERSISTED_INTENT_KEYS = [
  "version",
  "organizationId",
  "initiatedByUserId",
  "resourceType",
  "resourceId",
  "expectedLifecycleRevision",
  "endpoint",
  "idempotencyKey",
  "receiptId",
  "pollEndpoint",
] as const;

export type BillingCancelResourceType = "container" | "agent_sandbox";

export type BillingCancelIntentCoordinationErrorCode =
  | "BILLING_CANCEL_COORDINATION_INVALID_INPUT"
  | "BILLING_CANCEL_COORDINATION_STORAGE_UNAVAILABLE"
  | "BILLING_CANCEL_COORDINATION_STORAGE_ACCESS_FAILED"
  | "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT"
  | "BILLING_CANCEL_COORDINATION_STORAGE_FORWARD_VERSION"
  | "BILLING_CANCEL_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH"
  | "BILLING_CANCEL_COORDINATION_LOCK_UNAVAILABLE"
  | "BILLING_CANCEL_COORDINATION_LOCK_TIMEOUT"
  | "BILLING_CANCEL_COORDINATION_LOCK_FAILED"
  | "BILLING_CANCEL_COORDINATION_UUID_UNAVAILABLE"
  | "BILLING_CANCEL_COORDINATION_UUID_FAILED"
  | "BILLING_CANCEL_COORDINATION_RECEIPT_MISMATCH";

/** Fail-closed browser coordination failure suitable for a visible UI state. */
export class BillingCancelIntentCoordinationError extends ElizaError {
  override readonly name = "BillingCancelIntentCoordinationError";
  override readonly code: BillingCancelIntentCoordinationErrorCode;

  constructor(
    message: string,
    options: {
      code: BillingCancelIntentCoordinationErrorCode;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, { ...options, severity: "ephemeral" });
    this.code = options.code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Exact server-owned cancellation identity. Transport mode is always `stop`. */
export interface BillingCancelIntentIdentity {
  organizationId: string;
  initiatedByUserId: string;
  resourceType: BillingCancelResourceType;
  resourceId: string;
  expectedLifecycleRevision: number;
  endpoint: string;
}

/** Validated handle used to issue or resume one cancellation request. */
export interface BillingCancelIntentHandle extends BillingCancelIntentIdentity {
  idempotencyKey: string;
  receiptId: string | null;
  pollEndpoint: string | null;
}

/** A strictly parsed durable intent whose cancellation receipt is bound. */
export interface BillingCancelBoundIntentHandle
  extends BillingCancelIntentHandle {
  receiptId: string;
  pollEndpoint: string;
}

export interface ExactBillingCancelIntentInput
  extends BillingCancelIntentIdentity {
  idempotencyKey: string;
}

export interface BindBillingCancelReceiptInput
  extends ExactBillingCancelIntentInput {
  receiptId: string;
  pollEndpoint: string;
}

export interface ClearTerminalBillingCancelIntentInput
  extends ExactBillingCancelIntentInput {
  receiptId: string;
}

export type BillingCancelReceiptBindResult =
  | { status: "bound"; intent: BillingCancelIntentHandle }
  | { status: "superseded" };

export type BillingCancelTerminalClearResult =
  | { status: "cleared" }
  | { status: "superseded" };

export interface BillingCancelIntentCoordinator {
  reserve(
    identity: BillingCancelIntentIdentity,
  ): Promise<BillingCancelIntentHandle>;
  readExact(
    identity: BillingCancelIntentIdentity,
  ): Promise<BillingCancelIntentHandle | null>;
  readBoundForResource(
    identity: BillingCancelIntentIdentity,
  ): Promise<BillingCancelBoundIntentHandle | null>;
  bindReceipt(
    input: BindBillingCancelReceiptInput,
  ): Promise<BillingCancelReceiptBindResult>;
  clearTerminal(
    input: ClearTerminalBillingCancelIntentInput,
  ): Promise<BillingCancelTerminalClearResult>;
}

export interface BillingCancelIntentStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface BillingCancelIntentLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface BillingCancelIntentDependencies {
  localStorage?: BillingCancelIntentStorage | null;
  lockManager?: BillingCancelIntentLockManager | null;
  randomUUID?: (() => string) | null;
  lockTimeoutMs?: number;
}

interface PersistedBillingCancelIntentV1 extends BillingCancelIntentHandle {
  version: 1;
}

function coordinationError(
  message: string,
  code: BillingCancelIntentCoordinationErrorCode,
  context?: Record<string, unknown>,
  cause?: unknown,
): BillingCancelIntentCoordinationError {
  return new BillingCancelIntentCoordinationError(message, {
    code,
    context,
    cause,
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validateId(value: unknown, field: string): asserts value is string {
  if (!isValidId(value)) {
    throw coordinationError(
      `The billing cancellation ${field} is invalid.`,
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field },
    );
  }
}

function isValidResourceType(
  value: unknown,
): value is BillingCancelResourceType {
  return value === "container" || value === "agent_sandbox";
}

function validateResourceType(
  value: unknown,
): asserts value is BillingCancelResourceType {
  if (!isValidResourceType(value)) {
    throw coordinationError(
      "The billing cancellation resource type is invalid.",
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field: "resourceType" },
    );
  }
}

function isValidLifecycleRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateLifecycleRevision(value: unknown): asserts value is number {
  if (!isValidLifecycleRevision(value)) {
    throw coordinationError(
      "The billing cancellation lifecycle revision is invalid.",
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field: "expectedLifecycleRevision" },
    );
  }
}

function isValidApiEndpoint(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("/api/") ||
    value.startsWith("//") ||
    /[\\\r\n\t#]/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://billing-coordinator.invalid");
    return (
      parsed.origin === "https://billing-coordinator.invalid" &&
      parsed.hash === "" &&
      parsed.pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
}

function validateEndpoint(
  value: unknown,
  field: string,
): asserts value is string {
  if (!isValidApiEndpoint(value)) {
    throw coordinationError(
      `The billing cancellation ${field} is invalid.`,
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field },
    );
  }
}

function isValidIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BILLING_CANCEL_IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

function validateIdempotencyKey(value: unknown): asserts value is string {
  if (!isValidIdempotencyKey(value)) {
    throw coordinationError(
      "The billing cancellation idempotency key is invalid.",
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field: "idempotencyKey" },
    );
  }
}

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validateReceiptId(value: unknown): asserts value is string {
  if (!isValidUuid(value)) {
    throw coordinationError(
      "The billing cancellation receipt identifier is invalid.",
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field: "receiptId" },
    );
  }
}

function validatePollEndpoint(
  pollEndpoint: unknown,
  requestEndpoint: string,
  receiptId: string,
): asserts pollEndpoint is string {
  validateEndpoint(pollEndpoint, "poll endpoint");
  const poll = new URL(pollEndpoint, "https://billing-coordinator.invalid");
  const request = new URL(
    requestEndpoint,
    "https://billing-coordinator.invalid",
  );
  if (
    poll.pathname !== request.pathname ||
    poll.searchParams.getAll("receiptId").length !== 1 ||
    poll.searchParams.get("receiptId") !== receiptId
  ) {
    throw coordinationError(
      "The billing cancellation poll endpoint does not match its receipt.",
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field: "pollEndpoint" },
    );
  }
}

function validateIdentity(
  identity: BillingCancelIntentIdentity,
): asserts identity is BillingCancelIntentIdentity {
  validateId(identity.organizationId, "organization identifier");
  validateId(identity.initiatedByUserId, "initiating user identifier");
  validateResourceType(identity.resourceType);
  validateId(identity.resourceId, "resource identifier");
  validateLifecycleRevision(identity.expectedLifecycleRevision);
  validateEndpoint(identity.endpoint, "request endpoint");
}

/** Deterministic slot shared by all revisions and users of one resource. */
export function billingCancelIntentStorageKey(
  identity: Pick<
    BillingCancelIntentIdentity,
    "organizationId" | "resourceType" | "resourceId"
  >,
): string {
  validateId(identity.organizationId, "organization identifier");
  validateResourceType(identity.resourceType);
  validateId(identity.resourceId, "resource identifier");
  return `${BILLING_CANCEL_INTENT_STORAGE_PREFIX}${encodeURIComponent(identity.organizationId)}:${identity.resourceType}:${encodeURIComponent(identity.resourceId)}`;
}

function sameIdentity(
  intent: BillingCancelIntentHandle,
  identity: BillingCancelIntentIdentity,
): boolean {
  return (
    intent.organizationId === identity.organizationId &&
    intent.initiatedByUserId === identity.initiatedByUserId &&
    intent.resourceType === identity.resourceType &&
    intent.resourceId === identity.resourceId &&
    intent.expectedLifecycleRevision === identity.expectedLifecycleRevision &&
    intent.endpoint === identity.endpoint
  );
}

function sameResourcePrincipal(
  intent: BillingCancelIntentHandle,
  identity: BillingCancelIntentIdentity,
): boolean {
  return (
    intent.organizationId === identity.organizationId &&
    intent.initiatedByUserId === identity.initiatedByUserId &&
    intent.resourceType === identity.resourceType &&
    intent.resourceId === identity.resourceId
  );
}

function sameExactIntent(
  intent: BillingCancelIntentHandle,
  input: ExactBillingCancelIntentInput,
): boolean {
  return (
    sameIdentity(intent, input) &&
    intent.idempotencyKey === input.idempotencyKey
  );
}

function publicHandle(
  intent: PersistedBillingCancelIntentV1,
): BillingCancelIntentHandle {
  return {
    organizationId: intent.organizationId,
    initiatedByUserId: intent.initiatedByUserId,
    resourceType: intent.resourceType,
    resourceId: intent.resourceId,
    expectedLifecycleRevision: intent.expectedLifecycleRevision,
    endpoint: intent.endpoint,
    idempotencyKey: intent.idempotencyKey,
    receiptId: intent.receiptId,
    pollEndpoint: intent.pollEndpoint,
  };
}

function publicBoundHandle(
  intent: PersistedBillingCancelIntentV1,
): BillingCancelBoundIntentHandle | null {
  if (intent.receiptId === null || intent.pollEndpoint === null) return null;
  return {
    ...publicHandle(intent),
    receiptId: intent.receiptId,
    pollEndpoint: intent.pollEndpoint,
  };
}

function parsePersistedIntent(
  raw: string,
  key: string,
): PersistedBillingCancelIntentV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw coordinationError(
      "Persisted billing cancellation coordination data is malformed.",
      "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT",
      { key },
      cause,
    );
  }
  if (!isRecord(value) || !hasExactKeys(value, PERSISTED_INTENT_KEYS)) {
    throw coordinationError(
      "Persisted billing cancellation data does not match the v1 schema.",
      "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT",
      { key },
    );
  }
  if (value.version !== 1) {
    throw coordinationError(
      "Persisted billing cancellation data has an unsupported version.",
      "BILLING_CANCEL_COORDINATION_STORAGE_FORWARD_VERSION",
      { key },
    );
  }

  const identity = {
    organizationId: value.organizationId,
    initiatedByUserId: value.initiatedByUserId,
    resourceType: value.resourceType,
    resourceId: value.resourceId,
    expectedLifecycleRevision: value.expectedLifecycleRevision,
    endpoint: value.endpoint,
  } as BillingCancelIntentIdentity;
  try {
    validateIdentity(identity);
    validateIdempotencyKey(value.idempotencyKey);
    if (value.receiptId !== null) validateReceiptId(value.receiptId);
    if (value.receiptId === null) {
      if (value.pollEndpoint !== null) throw new Error("orphan poll endpoint");
    } else {
      validatePollEndpoint(
        value.pollEndpoint,
        identity.endpoint,
        value.receiptId,
      );
    }
  } catch (cause) {
    if (
      cause instanceof BillingCancelIntentCoordinationError &&
      cause.code === "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT"
    ) {
      throw cause;
    }
    throw coordinationError(
      "Persisted billing cancellation data contains an invalid field.",
      "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT",
      { key },
      cause,
    );
  }

  const intent: PersistedBillingCancelIntentV1 = {
    version: 1,
    ...identity,
    idempotencyKey: value.idempotencyKey as string,
    receiptId: value.receiptId as string | null,
    pollEndpoint: value.pollEndpoint as string | null,
  };
  if (billingCancelIntentStorageKey(intent) !== key) {
    throw coordinationError(
      "Persisted billing cancellation data is stored under the wrong resource slot.",
      "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT",
      { key },
    );
  }
  return intent;
}

function getStorageItem(
  storage: BillingCancelIntentStorage,
  key: string,
): string | null {
  try {
    return storage.getItem(key);
  } catch (cause) {
    throw coordinationError(
      "Billing cancellation coordination storage could not be read.",
      "BILLING_CANCEL_COORDINATION_STORAGE_ACCESS_FAILED",
      { key, operation: "read" },
      cause,
    );
  }
}

function setStorageItem(
  storage: BillingCancelIntentStorage,
  key: string,
  raw: string,
): void {
  try {
    runAsPrivilegedShell(() => storage.setItem(key, raw));
  } catch (cause) {
    throw coordinationError(
      "Billing cancellation coordination storage could not be written.",
      "BILLING_CANCEL_COORDINATION_STORAGE_ACCESS_FAILED",
      { key, operation: "write" },
      cause,
    );
  }
  if (getStorageItem(storage, key) !== raw) {
    throw coordinationError(
      "Billing cancellation storage failed its write/read check.",
      "BILLING_CANCEL_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH",
      { key },
    );
  }
}

function removeStorageItem(
  storage: BillingCancelIntentStorage,
  key: string,
): void {
  try {
    runAsPrivilegedShell(() => storage.removeItem(key));
  } catch (cause) {
    throw coordinationError(
      "Billing cancellation coordination storage could not be cleared.",
      "BILLING_CANCEL_COORDINATION_STORAGE_ACCESS_FAILED",
      { key, operation: "remove" },
      cause,
    );
  }
  if (getStorageItem(storage, key) !== null) {
    throw coordinationError(
      "Billing cancellation storage failed its remove/read check.",
      "BILLING_CANCEL_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH",
      { key },
    );
  }
}

function readSlot(
  storage: BillingCancelIntentStorage,
  identity: Pick<
    BillingCancelIntentIdentity,
    "organizationId" | "resourceType" | "resourceId"
  >,
): PersistedBillingCancelIntentV1 | null {
  const key = billingCancelIntentStorageKey(identity);
  const raw = getStorageItem(storage, key);
  if (raw === null) return null;
  try {
    return parsePersistedIntent(raw, key);
  } catch (cause) {
    if (
      !(cause instanceof BillingCancelIntentCoordinationError) ||
      ![
        "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT",
        "BILLING_CANCEL_COORDINATION_STORAGE_FORWARD_VERSION",
      ].includes(cause.code)
    ) {
      throw cause;
    }
    const quarantineKey = `${key}:quarantine:v1`;
    setStorageItem(
      storage,
      quarantineKey,
      JSON.stringify({
        version: 1,
        quarantinedAt: new Date().toISOString(),
        reason: cause.code,
        raw,
      }),
    );
    removeStorageItem(storage, key);
    return null;
  }
}

function writeSlot(
  storage: BillingCancelIntentStorage,
  intent: PersistedBillingCancelIntentV1,
): void {
  const key = billingCancelIntentStorageKey(intent);
  const raw = JSON.stringify(intent);
  setStorageItem(storage, key, raw);
  parsePersistedIntent(raw, key);
}

function resolveBrowserStorage(
  configured: BillingCancelIntentStorage | null | undefined,
): BillingCancelIntentStorage {
  if (configured !== undefined) {
    if (configured !== null) return configured;
    throw coordinationError(
      "Browser localStorage is unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_STORAGE_UNAVAILABLE",
    );
  }
  if (typeof window === "undefined") {
    throw coordinationError(
      "Browser localStorage is unavailable outside a window.",
      "BILLING_CANCEL_COORDINATION_STORAGE_UNAVAILABLE",
    );
  }
  try {
    const browserStorage = window.localStorage;
    return {
      getItem: (key) => browserStorage.getItem(key),
      removeItem: (key) =>
        runAsPrivilegedShell(() => browserStorage.removeItem(key)),
      setItem: (key, value) =>
        runAsPrivilegedShell(() => browserStorage.setItem(key, value)),
    };
  } catch (cause) {
    throw coordinationError(
      "Browser localStorage is unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_STORAGE_UNAVAILABLE",
      undefined,
      cause,
    );
  }
}

function resolveLockManager(
  configured: BillingCancelIntentLockManager | null | undefined,
): BillingCancelIntentLockManager {
  if (configured !== undefined) {
    if (configured !== null) return configured;
    throw coordinationError(
      "Web Locks are unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_LOCK_UNAVAILABLE",
    );
  }
  if (typeof navigator === "undefined" || globalThis.isSecureContext !== true) {
    throw coordinationError(
      "A secure Web Locks context is unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_LOCK_UNAVAILABLE",
    );
  }
  try {
    const browserLocks = navigator.locks;
    if (!browserLocks) {
      throw coordinationError(
        "Web Locks are unavailable for billing cancellation coordination.",
        "BILLING_CANCEL_COORDINATION_LOCK_UNAVAILABLE",
      );
    }
    return {
      request: (name, options, callback) =>
        browserLocks.request(name, options, callback),
    };
  } catch (cause) {
    if (cause instanceof BillingCancelIntentCoordinationError) throw cause;
    throw coordinationError(
      "Web Locks are unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_LOCK_UNAVAILABLE",
      undefined,
      cause,
    );
  }
}

function validateLockTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw coordinationError(
      "The billing cancellation coordination lock timeout is invalid.",
      "BILLING_CANCEL_COORDINATION_INVALID_INPUT",
      { field: "lockTimeoutMs" },
    );
  }
  return timeoutMs;
}

async function withGlobalLock<T>(
  dependencies: BillingCancelIntentDependencies,
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
      BILLING_CANCEL_INTENT_LOCK_NAME,
      { mode: "exclusive", signal: abortController.signal },
      async () => {
        if (acquired) {
          throw coordinationError(
            "The Web Lock callback ran more than once.",
            "BILLING_CANCEL_COORDINATION_LOCK_FAILED",
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
        "BILLING_CANCEL_COORDINATION_LOCK_FAILED",
      );
    }
    return result;
  } catch (cause) {
    if (cause instanceof BillingCancelIntentCoordinationError) throw cause;
    if (abortController.signal.aborted && !acquired) {
      throw coordinationError(
        "Timed out waiting for exclusive billing cancellation coordination.",
        "BILLING_CANCEL_COORDINATION_LOCK_TIMEOUT",
        { timeoutMs },
        cause,
      );
    }
    throw coordinationError(
      "Exclusive billing cancellation coordination failed.",
      "BILLING_CANCEL_COORDINATION_LOCK_FAILED",
      undefined,
      cause,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function createIdempotencyKey(
  configured: (() => string) | null | undefined,
): string {
  if (configured === null) {
    throw coordinationError(
      "Secure UUID generation is unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_UUID_UNAVAILABLE",
    );
  }
  const randomUUID =
    configured ?? globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!randomUUID) {
    throw coordinationError(
      "Secure UUID generation is unavailable for billing cancellation coordination.",
      "BILLING_CANCEL_COORDINATION_UUID_UNAVAILABLE",
    );
  }
  let value: string;
  try {
    value = randomUUID();
  } catch (cause) {
    throw coordinationError(
      "A billing cancellation idempotency key could not be generated.",
      "BILLING_CANCEL_COORDINATION_UUID_FAILED",
      undefined,
      cause,
    );
  }
  if (!UUID_PATTERN.test(value)) {
    throw coordinationError(
      "Secure UUID generation returned an invalid billing cancellation key.",
      "BILLING_CANCEL_COORDINATION_UUID_FAILED",
    );
  }
  return value;
}

/**
 * Creates a coordinator. Browser dependencies stay lazy so importing this
 * module remains safe during server rendering.
 */
export function createBillingCancelIntentCoordinator(
  dependencies: BillingCancelIntentDependencies = {},
): BillingCancelIntentCoordinator {
  return {
    reserve: async (identity) => {
      validateIdentity(identity);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(dependencies.localStorage);
        const existing = readSlot(storage, identity);
        if (existing && sameIdentity(existing, identity)) {
          return publicHandle(existing);
        }
        if (existing && sameResourcePrincipal(existing, identity)) {
          const bound = publicBoundHandle(existing);
          if (bound) return bound;
        }
        const intent: PersistedBillingCancelIntentV1 = {
          version: 1,
          ...identity,
          idempotencyKey: createIdempotencyKey(dependencies.randomUUID),
          receiptId: null,
          pollEndpoint: null,
        };
        writeSlot(storage, intent);
        return publicHandle(intent);
      });
    },

    readExact: async (identity) => {
      validateIdentity(identity);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(dependencies.localStorage);
        const current = readSlot(storage, identity);
        return current && sameIdentity(current, identity)
          ? publicHandle(current)
          : null;
      });
    },

    readBoundForResource: async (identity) => {
      validateIdentity(identity);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(dependencies.localStorage);
        const current = readSlot(storage, identity);
        return current && sameResourcePrincipal(current, identity)
          ? publicBoundHandle(current)
          : null;
      });
    },

    bindReceipt: async (input) => {
      validateIdentity(input);
      validateIdempotencyKey(input.idempotencyKey);
      validateReceiptId(input.receiptId);
      validatePollEndpoint(input.pollEndpoint, input.endpoint, input.receiptId);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(dependencies.localStorage);
        const current = readSlot(storage, input);
        if (!current || !sameExactIntent(current, input)) {
          return { status: "superseded" } as const;
        }
        if (
          current.receiptId !== null &&
          (current.receiptId !== input.receiptId ||
            current.pollEndpoint !== input.pollEndpoint)
        ) {
          throw coordinationError(
            "One cancellation idempotency key resolved to conflicting receipts.",
            "BILLING_CANCEL_COORDINATION_RECEIPT_MISMATCH",
            {
              organizationId: input.organizationId,
              resourceId: input.resourceId,
            },
          );
        }
        const bound: PersistedBillingCancelIntentV1 = {
          ...current,
          receiptId: input.receiptId,
          pollEndpoint: input.pollEndpoint,
        };
        if (current.receiptId === null) writeSlot(storage, bound);
        return { status: "bound", intent: publicHandle(bound) } as const;
      });
    },

    clearTerminal: async (input) => {
      validateIdentity(input);
      validateIdempotencyKey(input.idempotencyKey);
      validateReceiptId(input.receiptId);
      return withGlobalLock(dependencies, () => {
        const storage = resolveBrowserStorage(dependencies.localStorage);
        const current = readSlot(storage, input);
        if (
          !current ||
          !sameExactIntent(current, input) ||
          current.receiptId !== input.receiptId
        ) {
          return { status: "superseded" } as const;
        }
        removeStorageItem(storage, billingCancelIntentStorageKey(input));
        return { status: "cleared" } as const;
      });
    },
  };
}

export const billingCancelIntentCoordinator =
  createBillingCancelIntentCoordinator();
