/**
 * Auth-query gate for the app-hosted Instances domain.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/data/auth-query.ts`, rewired onto
 * the cloud shell's Steward session via {@link useSessionAuth}. Same contract:
 * react-query reads are gated until a Steward session is ready + authenticated,
 * and the query key is scoped by user id so a sign-out / account switch never
 * serves another user's cached data.
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
