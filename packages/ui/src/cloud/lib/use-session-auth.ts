/**
 * Canonical "is the user logged in" hook for every app-hosted cloud domain.
 *
 * Reads the Steward auth context the cloud shell exposes
 * (`LocalStewardAuthContext` in `../shell/StewardProvider`). The shell only
 * mounts the heavy `@stwd/*` runtime on demand, so this hook also falls back to
 * reading the JWT directly from `localStorage` (decoded, expiry-checked) when
 * the provider isn't mounted — keeping authed cloud views able to gate on
 * `{ ready, authenticated, user }` without forcing the runtime to load.
 *
 * Test builds (`VITE_PLAYWRIGHT_TEST_AUTH` / `NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH`)
 * also honor the Playwright `eliza-test-auth` marker cookie so browser-driven
 * suites can exercise authed surfaces against a mock stack.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { useContext, useEffect, useState } from "react";
import {
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../shell/StewardProvider";
import { decodeJwtPayload } from "./jwt";

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

const PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE = "eliza-test-auth";
const PLAYWRIGHT_TEST_USER_ID = "22222222-2222-4222-8222-222222222222";
const PLAYWRIGHT_TEST_USER_EMAIL = "local-live-test-user@agent.local";

/**
 * Read each env var by its literal name — Vite inlines custom `VITE_*` vars only
 * on literal property access; a dynamic lookup returns `undefined` in prod and
 * silently disables the Playwright test-auth bypass.
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
  const [testUser, setTestUser] = useState<StewardSessionUser>(
    readPlaywrightTestSession,
  );

  useEffect(() => {
    const handler = () => {
      setStorageUser(readStewardSessionFromStorage());
      setTestUser(readPlaywrightTestSession());
    };
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

  const providerUser: StewardSessionUser = providerAuth.user
    ? {
        id: providerAuth.user.id,
        email: providerAuth.user.email ?? "",
        walletAddress: providerAuth.user.walletAddress,
      }
    : null;

  const user = providerUser ?? storageUser ?? testUser;
  const authenticated =
    providerAuth.isAuthenticated || storageUser !== null || testUser !== null;
  const ready = !providerAuth.isLoading || isPlaywrightTestAuthEnabled();

  return { ready, authenticated, user };
}

/** The session state for protected pages (gate rendering on `authenticated`). */
export function useRequireAuth(): SessionAuthState {
  return useSessionAuth();
}
