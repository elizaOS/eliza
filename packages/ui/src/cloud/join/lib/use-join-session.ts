/**
 * Minimal Steward session-auth read for the join page.
 *
 * Reads the cloud shell's {@link LocalStewardAuthContext} (provided by
 * `StewardAuthProvider` for authenticated cloud routes) with a localStorage
 * fallback so the page resolves auth even before the heavy `@stwd/*` runtime
 * mounts. Mirrors the per-domain `useSessionAuth` pattern (account-security /
 * instances / public-pages) without cross-domain coupling — the join domain owns
 * only what it needs: `{ ready, authenticated }`.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { useContext, useEffect, useState } from "react";
import { decodeJwtPayload } from "../../lib/jwt";
import { LocalStewardAuthContext } from "../../shell/StewardProvider";

function isPlaywrightTestAuthEnabled(): boolean {
  if (import.meta.env?.VITE_PLAYWRIGHT_TEST_AUTH === "true") return true;
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true"
  ) {
    return true;
  }
  return false;
}

function tokenIsLive(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return false;
  }
  return true;
}

function readStoredAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const token = window.localStorage.getItem(STEWARD_TOKEN_KEY);
    return token ? tokenIsLive(token) : false;
  } catch {
    return false;
  }
}

export interface JoinSessionAuthState {
  /** True once the auth state is settled (provider not loading). */
  ready: boolean;
  /** True when a live Steward session exists. */
  authenticated: boolean;
}

export function useJoinSessionAuth(): JoinSessionAuthState {
  const providerAuth = useContext(LocalStewardAuthContext);
  const [storageAuthed, setStorageAuthed] = useState(readStoredAuthenticated);

  useEffect(() => {
    const handler = () => setStorageAuthed(readStoredAuthenticated());
    handler();
    window.addEventListener("storage", handler);
    window.addEventListener("steward-token-sync", handler);
    const timer = setTimeout(handler, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("steward-token-sync", handler);
      clearTimeout(timer);
    };
  }, []);

  const authenticated =
    (providerAuth?.isAuthenticated ?? false) || storageAuthed;
  const ready =
    !(providerAuth?.isLoading ?? false) || isPlaywrightTestAuthEnabled();

  return { ready, authenticated };
}
