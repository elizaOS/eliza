/**
 * Steward OAuth `/authorize` URL builder + PKCE helpers for the app-hosted
 * login surface.
 *
 * Ported from `@elizaos/cloud-frontend/src/pages/login/steward-oauth-url.ts`.
 * The redirect_uri is kept stable at `/login` (Steward allowlists exact URLs);
 * post-login destinations are carried outside redirect_uri via
 * {@link login-return-to}. Steward URL resolution uses the shell's
 * `steward-url` helper (cloud-shared is not a dep of `@elizaos/ui`).
 */

import {
  buildStewardOAuthAuthorizeUrl as buildStewardOAuthAuthorizeUrlCore,
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardPkceVerifier,
  type StewardOAuthProvider,
  type StewardPkcePair,
  storeStewardPkceVerifier,
} from "@elizaos/shared/steward-session-client";
import { resolveBrowserStewardApiUrl } from "../../shell/steward-url";

const DEFAULT_STEWARD_TENANT_ID =
  (typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_STEWARD_TENANT_ID
    : undefined) || "elizacloud";

export type { StewardOAuthProvider, StewardPkcePair };

export {
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardPkceVerifier,
  storeStewardPkceVerifier,
};

/**
 * The redirect_uri handed to Steward. A single function so the value sent at
 * /authorize time exactly matches the value sent at /exchange time (Steward
 * rejects the exchange if they differ).
 */
export function buildStewardOAuthRedirectUri(origin: string): string {
  return `${origin}/login`;
}

/**
 * The redirect_uri used for native (Capacitor iOS / Android) OAuth.
 *
 * On native, `window.location.origin` is `capacitor://localhost`, so the web
 * redirect (`capacitor://localhost/login`) is invalid and navigating the
 * embedded WKWebView to the provider black-screens the app. Instead OAuth runs
 * in the system browser and returns via the app's custom URL scheme. The host
 * is `login` (no path) so `new URL(NATIVE_OAUTH_REDIRECT_URI).host === "login"`,
 * which the deep-link return handler matches.
 *
 * This value MUST be on Steward's redirect allowlist for the tenant.
 */
export const NATIVE_OAUTH_REDIRECT_URI = "elizaos://login";

export function buildNativeOAuthRedirectUri(): string {
  return NATIVE_OAUTH_REDIRECT_URI;
}

/**
 * The single redirect_uri value to use for OAuth authorize + exchange. Returns
 * the native custom-scheme URI on Capacitor and `${origin}/login` on web.
 * Computing it once and reusing it in BOTH places guarantees the authorize and
 * exchange redirect_uri match exactly (Steward rejects mismatches).
 */
export function resolveOAuthRedirectUri(
  native: boolean,
  origin: string,
): string {
  return native
    ? NATIVE_OAUTH_REDIRECT_URI
    : buildStewardOAuthRedirectUri(origin);
}

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  origin: string,
  options?: {
    stewardApiUrl?: string;
    stewardTenantId?: string;
    codeChallenge?: string;
    /**
     * Override the redirect_uri sent to Steward. Defaults to the web
     * `${origin}/login`. Native callers pass {@link NATIVE_OAUTH_REDIRECT_URI}
     * so OAuth returns through the app's custom URL scheme. Whatever value is
     * passed here MUST be reused verbatim at exchange time.
     */
    redirectUri?: string;
  },
): string {
  const stewardApiUrl =
    options?.stewardApiUrl ?? resolveBrowserStewardApiUrl(origin);
  return buildStewardOAuthAuthorizeUrlCore(
    provider,
    options?.redirectUri ?? buildStewardOAuthRedirectUri(origin),
    {
      stewardApiUrl,
      stewardTenantId: options?.stewardTenantId ?? DEFAULT_STEWARD_TENANT_ID,
      codeChallenge: options?.codeChallenge,
    },
  );
}
