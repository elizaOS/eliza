import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";
import {
  buildStewardOAuthAuthorizeUrl as buildStewardOAuthAuthorizeUrlCore,
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardPkceVerifier,
  storeStewardPkceVerifier,
  type StewardOAuthProvider,
  type StewardPkcePair,
} from "@elizaos/shared/steward-session-client";

const DEFAULT_STEWARD_TENANT_ID =
  process.env.NEXT_PUBLIC_STEWARD_TENANT_ID || "elizacloud";

export type { StewardOAuthProvider, StewardPkcePair };

export {
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardPkceVerifier,
  storeStewardPkceVerifier,
};

/**
 * Build the redirect_uri we hand to Steward. Kept as a single function so the
 * value we send at /authorize time exactly matches the value we send at
 * /exchange time — Steward rejects the exchange if they differ.
 */
export function buildStewardOAuthRedirectUri(origin: string): string {
  // Keep the OAuth redirect URI stable. Steward allowlists exact redirect URLs
  // for tenant OAuth; putting volatile login query params (returnTo, app auth,
  // CLI state, etc.) in redirect_uri makes legitimate production logins miss
  // the allowlist. Preserve post-login destinations outside redirect_uri.
  return `${origin}/login`;
}

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  origin: string,
  options?: {
    stewardApiUrl?: string;
    stewardTenantId?: string;
    /**
     * PKCE S256 challenge. Steward's `/auth/oauth/:provider/authorize` rejects
     * `response_type=code` without it (`code_challenge is required for
     * response_type=code`). Pair it with the verifier replayed at /exchange via
     * {@link createStewardPkcePair} + {@link storeStewardPkceVerifier}.
     */
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
