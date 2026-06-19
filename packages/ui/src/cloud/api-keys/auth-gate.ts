/**
 * Authenticated-query gate for the API-keys cloud domain.
 *
 * The cloud-frontend version read auth from its own `useSessionAuth` +
 * `useAuthenticatedQueryGate`. In the app the canonical auth context is the
 * Steward runtime context exposed by the cloud shell
 * ({@link LocalStewardAuthContext}); this gate adapts it to the same
 * `{ enabled, userId }` shape the ported react-query hooks expect, so the keys
 * list only fetches once a Steward session is present and the query key is
 * partitioned per user.
 */

import { useContext } from "react";
import { LocalStewardAuthContext } from "../shell/StewardProvider";

export interface AuthenticatedQueryGate {
  /** Whether the gated query may run (a Steward session has resolved). */
  enabled: boolean;
  /** The authenticated user id, used to partition cached query data. */
  userId: string | null;
}

/**
 * Read the current Steward auth session and derive the query gate. Returns
 * `{ enabled: false }` until the session resolves to an authenticated user.
 */
export function useAuthenticatedQueryGate(): AuthenticatedQueryGate {
  const auth = useContext(LocalStewardAuthContext);
  const ready = auth ? !auth.isLoading : false;
  const authenticated = auth?.isAuthenticated ?? false;
  return {
    enabled: ready && authenticated,
    userId: auth?.user?.id ?? null,
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
