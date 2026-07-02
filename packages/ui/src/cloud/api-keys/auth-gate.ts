/**
 * Authenticated-query gate for the API-keys cloud domain.
 *
 * Resolves the session through the console-wide `useSessionAuth` (Steward SDK
 * context OR the persisted localStorage JWT) — NOT the raw Steward SDK context:
 * that context lives in MemoryStorage and reads empty on every full page load,
 * so gating on it left the keys list permanently `enabled: false` for a
 * genuinely signed-in user (same class as the admin-gate / MCPs / analytics
 * fixes). The query key stays partitioned per user so a sign-out / account
 * switch can't surface the previous user's cached keys.
 */

import { useSessionAuth } from "../public-pages/lib/use-session-auth";

export interface AuthenticatedQueryGate {
  /** Whether the gated query may run (a session has resolved). */
  enabled: boolean;
  /** The authenticated user id, used to partition cached query data. */
  userId: string | null;
}

/**
 * Read the current session and derive the query gate. Returns
 * `{ enabled: false }` until the session resolves to an authenticated user.
 */
export function useAuthenticatedQueryGate(): AuthenticatedQueryGate {
  const session = useSessionAuth();
  return {
    enabled: session.ready && session.authenticated,
    userId: session.user?.id ?? null,
  };
}

/**
 * Partition a react-query key by the authenticated user so a sign-out/sign-in
 * to a different account can't surface the previous user's cached keys.
 */
export function authenticatedQueryKey(
  parts: readonly unknown[],
  gate: AuthenticatedQueryGate,
): readonly unknown[] {
  return [...parts, "auth", gate.userId];
}
