/**
 * Interactive credential flows the console can drive end-to-end: the Eliza
 * Cloud device-code login and a Google OAuth loopback flow. Everything else
 * in the catalog is paste-a-token.
 *
 * Cloud login speaks the same protocol as ElizaCloudClient.startCliLogin /
 * waitForCliLogin in packages/cloud/sdk/src/client.ts (POST
 * /api/auth/cli-session, then poll /api/auth/cli-session/:id until
 * `authenticated`), reimplemented over bare fetch so the console keeps zero
 * workspace imports and works in a half-built checkout — protocol drift there
 * is an API-versioning event, not a refactor hazard.
 *
 * The Google flow leans on the console being an HTTP server already: the
 * redirect URI is the console's own /oauth/google/callback route, so no
 * second loopback listener is needed. It requests offline access and returns
 * a refresh token (GOOGLE_OAUTH_REFRESH_TOKEN) plus a fresh calendar access
 * token (GOOGLE_CALENDAR_ACCESS_TOKEN) — the two vars the live suites gate on.
 */

import crypto from "node:crypto";

export const DEFAULT_CLOUD_BASE_URL = "https://elizacloud.ai";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

/** Pending interactive flows keyed by opaque state token. */
const pendingFlows = new Map();

export async function startCloudLogin({
  baseUrl = DEFAULT_CLOUD_BASE_URL,
} = {}) {
  const response = await fetch(`${baseUrl}/api/auth/cli-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "eliza-test-console" }),
  });
  if (!response.ok) {
    throw new Error(`cloud cli-session failed: HTTP ${response.status}`);
  }
  const { sessionId, browserUrl } = await response.json();
  return { sessionId, browserUrl };
}

export async function pollCloudLogin({
  sessionId,
  baseUrl = DEFAULT_CLOUD_BASE_URL,
}) {
  const response = await fetch(`${baseUrl}/api/auth/cli-session/${sessionId}`);
  if (!response.ok) {
    throw new Error(`cloud cli-session poll failed: HTTP ${response.status}`);
  }
  return response.json();
}

export function startGoogleFlow({ clientId, clientSecret, redirectUri }) {
  const state = crypto.randomBytes(24).toString("hex");
  pendingFlows.set(state, {
    provider: "google",
    clientId,
    clientSecret,
    redirectUri,
    createdAt: Date.now(),
    result: null,
  });
  // Flows are single-use and short-lived; sweep anything older than 10 min.
  for (const [key, flow] of pendingFlows) {
    if (Date.now() - flow.createdAt > 600_000) pendingFlows.delete(key);
  }
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString(), state };
}

export async function completeGoogleFlow({ state, code }) {
  const flow = pendingFlows.get(state);
  if (!flow) throw new Error("unknown or expired OAuth state");
  pendingFlows.delete(state);
  const body = new URLSearchParams({
    client_id: flow.clientId,
    client_secret: flow.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: flow.redirectUri,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `google token exchange failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
    );
  }
  return {
    refreshToken: payload.refresh_token ?? null,
    accessToken: payload.access_token,
    expiresIn: payload.expires_in,
  };
}

/** Mint a fresh access token from a saved refresh token. */
export async function refreshGoogleAccessToken({
  clientId,
  clientSecret,
  refreshToken,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(`google refresh failed: HTTP ${response.status}`);
  }
  return { accessToken: payload.access_token, expiresIn: payload.expires_in };
}
