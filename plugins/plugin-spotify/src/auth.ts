/**
 * Spotify OAuth plumbing shared by the managed connector flow and self-hosted
 * local mode: endpoint constants, the scope catalog, PKCE helpers, and the
 * token-endpoint grants (authorization-code exchange and refresh). Every fetch
 * carries a hard deadline; failures surface as typed `ElizaError`s so callers
 * can distinguish a revoked grant from a transient upstream failure.
 *
 * Local mode resolves SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET /
 * SPOTIFY_REFRESH_TOKEN through `runtime.getSetting` and never touches the
 * connector-account storage; managed mode never reads those settings for
 * token refresh because each account carries its own grant.
 */
import { createHash, randomBytes } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { SpotifyTokens } from "./types";

export const SPOTIFY_AUTHORIZE_ENDPOINT = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
export const SPOTIFY_API_BASE = "https://api.spotify.com";

/** Maximum time allowed for one Spotify accounts-service request. */
export const SPOTIFY_OAUTH_FETCH_TIMEOUT_MS = 15_000;

/**
 * The consolidated grant requested by managed OAuth. Read scopes cover search
 * enrichment, library, and playlists; the two playback scopes are what device
 * handoff and transport control require (and are premium-gated server-side).
 */
export const SPOTIFY_OAUTH_SCOPES = [
  "user-read-email",
  "user-read-private",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-playback-state",
  "user-modify-playback-state",
] as const;

export interface SpotifyLocalConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function createCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

export function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True when every local-mode setting is present. */
export function hasLocalConfig(runtime: IAgentRuntime): boolean {
  return Boolean(
    nonEmptyString(runtime.getSetting?.("SPOTIFY_CLIENT_ID")) &&
      nonEmptyString(runtime.getSetting?.("SPOTIFY_CLIENT_SECRET")) &&
      nonEmptyString(runtime.getSetting?.("SPOTIFY_REFRESH_TOKEN"))
  );
}

export function readLocalConfig(runtime: IAgentRuntime): SpotifyLocalConfig {
  const clientId = nonEmptyString(runtime.getSetting?.("SPOTIFY_CLIENT_ID"));
  const clientSecret = nonEmptyString(runtime.getSetting?.("SPOTIFY_CLIENT_SECRET"));
  const refreshToken = nonEmptyString(runtime.getSetting?.("SPOTIFY_REFRESH_TOKEN"));
  if (!clientId || !clientSecret || !refreshToken) {
    throw new ElizaError(
      "Spotify local mode requires SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN.",
      {
        code: "SPOTIFY_CONFIG_MISSING",
        context: {
          hasClientId: Boolean(clientId),
          hasClientSecret: Boolean(clientSecret),
          hasRefreshToken: Boolean(refreshToken),
        },
        severity: "fatal",
      }
    );
  }
  return { clientId, clientSecret, refreshToken };
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
}

function parseTokenResponse(payload: unknown, fallbackRefreshToken?: string): SpotifyTokens {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Partial<SpotifyTokenResponse>)
      : undefined;
  const accessToken = nonEmptyString(record?.access_token);
  const expiresIn = record?.expires_in;
  if (!accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new ElizaError("Spotify token endpoint returned an invalid payload.", {
      code: "SPOTIFY_UPSTREAM_INVALID",
      context: { hasAccessToken: Boolean(accessToken), expiresInType: typeof expiresIn },
      severity: "fatal",
    });
  }
  const refreshToken = nonEmptyString(record?.refresh_token) ?? fallbackRefreshToken;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    scope: nonEmptyString(record?.scope) ?? "",
  };
}

async function tokenGrant(
  params: URLSearchParams,
  args: { clientId: string; clientSecret?: string; fallbackRefreshToken?: string },
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<SpotifyTokens> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (args.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString(
      "base64"
    )}`;
  } else {
    params.set("client_id", args.clientId);
  }
  let response: Response;
  try {
    response = await fetchImpl(SPOTIFY_TOKEN_ENDPOINT, {
      method: "POST",
      headers,
      body: params.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // error-policy:J2 wrap the transport failure with a typed domain error.
    throw new ElizaError("Spotify token endpoint request failed.", {
      code: "SPOTIFY_UPSTREAM_FAILED",
      context: { grantType: params.get("grant_type") },
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorCode =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : undefined;
    if (errorCode === "invalid_grant") {
      throw new ElizaError("Spotify authorization has been revoked or expired.", {
        code: "SPOTIFY_AUTH_REVOKED",
        context: { status: response.status },
        severity: "fatal",
      });
    }
    throw new ElizaError(`Spotify token endpoint failed with ${response.status}.`, {
      code: "SPOTIFY_UPSTREAM_FAILED",
      context: { status: response.status, error: errorCode ?? null },
      severity: "fatal",
    });
  }
  return parseTokenResponse(body, args.fallbackRefreshToken);
}

export async function exchangeAuthorizationCode(
  args: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    code: string;
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = SPOTIFY_OAUTH_FETCH_TIMEOUT_MS
): Promise<SpotifyTokens> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  if (args.codeVerifier) params.set("code_verifier", args.codeVerifier);
  return tokenGrant(params, args, fetchImpl, timeoutMs);
}

export async function refreshAccessToken(
  args: { clientId: string; clientSecret?: string; refreshToken: string },
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = SPOTIFY_OAUTH_FETCH_TIMEOUT_MS
): Promise<SpotifyTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  return tokenGrant(
    params,
    { ...args, fallbackRefreshToken: args.refreshToken },
    fetchImpl,
    timeoutMs
  );
}
