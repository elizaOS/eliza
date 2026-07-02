/**
 * Canonical React-Query auth gate for app-hosted cloud domains. Gates a
 * domain's queries on a resolved Steward session and namespaces query keys by
 * the authenticated user id so a session switch invalidates cached data.
 *
 * The instances and analytics domains keep their own gates: instances binds
 * to its Playwright-aware session hook, and analytics resolves the
 * console-wide session via public-pages' use-session-auth (#11558) — both
 * genuinely different implementations.
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
