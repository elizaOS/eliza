/**
 * Shared Steward session plumbing for the cloud shell: token storage keys and the
 * session/refresh endpoints the Steward auth provider uses.
 */
import {
  clearStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { createContext } from "react";
import { scrubPersistedAgentProfileTokens } from "../../state/agent-profiles";
import { scrubPersistedActiveServerToken } from "../../state/persistence";
import { decodeJwtPayload } from "../lib/jwt";
import { ELIZA_CLOUD_DIRECT_API_BY_HOST } from "./steward-url";

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

// On co-hosted elizacloud.ai surfaces, session-sync + refresh bypass the
// Pages/Worker proxy and call each host's OWN API worker directly (the shared
// host → worker map in steward-url.ts). Everywhere else they stay same-origin.
function directCloudApiBase(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return ELIZA_CLOUD_DIRECT_API_BY_HOST[window.location.hostname.toLowerCase()];
}

function directStewardSessionEndpoint(): string | undefined {
  const base = directCloudApiBase();
  return base ? `${base}${STEWARD_SESSION_ENDPOINT}` : undefined;
}

function directStewardRefreshEndpoint(): string | undefined {
  const base = directCloudApiBase();
  return base ? `${base}${STEWARD_REFRESH_ENDPOINT}` : undefined;
}

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
  return directCloudApiBase() !== undefined;
}

function configuredApiBase(): string | undefined {
  return (
    import.meta.env?.VITE_API_URL ||
    import.meta.env?.NEXT_PUBLIC_API_URL ||
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_API_URL
      : undefined)
  );
}

export function configuredSessionEndpoint(): string {
  const apiBase = configuredApiBase();
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_SESSION_ENDPOINT}`;
    }
  }
  const direct = directStewardSessionEndpoint();
  if (direct) {
    return direct;
  }
  return STEWARD_SESSION_ENDPOINT;
}

export function configuredRefreshEndpoint(): string {
  const apiBase = configuredApiBase();
  if (apiBase && !isPlaceholderValue(apiBase)) {
    if (!(isBrowserOnElizaHost() && isLocalhostApiBase(apiBase))) {
      return `${trimTrailingSlash(apiBase)}${STEWARD_REFRESH_ENDPOINT}`;
    }
  }
  const direct = directStewardRefreshEndpoint();
  if (direct) {
    return direct;
  }
  return STEWARD_REFRESH_ENDPOINT;
}

function stewardSessionClearUrls(): string[] {
  if (typeof window === "undefined") return [configuredSessionEndpoint()];
  const urls = new Set([STEWARD_SESSION_ENDPOINT, configuredSessionEndpoint()]);
  const direct = directStewardSessionEndpoint();
  if (direct) {
    urls.add(direct);
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
  const payload = decodeJwtPayload(token);
  if (!payload) return true;
  // No exp claim ⇒ treat as expired. Steward always mints exp; an exp-less
  // token is foreign/malformed, and since the 401 handlers keep any
  // NON-expired token, an exp-less one would otherwise be uncloseable — no
  // 401 could ever clear it and it never ages out on its own.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return true;
  }
  return payload.exp * 1000 < Date.now();
}

export function tokenSecsRemaining(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return null;
  return payload.exp - Date.now() / 1000;
}

export function clearStaleStewardSession(): void {
  if (typeof window === "undefined") return;
  clearStoredStewardToken();
  // SECURITY: also scrub the persisted accessToken mirrors so the secondary
  // sign-out / 401-self-heal paths that route through here (native apps-studio
  // signOut, the authorize-content edge, StewardProviderRuntime 401 clears) don't
  // leave a usable cloud bearer/API-key at rest in localStorage.
  scrubPersistedActiveServerToken();
  scrubPersistedAgentProfileTokens();
  clearServerStewardSessionCookies();
  try {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  } catch {
    // ignore
  }
}
