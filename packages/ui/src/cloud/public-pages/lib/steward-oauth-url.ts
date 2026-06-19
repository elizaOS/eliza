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

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  origin: string,
  options?: {
    stewardApiUrl?: string;
    stewardTenantId?: string;
    codeChallenge?: string;
  },
): string {
  const stewardApiUrl =
    options?.stewardApiUrl ?? resolveBrowserStewardApiUrl(origin);
  return buildStewardOAuthAuthorizeUrlCore(
    provider,
    buildStewardOAuthRedirectUri(origin),
    {
      stewardApiUrl,
      stewardTenantId: options?.stewardTenantId ?? DEFAULT_STEWARD_TENANT_ID,
      codeChallenge: options?.codeChallenge,
    },
  );
}
