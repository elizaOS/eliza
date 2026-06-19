/**
 * React-Query auth gate for the approvals domain.
 *
 * Copied from the documents domain's `auth-query.ts` (ported from
 * `@elizaos/cloud-frontend/src/lib/data/auth-query.ts`). Gates the domain's
 * queries on a resolved Steward session and namespaces query keys by the
 * authenticated user id so a session switch invalidates cached data.
 *
 * Scoped to the approvals domain; promote to shared cloud infra once enough
 * domains share it.
 */

import { useSessionAuth } from "./use-session-auth";

export interface AuthenticatedQueryGate {
  enabled: boolean;
  userId: string | null;
}

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
