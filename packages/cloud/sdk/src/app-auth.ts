/**
 * Builds the canonical third-party app authorize URL for the Eliza Cloud
 * app-auth (OAuth-style) flow — the redirect a host app sends a user to so
 * Cloud can grant it scoped access. Pure URL construction; no network calls.
 */

import { DEFAULT_ELIZA_CLOUD_BASE_URL } from "./types.js";

export const APP_AUTHORIZE_PATH = "/app-auth/authorize";

export interface BuildAppAuthorizeUrlOptions {
  appId: string;
  redirectUri: string;
  state?: string;
  baseUrl?: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function buildAppAuthorizeUrl({
  appId,
  redirectUri,
  state,
  baseUrl = DEFAULT_ELIZA_CLOUD_BASE_URL,
}: BuildAppAuthorizeUrlOptions): string {
  const url = new URL(APP_AUTHORIZE_PATH, `${trimTrailingSlash(baseUrl)}/`);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}
