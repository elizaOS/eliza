/**
 * Session-auth hook for the app-hosted cloud account/security surfaces.
 *
 * Ported from `@elizaos/cloud-frontend/src/hooks/use-session-auth.ts`. Reads the
 * Steward auth context the shell mounts (`LocalStewardAuthContext` from
 * `../../shell/StewardProvider`) and falls back to the localStorage JWT so a
 * lifted page that is mounted without the runtime provider still resolves the
 * session synchronously. The token-decode + storage-event wiring is unchanged.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { useContext, useEffect, useState } from "react";
import { decodeJwtPayload } from "../../lib/jwt";
import { LocalStewardAuthContext } from "../../shell/StewardProvider";

type SessionAuthSource = "none" | "steward";

export type StewardSessionUser = {
  id: string;
  email: string;
  walletAddress?: string;
} | null;

const STEWARD_AUTH_FALLBACK = {
  isAuthenticated: false,
  isLoading: false,
  user: null as StewardSessionUser,
  session: null,
  signOut: () => {},
  getToken: () => null,
} as const;

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
    if (!decoded) return null;
    if (decoded.exp && decoded.exp * 1000 < Date.now()) return null;
    if (!decoded.id) return null;
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
 * Safe wrapper around the Steward auth context that returns a fallback when the
 * shell's StewardProvider runtime is not mounted (cheap routes / native).
 */
export function useStewardAuth() {
  const ctx = useContext(LocalStewardAuthContext);
  return ctx ?? STEWARD_AUTH_FALLBACK;
}

export interface SessionAuthState {
  ready: boolean;
  authenticated: boolean;
  authSource: SessionAuthSource;
  stewardAuthenticated: boolean;
  stewardUser: StewardSessionUser;
  /** Resolved session user (Steward); null when signed out. */
  user: StewardSessionUser;
}

export function useSessionAuth(): SessionAuthState {
  const providerAuth = useStewardAuth();

  const [storageUser, setStorageUser] = useState<StewardSessionUser>(
    readStewardSessionFromStorage,
  );

  useEffect(() => {
    setStorageUser(readStewardSessionFromStorage());

    const handler = () => setStorageUser(readStewardSessionFromStorage());
    window.addEventListener("storage", handler);
    window.addEventListener("steward-token-sync", handler);
    const t = setTimeout(handler, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("steward-token-sync", handler);
      clearTimeout(t);
    };
  }, []);

  const stewardUser = providerAuth.user ?? storageUser;
  const stewardAuthenticated =
    providerAuth.isAuthenticated || storageUser !== null;

  const ready = !providerAuth.isLoading;
  const authSource: SessionAuthSource = stewardAuthenticated
    ? "steward"
    : "none";

  return {
    ready,
    authenticated: stewardAuthenticated,
    authSource,
    stewardAuthenticated,
    stewardUser: stewardUser as StewardSessionUser,
    user: stewardUser as StewardSessionUser,
  };
}
