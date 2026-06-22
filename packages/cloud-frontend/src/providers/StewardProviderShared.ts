"use client";

import {
  clearStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { createContext } from "react";

export function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("your_steward_") ||
    normalized.includes("your-steward-") ||
    normalized.includes("replace_with") ||
    normalized.includes("placeholder")
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const ELIZA_CLOUD_COOKIE_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);
const ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT =
  "https://api.elizacloud.ai/api/auth/steward-session";
const ELIZA_CLOUD_DIRECT_REFRESH_ENDPOINT =
  "https://api.elizacloud.ai/api/auth/steward-refresh";

export type LocalStewardAuthValue = {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: {
    id: string;
    email?: string | null;
    walletAddress?: string;
    wallet_address?: string;
  } | null;
  session: unknown;
  signOut: () => unknown;
  getToken: () => unknown;
  verifyEmailCallback: (
    token: string,
    email: string,
  ) => Promise<{ token: string; refreshToken?: string }>;
};

export const LocalStewardAuthContext =
  createContext<LocalStewardAuthValue | null>(null);

function isLocalhostApiBase(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(
    value.trim(),
  );
}

function isBrowserOnElizaHost(): boolean {
  return (
    typeof window !== "undefined" &&
    ELIZA_CLOUD_COOKIE_HOSTS.has(window.location.hostname.toLowerCase())
  );
}

export function configuredSessionEndpoint(): string {
  // Vite inlines these only via the literal property name; do not rewrite
  // these to a dynamic lookup helper.
  const apiBase =
    import.meta.env?.VITE_API_URL ||
    import.meta.env?.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_URL;
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_SESSION_ENDPOINT}`;
    }
  }
  if (isBrowserOnElizaHost()) {
    return ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT;
  }
  return STEWARD_SESSION_ENDPOINT;
}

export function configuredRefreshEndpoint(): string {
  const apiBase =
    import.meta.env?.VITE_API_URL ||
    import.meta.env?.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_URL;
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_REFRESH_ENDPOINT}`;
    }
  }
  if (isBrowserOnElizaHost()) {
    return ELIZA_CLOUD_DIRECT_REFRESH_ENDPOINT;
  }
  return STEWARD_REFRESH_ENDPOINT;
}

function stewardSessionClearUrls(): string[] {
  if (typeof window === "undefined") return [configuredSessionEndpoint()];
  const urls = new Set([STEWARD_SESSION_ENDPOINT, configuredSessionEndpoint()]);
  if (isBrowserOnElizaHost()) {
    urls.add(ELIZA_CLOUD_DIRECT_SESSION_ENDPOINT);
  }
  return [...urls];
}

export function clearServerStewardSessionCookies(): void {
  for (const url of stewardSessionClearUrls()) {
    fetch(url, { method: "DELETE", credentials: "include" }).catch(() => {});
  }
}

export function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function tokenIsExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded));
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export function tokenSecsRemaining(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded));
    if (!payload.exp) return null;
    return payload.exp - Date.now() / 1000;
  } catch {
    return null;
  }
}

export function clearStaleStewardSession(): void {
  if (typeof window === "undefined") return;
  clearStoredStewardToken();
  clearServerStewardSessionCookies();
  try {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  } catch {
    // ignore
  }
}
