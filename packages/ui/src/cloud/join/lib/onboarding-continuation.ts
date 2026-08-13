/**
 * Owns the durable browser credential for messaging → Cloud continuation.
 *
 * Browser storage is a two-slot presence lattice, never a preferred-store
 * token source. Every write and destructive cleanup is verified by readback;
 * uncertainty blocks the funnel. Redemption uses one stable operation-scoped
 * idempotency key, records a committed receipt before token-specific cleanup,
 * and therefore never repeats a confirmed server mutation after reload.
 */

import { api } from "../../lib/api-client";

const PENDING_ONBOARDING_SESSION_KEY = "eliza.join.onboardingSession";
const PENDING_ONBOARDING_SESSION_TTL_MS = 60 * 60 * 1000;
const FRESH_INGESTION_WINDOW_MS = 5_000;
const SETTLED_REDEMPTION_WINDOW_MS = 5 * 60 * 1000;
const ONBOARDING_TOKEN_PATTERN = /^[a-zA-Z0-9:+_-]{8,180}$/;
const STORAGE_NAMES = ["sessionStorage", "localStorage"] as const;
type StorageName = (typeof STORAGE_NAMES)[number];

export type OnboardingRedemptionState = "pending" | "committed";

interface StoredPendingOnboardingSession {
  token: string;
  expiresAt: number;
  redemption: OnboardingRedemptionState;
}

export type PendingOnboardingSessionState =
  | {
      presence: "present";
      token: string;
      redemption: OnboardingRedemptionState;
    }
  | { presence: "absent" }
  | { presence: "indeterminate" };

type PresentPendingOnboardingSession = Extract<
  PendingOnboardingSessionState,
  { presence: "present" }
>;

interface InspectedStorage {
  name: StorageName;
  storage: Storage | null;
  state: PendingOnboardingSessionState;
  raw: string | null;
}

export function sanitizeOnboardingSessionToken(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!ONBOARDING_TOKEN_PATTERN.test(trimmed)) return null;
  if (trimmed.startsWith("platform:")) return null;
  return trimmed;
}

function accessStorage(name: StorageName): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[name];
  } catch {
    // error-policy:J4 browser storage can be disabled; the caller renders a
    // recoverable blocked state while retaining the URL credential.
    return null;
  }
}

function parseStored(value: string): StoredPendingOnboardingSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredPendingOnboardingSession>;
    const token = sanitizeOnboardingSessionToken(parsed.token);
    if (
      !token ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt < Date.now() ||
      (parsed.redemption !== undefined &&
        parsed.redemption !== "pending" &&
        parsed.redemption !== "committed")
    ) {
      return null;
    }
    return {
      token,
      expiresAt: parsed.expiresAt,
      // Legacy records predate durable redemption receipts and are pending.
      redemption: parsed.redemption === "committed" ? "committed" : "pending",
    };
  } catch {
    // error-policy:J3 malformed browser-owned JSON is invalid input; callers
    // perform verified cleanup before concluding the slot is absent.
    return null;
  }
}

function presentState(
  record: StoredPendingOnboardingSession,
): PresentPendingOnboardingSession {
  return {
    presence: "present",
    token: record.token,
    redemption: record.redemption,
  };
}

function inspectStorage(name: StorageName): InspectedStorage {
  const storage = accessStorage(name);
  if (!storage) {
    return {
      name,
      storage: null,
      state: { presence: "indeterminate" },
      raw: null,
    };
  }

  let value: string | null;
  try {
    value = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
  } catch {
    // error-policy:J4 unreadable storage cannot prove credential absence.
    return {
      name,
      storage,
      state: { presence: "indeterminate" },
      raw: null,
    };
  }
  if (value === null) {
    return { name, storage, state: { presence: "absent" }, raw: null };
  }

  const record = parseStored(value);
  if (record) {
    return { name, storage, state: presentState(record), raw: value };
  }

  try {
    storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
  } catch {
    // error-policy:J3 invalid cleanup is authoritative only after readback.
  }
  try {
    const remaining = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
    if (remaining === null) {
      return { name, storage, state: { presence: "absent" }, raw: null };
    }
    const replacement = parseStored(remaining);
    return {
      name,
      storage,
      state: replacement
        ? presentState(replacement)
        : { presence: "indeterminate" },
      raw: remaining,
    };
  } catch {
    // error-policy:J4 failed cleanup readback leaves presence unknown.
    return {
      name,
      storage,
      state: { presence: "indeterminate" },
      raw: null,
    };
  }
}

function inspectAllStorages(): InspectedStorage[] {
  return STORAGE_NAMES.map(inspectStorage);
}

function aggregateStorageStates(
  inspections: InspectedStorage[],
): PendingOnboardingSessionState {
  const present = inspections.flatMap(({ state }) =>
    state.presence === "present" ? [state] : [],
  );
  const tokens = new Set(present.map(({ token }) => token));
  if (tokens.size > 1) return { presence: "indeterminate" };
  const [token] = tokens;
  if (token) {
    return {
      presence: "present",
      token,
      redemption: present.some(({ redemption }) => redemption === "committed")
        ? "committed"
        : "pending",
    };
  }
  return inspections.every(({ state }) => state.presence === "absent")
    ? { presence: "absent" }
    : { presence: "indeterminate" };
}

export function peekPendingOnboardingSession(): PendingOnboardingSessionState {
  return aggregateStorageStates(inspectAllStorages());
}

function writeExact(
  storage: Storage,
  value: string,
): "written" | "different" | "unreadable" {
  try {
    storage.setItem(PENDING_ONBOARDING_SESSION_KEY, value);
  } catch {
    // error-policy:J4 a thrown setter may still have committed; readback below
    // is the sole persistence authority.
  }
  try {
    const readback = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
    if (readback === value) return "written";
    return "different";
  } catch {
    // error-policy:J4 unreadable writeback cannot prove persistence.
    return "unreadable";
  }
}

/** Persist a fresh URL credential, refreshing its pending receipt and TTL. */
export function storePendingOnboardingSession(
  token: string,
): PendingOnboardingSessionState {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return { presence: "indeterminate" };

  const inspections = inspectAllStorages();
  const readablePresent = inspections.flatMap(({ state }) =>
    state.presence === "present" ? [state] : [],
  );
  const hasDifferentToken = readablePresent.some(
    (state) => state.token !== sanitized,
  );
  if (
    hasDifferentToken &&
    readablePresent.some((state) => state.redemption === "committed")
  ) {
    return { presence: "indeterminate" };
  }
  const committed = readablePresent.find(
    (state) => state.token === sanitized && state.redemption === "committed",
  );
  if (committed) return committed;
  const alreadyFresh =
    !hasDifferentToken &&
    inspections.some((inspection) => {
      if (
        inspection.state.presence !== "present" ||
        inspection.state.token !== sanitized ||
        inspection.state.redemption !== "pending" ||
        !inspection.raw
      ) {
        return false;
      }
      const record = parseStored(inspection.raw);
      return (
        record !== null &&
        record.expiresAt >=
          Date.now() +
            PENDING_ONBOARDING_SESSION_TTL_MS -
            FRESH_INGESTION_WINDOW_MS
      );
    });
  if (alreadyFresh) {
    return { presence: "present", token: sanitized, redemption: "pending" };
  }

  const value = JSON.stringify({
    token: sanitized,
    expiresAt: Date.now() + PENDING_ONBOARDING_SESSION_TTL_MS,
    redemption: "pending",
  } satisfies StoredPendingOnboardingSession);
  let exactWrites = 0;
  for (const inspection of inspections) {
    if (!inspection.storage || inspection.state.presence === "indeterminate") {
      continue;
    }
    if (writeExact(inspection.storage, value) === "written") exactWrites += 1;
  }
  if (exactWrites === 0) return { presence: "indeterminate" };
  const verified = peekPendingOnboardingSession();
  if (verified.presence === "present" && verified.token === sanitized) {
    if (verified.redemption === "pending") {
      discardSettledRedemption(sanitized);
    }
    return verified;
  }
  return { presence: "indeterminate" };
}

function clearStorage(storage: Storage): PendingOnboardingSessionState {
  try {
    storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
  } catch {
    // error-policy:J4 removal is accepted only if readback proves emptiness.
  }
  try {
    const remaining = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
    if (remaining === null) return { presence: "absent" };
    const record = parseStored(remaining);
    return record ? presentState(record) : { presence: "indeterminate" };
  } catch {
    // error-policy:J4 unreadable removal state cannot prove consumption.
    return { presence: "indeterminate" };
  }
}

/** Generic verified clear used by the explicit dismiss path. */
export function clearPendingOnboardingSession(): PendingOnboardingSessionState {
  return aggregateStorageStates(
    STORAGE_NAMES.map((name) => {
      const storage = accessStorage(name);
      return {
        name,
        storage,
        state: storage
          ? clearStorage(storage)
          : { presence: "indeterminate" as const },
        raw: null,
      };
    }),
  );
}

/**
 * Clear only records still matching the redeemed credential. A replacement B
 * that arrives while A is in flight is never deleted and becomes the result.
 */
export function clearPendingOnboardingSessionIfToken(
  expectedToken: string,
): PendingOnboardingSessionState {
  const expected = sanitizeOnboardingSessionToken(expectedToken);
  if (!expected) return { presence: "indeterminate" };
  let inspections = inspectAllStorages();
  if (inspections.some(({ state }) => state.presence === "indeterminate")) {
    return aggregateStorageStates(inspections);
  }

  // A partially written committed receipt can coexist with a pending copy.
  // Clear pending copies first while every committed sentinel remains intact.
  // If any pending removal is a no-op, the surviving committed copy keeps a
  // reload on the cleanup-only path rather than allowing a second redemption.
  for (const inspection of inspections) {
    if (
      inspection.state.presence === "present" &&
      inspection.state.token === expected &&
      inspection.state.redemption === "pending" &&
      inspection.storage
    ) {
      clearStorage(inspection.storage);
    }
  }
  inspections = inspectAllStorages();
  if (
    inspections.some(({ state }) => state.presence === "indeterminate") ||
    inspections.some(
      ({ state }) =>
        state.presence === "present" &&
        state.token === expected &&
        state.redemption === "pending",
    )
  ) {
    return aggregateStorageStates(inspections);
  }

  for (const inspection of inspections) {
    if (
      inspection.state.presence === "present" &&
      inspection.state.token === expected &&
      inspection.state.redemption === "committed" &&
      inspection.storage
    ) {
      clearStorage(inspection.storage);
    }
  }
  return peekPendingOnboardingSession();
}

function markPendingOnboardingSessionCommitted(
  expectedToken: string,
): PendingOnboardingSessionState {
  const inspections = inspectAllStorages();
  let matchingSlots = 0;
  let committedSlots = 0;
  for (const inspection of inspections) {
    if (
      inspection.state.presence !== "present" ||
      inspection.state.token !== expectedToken ||
      !inspection.storage
    ) {
      continue;
    }
    matchingSlots += 1;
    const parsed = inspection.raw ? parseStored(inspection.raw) : null;
    if (!parsed) continue;
    const committed = JSON.stringify({ ...parsed, redemption: "committed" });
    if (writeExact(inspection.storage, committed) === "written") {
      committedSlots += 1;
    }
  }
  if (matchingSlots === 0) return aggregateStorageStates(inspections);
  if (committedSlots === 0) return { presence: "indeterminate" };
  return {
    presence: "present",
    token: expectedToken,
    redemption: "committed",
  };
}

export interface OnboardingContinuationTransport {
  post(
    path: string,
    body: Record<string, unknown>,
    init?: { headers?: Record<string, string> },
  ): Promise<unknown>;
  get?(path: string): Promise<unknown>;
}

const defaultTransport: OnboardingContinuationTransport = {
  post: (path, body, init) =>
    api(path, { method: "POST", json: body, headers: init?.headers }),
  get: (path) => api(path),
};

type MessagingPlatform = "discord" | "telegram" | "blooio" | "twilio";
type MessagingContinuationPreviewBase = {
  platformUserId: string;
  platformDisplayName: string;
};

export type MessagingContinuationPreview =
  | (MessagingContinuationPreviewBase & {
      platform: "discord" | "telegram";
      returnUrl: null;
    })
  | (MessagingContinuationPreviewBase & {
      platform: "blooio" | "twilio";
      returnUrl: `sms:${string}` | null;
    });

function nonemptyBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function parseMessagingContinuationPreview(
  value: unknown,
): MessagingContinuationPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const platform = record.platform as MessagingPlatform;
  if (
    !(["discord", "telegram", "blooio", "twilio"] as const).includes(platform)
  ) {
    return null;
  }
  const platformUserId = nonemptyBoundedString(record.platformUserId, 256);
  const platformDisplayName = nonemptyBoundedString(
    record.platformDisplayName,
    256,
  );
  if (!platformUserId || !platformDisplayName) return null;
  if (platform === "discord" || platform === "telegram") {
    return record.returnUrl === null
      ? { platform, platformUserId, platformDisplayName, returnUrl: null }
      : null;
  }
  if (record.returnUrl === null) {
    return { platform, platformUserId, platformDisplayName, returnUrl: null };
  }
  const returnUrl = nonemptyBoundedString(record.returnUrl, 260);
  const safeSmsTarget = returnUrl?.slice(4) ?? "";
  const isPhone = /^\+?[1-9]\d{2,14}$/.test(safeSmsTarget);
  const isEmail =
    /^[A-Za-z0-9.!$&'*+/=_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
      safeSmsTarget,
    );
  if (!returnUrl?.startsWith("sms:") || (!isPhone && !isEmail)) return null;
  return {
    platform,
    platformUserId,
    platformDisplayName,
    returnUrl: returnUrl as `sms:${string}`,
  };
}

export async function previewPendingOnboardingContinuation(
  token: string,
  transport: OnboardingContinuationTransport = defaultTransport,
): Promise<MessagingContinuationPreview> {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized || !transport.get) {
    throw new Error("Invalid onboarding connection link");
  }
  const response = await transport.get(
    `/api/eliza-app/onboarding/chat?sessionId=${encodeURIComponent(sanitized)}`,
  );
  const responseRecord =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  const data = responseRecord?.success === true ? responseRecord.data : null;
  const preview = parseMessagingContinuationPreview(data);
  if (!preview) {
    throw new Error("Could not verify the messaging account to connect");
  }
  return preview;
}

function isSuccessfulRedemptionResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (
    response.success !== true ||
    !response.data ||
    typeof response.data !== "object" ||
    Array.isArray(response.data)
  ) {
    return false;
  }
  const data = response.data as Record<string, unknown>;
  const sessionId = nonemptyBoundedString(data.sessionId, 180);
  return (
    sessionId !== null && sessionId.length >= 8 && data.requiresLogin === false
  );
}

const redemptionFlights = new Map<
  string,
  Promise<PendingOnboardingSessionState>
>();
interface SettledRedemption {
  state: PendingOnboardingSessionState;
  settledAt: number;
}

const settledRedemptions = new Map<string, SettledRedemption>();

function discardSettledRedemption(token: string): void {
  if (!settledRedemptions.has(token)) return;
  settledRedemptions.delete(token);
  redemptionFlights.delete(token);
}

/**
 * Observe an existing same-token completion without reading storage or
 * initiating transport. Successful residual results remain observable across
 * component remounts; rejected attempts are evicted for an explicit retry.
 */
export function observePendingOnboardingContinuationCompletion(
  token: string,
): Promise<PendingOnboardingSessionState> | null {
  const sanitized = sanitizeOnboardingSessionToken(token);
  return sanitized ? (redemptionFlights.get(sanitized) ?? null) : null;
}

/**
 * Recover a clean success that settled while its route was unmounted. The
 * receipt is module-local, time-bounded, and acknowledged by the done view.
 */
export function observeRecentOnboardingContinuationCompletion(): {
  token: string;
  state: PendingOnboardingSessionState;
} | null {
  let recent: { token: string; settled: SettledRedemption } | null = null;
  for (const [token, settled] of settledRedemptions) {
    if (Date.now() - settled.settledAt > SETTLED_REDEMPTION_WINDOW_MS) {
      settledRedemptions.delete(token);
      redemptionFlights.delete(token);
      continue;
    }
    if (
      settled.state.presence === "absent" &&
      (!recent || settled.settledAt > recent.settled.settledAt)
    ) {
      recent = { token, settled };
    }
  }
  return recent ? { token: recent.token, state: recent.settled.state } : null;
}

/** Acknowledge a rendered completion so a later bare route cannot reuse it. */
export function acknowledgeOnboardingContinuationCompletion(
  token: string,
): void {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized || !settledRedemptions.has(sanitized)) return;
  settledRedemptions.delete(sanitized);
  redemptionFlights.delete(sanitized);
}

async function redeemPendingOnboardingContinuation(
  token: string,
  transport: OnboardingContinuationTransport,
): Promise<PendingOnboardingSessionState> {
  const before = peekPendingOnboardingSession();
  if (before.presence !== "present" || before.token !== token) return before;
  if (before.redemption === "committed") {
    return clearPendingOnboardingSessionIfToken(token);
  }

  const response = await transport.post(
    "/api/eliza-app/onboarding/chat",
    {
      sessionId: token,
      platform: "web",
      confirmPlatformLink: true,
    },
    { headers: { "Idempotency-Key": "cloud-continuation-confirm-v1" } },
  );
  if (!isSuccessfulRedemptionResponse(response)) {
    throw new Error("Could not verify the completed messaging connection");
  }

  const committed = markPendingOnboardingSessionCommitted(token);
  if (
    committed.presence === "present" &&
    committed.token === token &&
    committed.redemption === "committed"
  ) {
    return clearPendingOnboardingSessionIfToken(token);
  }
  if (committed.presence === "present" && committed.token !== token) {
    return committed;
  }
  return { presence: "indeterminate" };
}

export function completePendingOnboardingContinuation(
  token: string,
  transport: OnboardingContinuationTransport = defaultTransport,
): Promise<PendingOnboardingSessionState> {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return Promise.resolve({ presence: "indeterminate" });
  const existing = redemptionFlights.get(sanitized);
  if (existing) {
    const settled = settledRedemptions.get(sanitized)?.state;
    if (!settled) return existing;
    const current = peekPendingOnboardingSession();
    const stillRepresentsCurrentStorage =
      settled.presence === "indeterminate" &&
      current.presence === "indeterminate";
    if (stillRepresentsCurrentStorage) {
      return existing;
    }
    redemptionFlights.delete(sanitized);
    settledRedemptions.delete(sanitized);
  }

  let flight!: Promise<PendingOnboardingSessionState>;
  flight = redeemPendingOnboardingContinuation(sanitized, transport).then(
    (result) => {
      if (redemptionFlights.get(sanitized) !== flight) return result;
      settledRedemptions.set(sanitized, {
        state: result,
        settledAt: Date.now(),
      });
      return result;
    },
    (error: unknown) => {
      if (redemptionFlights.get(sanitized) === flight) {
        redemptionFlights.delete(sanitized);
        settledRedemptions.delete(sanitized);
      }
      throw error;
    },
  );
  redemptionFlights.set(sanitized, flight);
  return flight;
}
