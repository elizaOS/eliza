/**
 * Synchronous "is the user logged in" answer for the app-hosted cloud surfaces.
 *
 * Ported from `@elizaos/cloud-frontend/src/hooks/use-session-auth.ts`, adapted
 * to read the Steward auth context exposed by the cloud shell
 * (`LocalStewardAuthContext` in `../../shell/StewardProvider`). The shell only
 * mounts the heavy `@stwd/*` runtime on demand, so this hook falls back to
 * reading the JWT directly from `localStorage` (decoded, expiry-checked) when
 * the provider isn't mounted — keeping authed cloud views able to gate on
 * `{ ready, authenticated, user }` without forcing the runtime to load.
 *
 * Scoped to the documents domain for now; the shell can promote this to shared
 * infra once a second domain needs it.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { useContext, useEffect, useState } from "react";
import { decodeJwtPayload } from "../../lib/jwt";
import {
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../../shell/StewardProvider";

export type StewardSessionUser = {
  id: string;
  email: string;
  walletAddress?: string;
} | null;

const STEWARD_AUTH_FALLBACK: Pick<
  LocalStewardAuthValue,
  "isAuthenticated" | "isLoading" | "user"
> = {
  isAuthenticated: false,
  isLoading: false,
  user: null,
};

function decodeStewardToken(token: string): {
  id: string;
  email: string;
  walletAddress?: string;
  exp?: number;
} | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return {
    id: payload.userId ?? payload.sub ?? "",
    email: payload.email ?? "",
    walletAddress: payload.address ?? undefined,
    exp: payload.exp,
  };
}

/** Read a valid non-expired Steward session directly from localStorage. */
function readStewardSessionFromStorage(): StewardSessionUser {
  if (typeof window === "undefined") return null;
  try {
    const token = localStorage.getItem(STEWARD_TOKEN_KEY);
    if (!token) return null;
    const decoded = decodeStewardToken(token);
    if (!decoded?.id) return null;
    if (decoded.exp && decoded.exp * 1000 < Date.now()) return null;
    return {
      id: decoded.id,
      email: decoded.email,
      walletAddress: decoded.walletAddress,
    };
  } catch {
    return null;
  }
}

/**
 * Safe accessor for the cloud-shell Steward auth context. Returns a signed-out
 * fallback when the provider is not mounted (reads the context directly instead
 * of calling `useAuth()` in a try/catch, which would violate Rules of Hooks).
 */
function useStewardAuthContext(): Pick<
  LocalStewardAuthValue,
  "isAuthenticated" | "isLoading" | "user"
> {
  const ctx = useContext(LocalStewardAuthContext);
  return ctx ?? STEWARD_AUTH_FALLBACK;
}

export interface SessionAuthState {
  ready: boolean;
  authenticated: boolean;
  user: StewardSessionUser;
}

export function useSessionAuth(): SessionAuthState {
  const providerAuth = useStewardAuthContext();
  const [storageUser, setStorageUser] = useState<StewardSessionUser>(
    readStewardSessionFromStorage,
  );

  useEffect(() => {
    setStorageUser(readStewardSessionFromStorage());
    const handler = () => setStorageUser(readStewardSessionFromStorage());
    window.addEventListener("storage", handler);
    window.addEventListener("steward-token-sync", handler);
    const timer = setTimeout(handler, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("steward-token-sync", handler);
      clearTimeout(timer);
    };
  }, []);

  const providerUser: StewardSessionUser = providerAuth.user
    ? {
        id: providerAuth.user.id,
        email: providerAuth.user.email ?? "",
        walletAddress: providerAuth.user.walletAddress,
      }
    : null;

  const user = providerUser ?? storageUser;
  const authenticated = providerAuth.isAuthenticated || storageUser !== null;
  const ready = !providerAuth.isLoading;

  return { ready, authenticated, user };
}

export function useRequireAuth(): SessionAuthState {
  return useSessionAuth();
}
