/**
 * Shared Steward session plumbing for the cloud shell: token storage keys and the
 * session/refresh endpoints the Steward auth provider uses.
 */
import {
  clearStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
  StewardTokenRemovalError,
} from "@elizaos/shared/steward-session-client";
import { createContext } from "react";
import {
  removeManagedSharedCloudAgentProfiles,
  scrubPersistedAgentProfileTokens,
} from "../../state/agent-profiles";
import { scrubPersistedActiveServerToken } from "../../state/persistence";
import { clearSharedCloudAccountBinding } from "../../state/shared-cloud-account-binding";
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

// On canonical Eliza UI hosts, session-sync and refresh stay same-origin via
// the Pages/Worker proxy. Steward cookies are host-only, so sending these calls
// directly to api.eliza.app would plant cookies on the API host and make them
// invisible to eliza.app/cloud.eliza.app. The host map is environment-aware;
// unknown/native origins may still use an explicit API base below.
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
  const direct = directStewardSessionEndpoint();
  if (direct) {
    return direct;
  }
  const apiBase = configuredApiBase();
  if (apiBase && !isPlaceholderValue(apiBase)) {
    return `${trimTrailingSlash(apiBase)}${STEWARD_SESSION_ENDPOINT}`;
  }
  return STEWARD_SESSION_ENDPOINT;
}

export function configuredRefreshEndpoint(): string {
  const direct = directStewardRefreshEndpoint();
  if (direct) {
    return direct;
  }
  const apiBase = configuredApiBase();
  if (apiBase && !isPlaceholderValue(apiBase)) {
    return `${trimTrailingSlash(apiBase)}${STEWARD_REFRESH_ENDPOINT}`;
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
    // error-policy:J6 best-effort sign-out cookie clear across session hosts;
    // the local token is already cleared and an expired cookie self-heals.
    fetch(url, { method: "DELETE", credentials: "include" }).catch(
      () => undefined,
    );
  }
}

export function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    // error-policy:J3 storage unavailable reads as signed-out (fail-closed).
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

export async function clearStaleStewardSession(): Promise<void> {
  if (typeof window === "undefined") return;
  let storedTokenClearError: unknown;
  try {
    await clearStoredStewardToken();
  } catch (error) {
    if (error instanceof StewardTokenRemovalError) throw error;
    // error-policy:J2 canonical invalidation may already have succeeded before
    // obsolete refresh-key cleanup failed. Finish every credential teardown,
    // then rethrow the original storage error with its stack intact.
    storedTokenClearError = error;
  }
  // Every shared-agent profile belongs to the ending Steward account, even
  // when a dedicated or self-hosted target happens to be active at sign-out.
  removeManagedSharedCloudAgentProfiles();
  // SECURITY: also scrub the persisted accessToken mirrors so the secondary
  // sign-out / 401-self-heal paths that route through here (native apps-studio
  // signOut, the authorize-content edge, StewardProviderRuntime 401 clears) don't
  // leave a usable cloud bearer/API-key at rest in localStorage.
  if (clearSharedCloudAccountBinding()) {
    // Shared runtime authorization is the Steward account itself. Once that
    // account session ends, retaining its selected agent id can bind the next
    // login to an agent outside the newly authenticated organization. Remove
    // the selection so the normal post-login flow resolves the current
    // account's organization-scoped agent list before mounting chat.
  } else {
    // Dedicated/self-hosted targets have an independent agent-local recovery
    // path, so preserve their selection while removing the rejected bearer.
    scrubPersistedActiveServerToken();
  }
  scrubPersistedAgentProfileTokens();
  clearServerStewardSessionCookies();
  try {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  } catch {
    // error-policy:J6 best-effort sync notification after credentials are scrubbed.
  }
  if (storedTokenClearError !== undefined) throw storedTokenClearError;
}
