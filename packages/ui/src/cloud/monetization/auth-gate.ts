/**
 * Auth gate for the app-hosted monetization cloud surfaces (Earnings +
 * Affiliates).
 *
 * The cloud-frontend pages gated on `useRequireAuth()` (a thin wrapper around
 * `useSessionAuth` — Steward provider + localStorage fallback). In the app the
 * canonical auth context is the Steward runtime context the cloud shell mounts
 * for every authenticated route ({@link LocalStewardAuthContext} from
 * `../shell/StewardProvider`). This gate adapts it to the same
 * `{ ready, authenticated }` shape the ported page modules expect, so a page
 * only renders its data UI once a Steward session is present, and falls back to
 * the localStorage JWT so a page mounted without the runtime provider (cheap
 * routes / native) still resolves the session synchronously.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { useContext, useEffect, useState } from "react";
import { decodeJwtPayload } from "../lib/jwt";
import { LocalStewardAuthContext } from "../shell/StewardProvider";

export interface MonetizationAuthState {
  /** Whether the Steward session has resolved (not loading). */
  ready: boolean;
  /** Whether an authenticated Steward session is present. */
  authenticated: boolean;
}

function hasValidStoredStewardToken(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const token = localStorage.getItem(STEWARD_TOKEN_KEY);
    if (!token) return false;
    const decoded = decodeJwtPayload(token);
    if (!decoded) return false;
    if (decoded.exp && decoded.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the monetization page auth state from the cloud Steward session.
 * Returns `{ ready, authenticated }` so pages can show a loading state until a
 * session resolves, then mount the data UI only when authenticated.
 */
export function useRequireAuth(): MonetizationAuthState {
  const auth = useContext(LocalStewardAuthContext);

  const [storageAuthenticated, setStorageAuthenticated] = useState<boolean>(
    hasValidStoredStewardToken,
  );

  useEffect(() => {
    const sync = () => setStorageAuthenticated(hasValidStoredStewardToken());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("steward-token-sync", sync);
    const t = setTimeout(sync, 250);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("steward-token-sync", sync);
      clearTimeout(t);
    };
  }, []);

  const ready = auth ? !auth.isLoading : true;
  const authenticated =
    (auth?.isAuthenticated ?? false) || storageAuthenticated;

  return { ready, authenticated };
}
