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

export function sanitizeOnboardingSessionToken(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !ONBOARDING_TOKEN_PATTERN.test(trimmed)) return null;
  return trimmed.startsWith("platform:") ? null : trimmed;
}

function eachStorage(): Storage[] {
  if (typeof window === "undefined") return [];
  const storages: Storage[] = [];
  try {
    storages.push(window.localStorage);
  } catch {
    // error-policy:J3 storage may be disabled entirely by the browser.
  }
  try {
    storages.push(window.sessionStorage);
  } catch {
    // error-policy:J3 the credential remains in the same-origin URL instead.
  }
  return storages;
}

/**
 * Persist the credential and report whether either browser store verifies the
 * exact write. The caller may remove the URL parameter only after success.
 */
export function storePendingOnboardingSession(token: string): boolean {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return false;
  const stored = JSON.stringify({
    token: sanitized,
    expiresAt: Date.now() + PENDING_ONBOARDING_SESSION_TTL_MS,
  } satisfies StoredPendingOnboardingSession);
  let persisted = false;
  for (const storage of eachStorage()) {
    try {
      storage.setItem(PENDING_ONBOARDING_SESSION_KEY, stored);
      persisted ||= storage.getItem(PENDING_ONBOARDING_SESSION_KEY) === stored;
    } catch {
      // error-policy:J3 unwritable storage leaves the URL credential intact.
    }
  }
  return persisted;
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
  for (const storage of eachStorage()) {
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

/** Remove and verify both browser copies before the page reports dismissal. */
export function clearPendingOnboardingSession(): boolean {
  if (typeof window === "undefined") return false;
  let cleared = true;
  const accessors = [
    () => window.localStorage,
    () => window.sessionStorage,
  ] as const;
  for (const getStorage of accessors) {
    let storage: Storage;
    try {
      storage = getStorage();
      storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
    } catch {
      // error-policy:J4 cleanup is verified below and any residual copy becomes a visible blocked state.
      try {
        storage = getStorage();
      } catch {
        cleared = false;
        continue;
      }
    }
    try {
      if (storage.getItem(PENDING_ONBOARDING_SESSION_KEY) !== null) {
        cleared = false;
      }
    } catch {
      // error-policy:J4 unreadable storage cannot be reported as safely cleared.
      cleared = false;
    }
  }
  return cleared;
}
