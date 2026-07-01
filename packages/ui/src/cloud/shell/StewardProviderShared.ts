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

// Hosts where the SPA is co-hosted with a Cloudflare Pages/Worker deployment
// that proxies the Steward auth endpoints to the API worker. We bypass that
// proxy and hit the matching API worker directly so session-sync + refresh keep
// working even when the Pages Functions bundle / FRONTEND_ALIAS proxy is stale.
// Per-host base — staging MUST resolve to api-staging, NOT prod api. When it
// fell through to the same-origin relative path (staging absent here), a stale
// worker proxy 401'd a valid session and clearStaleStewardSession wiped it →
// the sign-in loop. Mirrors steward-url.ts's ELIZA_CLOUD_DIRECT_API_BY_HOST.
const ELIZA_CLOUD_DIRECT_API_BY_HOST: Record<string, string> = {
  "elizacloud.ai": "https://api.elizacloud.ai",
  "www.elizacloud.ai": "https://api.elizacloud.ai",
  "dev.elizacloud.ai": "https://api.elizacloud.ai",
  "staging.elizacloud.ai": "https://api-staging.elizacloud.ai",
};

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
  if (!payload.exp) return false;
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
