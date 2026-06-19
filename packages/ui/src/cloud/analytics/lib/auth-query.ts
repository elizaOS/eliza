/**
 * Auth-query gate for the app-hosted cloud analytics view.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/data/auth-query.ts`, rewired onto
 * the cloud shell's `LocalStewardAuthContext` (provided by `StewardAuthProvider`
 * for every authenticated cloud route) instead of cloud-frontend's
 * `useSessionAuth`. Same contract: react-query reads are gated until a Steward
 * session is ready + authenticated, and the query key is scoped by user id so a
 * sign-out / account switch doesn't serve another user's cached data.
 */

import { useContext } from "react";
import { LocalStewardAuthContext } from "../../shell/StewardProvider";

export interface AuthenticatedQueryGate {
  enabled: boolean;
  userId: string | null;
}

/**
 * Resolve the analytics query gate from the cloud Steward session. When no
 * provider is mounted (e.g. SSR or a misconfigured Steward URL where
 * `StewardAuthProvider` renders children directly), the context is null and the
 * gate stays disabled rather than firing unauthenticated requests.
 */
export function useAuthenticatedQueryGate(
  enabled = true,
): AuthenticatedQueryGate {
  const auth = useContext(LocalStewardAuthContext);
  const ready = auth ? !auth.isLoading : false;
  const authenticated = auth?.isAuthenticated ?? false;
  return {
    enabled: enabled && ready && authenticated,
    userId: auth?.user?.id ?? null,
  };
}

export function authenticatedQueryKey(
  parts: readonly unknown[],
  gate: AuthenticatedQueryGate,
): readonly unknown[] {
  return [...parts, "auth", gate.userId];
}
