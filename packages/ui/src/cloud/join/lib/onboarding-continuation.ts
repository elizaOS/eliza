/**
 * Onboarding continuation hand-through for the messaging → cloud signup funnel.
 *
 * A messaging transport hands the browser an opaque
 * continuation token (`?onboardingSession=<token>`) proving ownership of the
 * platform-scoped onboarding session. The token must survive the Steward login
 * round trip (OAuth popup, email magic link, OTP) that loses URL params, so it
 * is persisted here — mirroring the pending-OAuth `returnTo` pattern in
 * `public-pages/lib/login-return-to.ts` — and redeemed exactly once after
 * authentication by POSTing the onboarding chat endpoint with the Steward
 * bearer. Ordinary continuations are explicitly confirmed after login. A
 * Telegram personal-account claim is purpose-marked separately, confirmed
 * against the read-only claim preview on the landing page, and consumed by
 * Steward sync before generic account creation, preserving its existing user,
 * organization, and transcript. The purpose marker is routing metadata only;
 * the server validates all authority from the opaque token.
 *
 * Client-side single-use: the stored token is cleared only after the exchange
 * succeeds, so a transient failure keeps it for retry. Server-side the token
 * has its own TTL and first-bind-wins semantics (a session bound to another
 * account is never handed over).
 */

import { api } from "../../lib/api-client";

const PENDING_ONBOARDING_SESSION_KEY = "eliza.join.onboardingSession";
export const TELEGRAM_ACCOUNT_CLAIM_PURPOSE = "telegram-account-claim" as const;
type PendingOnboardingPurpose = "link" | typeof TELEGRAM_ACCOUNT_CLAIM_PURPOSE;
/** Long enough for an email magic-link round trip; short enough not to haunt
 * the browser for weeks. The server enforces its own (longer) session TTL. */
const PENDING_ONBOARDING_SESSION_TTL_MS = 60 * 60 * 1000;

/** Mirrors the server's onboarding session-id shape (SESSION_ID_PATTERN). */
const ONBOARDING_TOKEN_PATTERN = /^[a-zA-Z0-9:+_-]{8,180}$/;

interface StoredPendingOnboardingSession {
  token: string;
  expiresAt: number;
  purpose?: PendingOnboardingPurpose;
}

/**
 * Validate a raw `?onboardingSession=` value. Platform-scoped ids
 * (`platform:...`) are rejected: those are derived from guessable messaging
 * ids and only a trusted gateway may present them — the browser leg always
 * carries the opaque continuation credential.
 */
export function sanitizeOnboardingSessionToken(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!ONBOARDING_TOKEN_PATTERN.test(trimmed)) return null;
  if (trimmed.startsWith("platform:")) return null;
  return trimmed;
}

function eachStorage(): Storage[] {
  if (typeof window === "undefined") return [];
  const storages: Storage[] = [];
  try {
    storages.push(window.sessionStorage);
  } catch {
    // Storage can be disabled entirely (private browsing hard mode).
  }
  try {
    storages.push(window.localStorage);
  } catch {
    // Same as above — the funnel degrades to the URL-param path only.
  }
  return storages;
}

/** Persist the pending continuation and its post-login execution path. */
export function storePendingOnboardingSession(
  token: string,
  purpose: PendingOnboardingPurpose = "link",
): boolean {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return false;
  const storages = eachStorage();
  let expiresAt = Date.now() + PENDING_ONBOARDING_SESSION_TTL_MS;
  // The expiry also orders mirrored entries. Advance beyond either existing
  // value so same-millisecond links and partial storage writes stay ordered.
  for (const storage of storages) {
    try {
      const existing = parseStored(
        storage.getItem(PENDING_ONBOARDING_SESSION_KEY),
      );
      if (existing && existing.expiresAt >= expiresAt) {
        expiresAt = existing.expiresAt + 1;
      }
    } catch {
      // error-policy:J3 unreadable storage cannot contribute ordering state.
    }
  }
  const stored = JSON.stringify({
    token: sanitized,
    expiresAt,
    purpose,
  } satisfies StoredPendingOnboardingSession);
  let persisted = false;
  for (const storage of storages) {
    try {
      storage.setItem(PENDING_ONBOARDING_SESSION_KEY, stored);
      persisted = true;
    } catch {
      // error-policy:J3 unwritable storage — losing the pending token degrades
      // to a signup without the messaging link, never a failed login.
    }
  }
  return persisted;
}

function parseStored(
  value: string | null,
): StoredPendingOnboardingSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredPendingOnboardingSession>;
    const purpose = parsed.purpose ?? "link";
    if (
      typeof parsed.token === "string" &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt >= Date.now() &&
      (purpose === "link" || purpose === TELEGRAM_ACCOUNT_CLAIM_PURPOSE)
    ) {
      const token = sanitizeOnboardingSessionToken(parsed.token);
      return token ? { token, expiresAt: parsed.expiresAt, purpose } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the pending token WITHOUT consuming it (cleared only on success). */
export function peekPendingOnboardingSession(
  purpose?: PendingOnboardingPurpose,
): string | null {
  let newest: StoredPendingOnboardingSession | null = null;
  for (const storage of eachStorage()) {
    try {
      const pending = parseStored(
        storage.getItem(PENDING_ONBOARDING_SESSION_KEY),
      );
      if (pending && (!newest || pending.expiresAt >= newest.expiresAt)) {
        newest = pending;
      }
    } catch {
      // error-policy:J3 unreadable storage reads as no pending token.
    }
  }
  return newest && (!purpose || newest.purpose === purpose)
    ? newest.token
    : null;
}

/** Drop the pending token from every storage (post-success, single-use). */
export function clearPendingOnboardingSession(): void {
  for (const storage of eachStorage()) {
    try {
      storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup; an expired leftover is inert.
    }
  }
}

/**
 * Drop only the exact continuation that just succeeded. A different claim may
 * have been stored while the request was in flight (another tab or link); that
 * newer authority must not be consumed by an older response.
 */
export function clearPendingOnboardingSessionIfMatches(
  token: string,
  purpose: PendingOnboardingPurpose,
): boolean {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return false;
  let cleared = false;
  for (const storage of eachStorage()) {
    try {
      const pending = parseStored(
        storage.getItem(PENDING_ONBOARDING_SESSION_KEY),
      );
      if (pending?.token === sanitized && pending.purpose === purpose) {
        storage.removeItem(PENDING_ONBOARDING_SESSION_KEY);
        cleared = true;
      }
    } catch {
      // error-policy:J6 best-effort post-success cleanup; the server remains
      // authoritative and the leftover expires without granting new access.
    }
  }
  return cleared;
}

/** The transport seam, injectable for tests. */
export interface OnboardingContinuationTransport {
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  get?(path: string): Promise<unknown>;
}

const defaultTransport: OnboardingContinuationTransport = {
  post: (path, body) => api(path, { method: "POST", json: body }),
  get: (path) => api(path),
};

export interface MessagingContinuationPreview {
  platform: "discord" | "telegram" | "blooio" | "twilio";
  platformUserId: string;
  platformDisplayName: string;
  returnUrl: string | null;
}

export async function previewPendingOnboardingContinuation(
  token: string,
  transport: OnboardingContinuationTransport = defaultTransport,
): Promise<MessagingContinuationPreview> {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized || !transport.get)
    throw new Error("Invalid onboarding connection link");
  const response = (await transport.get(
    `/api/eliza-app/onboarding/chat?sessionId=${encodeURIComponent(sanitized)}`,
  )) as { data?: MessagingContinuationPreview };
  if (!response?.data)
    throw new Error("Could not verify the messaging account to connect");
  return response.data;
}

/**
 * Redeem the continuation server-side with the caller's Steward session: the
 * onboarding chat endpoint resolves the opaque token to the platform session,
 * binds it to the authenticated account, links the trusted platform identity,
 * and starts provisioning. Success clears the stored token (single-use);
 * failure throws AND keeps it so a retry can redeem it.
 */
export async function completePendingOnboardingContinuation(
  token: string,
  transport: OnboardingContinuationTransport = defaultTransport,
): Promise<void> {
  const sanitized = sanitizeOnboardingSessionToken(token);
  if (!sanitized) return;
  await transport.post("/api/eliza-app/onboarding/chat", {
    sessionId: sanitized,
    platform: "web",
    confirmPlatformLink: true,
  });
  clearPendingOnboardingSessionIfMatches(sanitized, "link");
}
