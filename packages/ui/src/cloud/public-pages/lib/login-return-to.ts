/**
 * Login `returnTo` resolution for the app-hosted Steward login surface.
 *
 * Sanitizes + persists the post-login destination across the OAuth redirect
 * round-trip (which can't carry it in the OAuth `redirect_uri`).
 */

import { isApexControlPlaneHost } from "../../shell/apex-host";

// The post-login landing is host-dependent. On the app domains the join flow
// (`/join`) select-or-provisions a Cloud agent and drops the user straight
// into chat (the headline migration outcome). On an apex control-plane host
// (elizacloud.ai — the CONSOLE) chat doesn't exist and the agent app never
// boots (see AppCatchAllRoute), so login lands on the `/dashboard` console
// overview instead of running an agent-provisioning flow the console can't
// use. Called by every post-auth surface (login, email magic-link callback,
// invite accept) so they all agree.
export function defaultLoginReturnTo(): string {
  return isApexControlPlaneHost() ? "/dashboard" : "/join";
}
const PENDING_OAUTH_RETURN_TO_KEY = "eliza.login.oauth.returnTo";
const PENDING_OAUTH_RETURN_TO_TTL_MS = 10 * 60 * 1000;

type StoredReturnTo = {
  returnTo: string;
  expiresAt: number;
};

function sanitizeLoginReturnTo(
  value: string | null | undefined,
): string | null {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
}

export function resolveLoginReturnTo(
  searchParams: { get(name: string): string | null },
  pendingOAuthReturnTo?: string | null,
): string {
  return (
    sanitizeLoginReturnTo(searchParams.get("returnTo")) ??
    sanitizeLoginReturnTo(pendingOAuthReturnTo) ??
    defaultLoginReturnTo()
  );
}

export function storePendingOAuthReturnTo(searchParams: {
  get(name: string): string | null;
}): void {
  if (typeof window === "undefined") return;
  const returnTo = sanitizeLoginReturnTo(searchParams.get("returnTo"));
  if (!returnTo) return;
  const stored = JSON.stringify({
    returnTo,
    expiresAt: Date.now() + PENDING_OAUTH_RETURN_TO_TTL_MS,
  } satisfies StoredReturnTo);
  safeSet(window.sessionStorage, stored);
  safeSet(window.localStorage, stored);
}

export function consumePendingOAuthReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  const sessionReturnTo = safeConsume(window.sessionStorage);
  const localReturnTo = safeConsume(window.localStorage);
  return sessionReturnTo ?? localReturnTo;
}

function safeSet(storage: Storage, value: string): void {
  try {
    storage.setItem(PENDING_OAUTH_RETURN_TO_KEY, value);
  } catch {
    // Storage can be disabled in private browsing. Losing returnTo is better
    // than putting it back into the OAuth redirect_uri and failing login.
  }
}

function safeConsume(storage: Storage): string | null {
  try {
    const value = storage.getItem(PENDING_OAUTH_RETURN_TO_KEY);
    storage.removeItem(PENDING_OAUTH_RETURN_TO_KEY);
    return parseStoredReturnTo(value);
  } catch {
    // error-policy:J3 unreadable storage — losing returnTo lands the user on
    // the default post-login page instead of failing the login.
    return null;
  }
}

function parseStoredReturnTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredReturnTo>;
    if (
      typeof parsed.returnTo === "string" &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt >= Date.now()
    ) {
      return sanitizeLoginReturnTo(parsed.returnTo);
    }
    return null;
  } catch {
    return sanitizeLoginReturnTo(value);
  }
}
