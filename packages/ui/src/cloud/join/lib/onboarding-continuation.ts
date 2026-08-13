/**
 * Browser persistence for the messaging-to-Cloud continuation credential.
 *
 * The credential is retained while the production linking boundary is paused,
 * but no transport consumes it. The user is the only authority that clears it.
 */

const PENDING_ONBOARDING_SESSION_KEY = "eliza.join.onboardingSession";
const PENDING_ONBOARDING_SESSION_TTL_MS = 60 * 60 * 1000;
const ONBOARDING_TOKEN_PATTERN = /^[a-zA-Z0-9:+_-]{8,180}$/;

interface StoredPendingOnboardingSession {
  token: string;
  expiresAt: number;
}

interface AvailableStorage {
  crossTab: boolean;
  storage: Storage;
}

export function sanitizeOnboardingSessionToken(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !ONBOARDING_TOKEN_PATTERN.test(trimmed)) return null;
  return trimmed.startsWith("platform:") ? null : trimmed;
}

function eachStorage(): AvailableStorage[] {
  if (typeof window === "undefined") return [];
  const storages: AvailableStorage[] = [];
  try {
    storages.push({ storage: window.localStorage, crossTab: true });
  } catch {
    // error-policy:J3 storage may be disabled entirely by the browser.
  }
  try {
    storages.push({ storage: window.sessionStorage, crossTab: false });
  } catch {
    // error-policy:J3 the credential remains in the same-origin URL instead.
  }
  return storages;
}

/**
 * Persist the credential and report whether it is available across tabs. The
 * caller keeps the URL parameter unless localStorage succeeds.
 */
export function storePendingOnboardingSession(token: string): boolean {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return false;
  const stored = JSON.stringify({
    token: sanitized,
    expiresAt: Date.now() + PENDING_ONBOARDING_SESSION_TTL_MS,
  } satisfies StoredPendingOnboardingSession);
  let crossTabPersisted = false;
  for (const { storage, crossTab } of eachStorage()) {
    try {
      storage.setItem(PENDING_ONBOARDING_SESSION_KEY, stored);
      crossTabPersisted ||= crossTab;
    } catch {
      // error-policy:J3 unwritable storage leaves the URL credential intact.
    }
  }
  return crossTabPersisted;
}

function parseStored(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredPendingOnboardingSession>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt >= Date.now()
    ) {
      return sanitizeOnboardingSessionToken(parsed.token);
    }
    return null;
  } catch {
    // error-policy:J3 malformed persisted input is not a usable credential.
    return null;
  }
}

export function peekPendingOnboardingSession(): string | null {
  let pendingToken: string | null = null;
  for (const { storage } of eachStorage()) {
    try {
      const value = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
      if (!value) continue;
      const token = parseStored(value);
      if (token) {
        pendingToken ??= token;
      } else {
        storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
      }
    } catch {
      // error-policy:J3 unreadable storage means no pending credential.
    }
  }
  return pendingToken;
}

export function clearPendingOnboardingSession(): void {
  for (const { storage } of eachStorage()) {
    try {
      storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
    } catch {
      // error-policy:J6 best-effort browser-only credential cleanup.
    }
  }
}
