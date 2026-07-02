/**
 * Auth-query gate for the app-hosted cloud analytics view.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/data/auth-query.ts`. Resolves the
 * session through the console-wide `useSessionAuth` (Steward SDK context OR the
 * persisted localStorage JWT) — NOT the raw Steward SDK context: that context
 * lives in MemoryStorage and reads empty on every full page load, so gating on
 * it left the analytics queries permanently `enabled: false` (stuck on the
 * loading skeleton, no data call ever fired) for a genuinely signed-in user.
 * Same class as the admin-gate / MCPs fixes. The query key stays scoped by user
 * id so a sign-out / account switch doesn't serve another user's cached data.
 */

import { useSessionAuth } from "../../public-pages/lib/use-session-auth";

export interface AuthenticatedQueryGate {
  enabled: boolean;
  userId: string | null;
}

/**
 * Resolve the analytics query gate from the console-wide session. Stays
 * disabled until the session is ready + authenticated, so it never fires
 * unauthenticated requests.
 */
export function useAuthenticatedQueryGate(
  enabled = true,
): AuthenticatedQueryGate {
  const session = useSessionAuth();
  return {
    enabled: enabled && session.ready && session.authenticated,
    userId: session.user?.id ?? null,
  };
}

export function authenticatedQueryKey(
  parts: readonly unknown[],
  gate: AuthenticatedQueryGate,
): readonly unknown[] {
  return [...parts, "auth", gate.userId];
}
