"use client";

import { useContext, useEffect, useState } from "react";
import { LocalStewardAuthContext } from "@/lib/providers/StewardProvider";

export type SessionAuthSource = "none" | "steward";

export type StewardSessionUser = { id: string; email: string; walletAddress?: string } | null;
export type SessionUser = StewardSessionUser;

/** Default state when StewardProvider is not mounted */
const STEWARD_AUTH_FALLBACK = {
  isAuthenticated: false,
  isLoading: false,
  user: null as StewardSessionUser,
  session: null,
  signOut: () => {},
  getToken: () => null,
} as const;

const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_AUTHED_COOKIE = "steward-authed";
const PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE = "eliza-test-auth";
const PLAYWRIGHT_TEST_USER_ID = "22222222-2222-4222-8222-222222222222";
const PLAYWRIGHT_TEST_USER_EMAIL = "local-live-test-user@agent.local";

type ImportMetaEnvLike = {
  env?: Record<string, string | undefined>;
};

function hasViteEnv(meta: ImportMeta): meta is ImportMeta & ImportMetaEnvLike {
  const env = (meta as ImportMetaEnvLike).env;
  return typeof env === "object" && env !== null;
}

function getViteEnvFlag(name: string): string | undefined {
  return hasViteEnv(import.meta) ? import.meta.env?.[name] : undefined;
}

function isPlaywrightTestAuthEnabled(): boolean {
  return (
    getViteEnvFlag("VITE_PLAYWRIGHT_TEST_AUTH") === "true" ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true")
  );
}

function hasCookie(name: string, value?: string): boolean {
  if (typeof document === "undefined") return false;
  const expected = value ? `${name}=${value}` : `${name}=`;
  return document.cookie.split(";").some((part) => part.trim().startsWith(expected));
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
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded));
    return {
      id: payload.userId ?? payload.sub ?? "",
      email: payload.email ?? "",
      walletAddress: payload.address ?? undefined,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** Read a valid non-expired Steward session directly from localStorage. */
function readStewardSessionFromStorage(): StewardSessionUser {
  if (typeof window === "undefined") return null;
  try {
    if (!hasCookie(STEWARD_AUTHED_COOKIE, "1")) {
      return null;
    }
    const token = localStorage.getItem(STEWARD_TOKEN_KEY);
    if (!token) return null;
    const decoded = decodeStewardToken(token);
    if (!decoded) return null;
    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      return null;
    }
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
 * Safe wrapper around the Steward auth context that returns a fallback when
 * StewardProvider is not mounted. Reads the context directly instead of
 * calling useAuth() inside try/catch (which violates Rules of Hooks).
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
  /** Resolved session user (Steward); null when signed out */
  user: StewardSessionUser;
}

export function useSessionAuth(): SessionAuthState {
  const providerAuth = useStewardAuth();

  const [storageUser, setStorageUser] = useState<StewardSessionUser>(readStewardSessionFromStorage);
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
    const t = setTimeout(handler, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("steward-token-sync", handler);
      clearTimeout(t);
    };
  }, []);

  const stewardUser = providerAuth.user ?? storageUser ?? playwrightTestUser;
  const stewardAuthenticated =
    providerAuth.isAuthenticated || storageUser !== null || playwrightTestUser !== null;

  const ready = !providerAuth.isLoading || isPlaywrightTestAuthEnabled();
  const authenticated = stewardAuthenticated;
  const authSource: SessionAuthSource = stewardAuthenticated ? "steward" : "none";

  return {
    ready,
    authenticated,
    authSource,
    stewardAuthenticated,
    stewardUser: stewardUser as StewardSessionUser,
    user: stewardUser as StewardSessionUser,
  };
}
