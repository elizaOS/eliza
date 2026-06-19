/**
 * Steward session-auth hook for the app-hosted Instances (agent management)
 * domain.
 *
 * Ported from `@elizaos/cloud-frontend/src/hooks/use-session-auth.ts` and rewired
 * onto the cloud shell's {@link LocalStewardAuthContext} (provided by
 * `StewardAuthProvider` for every authenticated cloud route). Keeps the
 * localStorage + Playwright-test-cookie fallbacks so a page still sees the
 * logged-in user even before the heavy `@stwd/*` runtime mounts. Returns a
 * fallback when no provider is present (Rules-of-Hooks-safe: reads the context
 * directly, never inside try/catch).
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

const PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE = "eliza-test-auth";
const PLAYWRIGHT_TEST_USER_ID = "22222222-2222-4222-8222-222222222222";
const PLAYWRIGHT_TEST_USER_EMAIL = "local-live-test-user@agent.local";

/**
 * Read each env var by its literal name — Vite inlines custom `VITE_*` vars only
 * on literal property access; a dynamic lookup returns `undefined` in prod.
 */
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

function hasCookie(name: string, value?: string): boolean {
  if (typeof document === "undefined") return false;
  const expected = value ? `${name}=${value}` : `${name}=`;
  return document.cookie
    .split(";")
    .some((part) => part.trim().startsWith(expected));
}

function readPlaywrightTestSession(): StewardSessionUser {
  if (!isPlaywrightTestAuthEnabled()) return null;
  if (!hasCookie(PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE, "1")) return null;
  return {
    id: PLAYWRIGHT_TEST_USER_ID,
    email: PLAYWRIGHT_TEST_USER_EMAIL,
  };
}

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
 * Safe wrapper around the Steward auth context that returns a fallback when no
 * provider is mounted. Reads the context directly (Rules-of-Hooks-safe).
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
  const [playwrightTestUser, setPlaywrightTestUser] =
    useState<StewardSessionUser>(readPlaywrightTestSession);

  useEffect(() => {
    setStorageUser(readStewardSessionFromStorage());
    setPlaywrightTestUser(readPlaywrightTestSession());

    const handler = () => {
      setStorageUser(readStewardSessionFromStorage());
      setPlaywrightTestUser(readPlaywrightTestSession());
    };
    window.addEventListener("storage", handler);
    window.addEventListener("steward-token-sync", handler);
    const timer = setTimeout(handler, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("steward-token-sync", handler);
      clearTimeout(timer);
    };
  }, []);

  const stewardUser =
    (providerAuth.user as StewardSessionUser) ??
    storageUser ??
    playwrightTestUser;
  const stewardAuthenticated =
    providerAuth.isAuthenticated ||
    storageUser !== null ||
    playwrightTestUser !== null;

  const ready = !providerAuth.isLoading || isPlaywrightTestAuthEnabled();

  return {
    ready,
    authenticated: stewardAuthenticated,
    authSource: stewardAuthenticated ? "steward" : "none",
    stewardAuthenticated,
    stewardUser,
    user: stewardUser,
  };
}

/** The session state for protected pages (cloud-frontend `useRequireAuth`). */
export function useRequireAuth(): SessionAuthState {
  return useSessionAuth();
}
