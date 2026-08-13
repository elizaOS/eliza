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

export type PendingOnboardingSessionPresence =
  | "present"
  | "absent"
  | "indeterminate";

const BROWSER_STORAGE_ACCESSORS = [
  () => window.localStorage,
  () => window.sessionStorage,
] as const;

export function sanitizeOnboardingSessionToken(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !ONBOARDING_TOKEN_PATTERN.test(trimmed)) return null;
  return trimmed.startsWith("platform:") ? null : trimmed;
}

/**
 * Persist the credential and report whether either browser store verifies the
 * exact write. The caller may remove the URL parameter only after success.
 */
export function storePendingOnboardingSession(
  token: string,
): PendingOnboardingSessionPresence {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized || typeof window === "undefined") return "indeterminate";
  const stored = JSON.stringify({
    token: sanitized,
    expiresAt: Date.now() + PENDING_ONBOARDING_SESSION_TTL_MS,
  } satisfies StoredPendingOnboardingSession);
  let persisted = false;
  for (const getStorage of BROWSER_STORAGE_ACCESSORS) {
    try {
      const storage = getStorage();
      storage.setItem(PENDING_ONBOARDING_SESSION_KEY, stored);
      persisted ||= storage.getItem(PENDING_ONBOARDING_SESSION_KEY) === stored;
    } catch {
      // error-policy:J3 unwritable storage leaves the URL credential intact.
    }
  }
  return persisted ? "present" : "indeterminate";
}

function hasValidStoredSession(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as Partial<StoredPendingOnboardingSession>;
    return Boolean(
      typeof parsed.token === "string" &&
        sanitizeOnboardingSessionToken(parsed.token) &&
        typeof parsed.expiresAt === "number" &&
        parsed.expiresAt >= Date.now(),
    );
  } catch {
    // error-policy:J3 malformed persisted input is not a usable credential.
    return false;
  }
}

function peekStoragePresence(
  getStorage: (typeof BROWSER_STORAGE_ACCESSORS)[number],
): PendingOnboardingSessionPresence {
  let storage: Storage;
  let value: string | null;
  try {
    storage = getStorage();
    value = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
  } catch {
    // error-policy:J4 an unreadable slot may still own a credential, so setup must remain visibly blocked.
    return "indeterminate";
  }
  if (value === null) return "absent";

  if (hasValidStoredSession(value)) return "present";

  try {
    storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
    const remaining = storage.getItem(PENDING_ONBOARDING_SESSION_KEY);
    if (remaining === null) return "absent";
    return hasValidStoredSession(remaining) ? "present" : "indeterminate";
  } catch {
    // error-policy:J4 failed cleanup cannot prove that the unusable credential is absent.
    return "indeterminate";
  }
}

export function peekPendingOnboardingSession(): PendingOnboardingSessionPresence {
  if (typeof window === "undefined") return "indeterminate";
  let present = false;
  let indeterminate = false;
  for (const getStorage of BROWSER_STORAGE_ACCESSORS) {
    const presence = peekStoragePresence(getStorage);
    if (presence === "present") present = true;
    if (presence === "indeterminate") indeterminate = true;
  }
  if (present) return "present";
  return indeterminate ? "indeterminate" : "absent";
}

/** Remove and verify both browser copies before the page reports dismissal. */
export function clearPendingOnboardingSession(): PendingOnboardingSessionPresence {
  if (typeof window === "undefined") return "indeterminate";
  let cleared = true;
  for (const getStorage of BROWSER_STORAGE_ACCESSORS) {
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
  return cleared ? "absent" : "indeterminate";
}
