import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";

const DEFAULT_STEWARD_TENANT_ID =
  process.env.NEXT_PUBLIC_STEWARD_TENANT_ID || "elizacloud";

export type StewardOAuthProvider = "google" | "discord" | "github";

/**
 * Build the redirect_uri we hand to Steward. Kept as a single function so the
 * value we send at /authorize time exactly matches the value we send at
 * /exchange time — Steward rejects the exchange if they differ.
 */
export function buildStewardOAuthRedirectUri(
  origin: string,
  redirectSearch?: string,
): string {
  let normalizedSearch = redirectSearch ?? "";
  if (normalizedSearch && !normalizedSearch.startsWith("?")) {
    normalizedSearch = `?${normalizedSearch}`;
  }
  return `${origin}/login${normalizedSearch}`;
}

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  origin: string,
  options?: {
    redirectSearch?: string;
    stewardApiUrl?: string;
    stewardTenantId?: string;
  },
): string {
  const redirectUri = buildStewardOAuthRedirectUri(
    origin,
    options?.redirectSearch,
  );
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    tenant_id: options?.stewardTenantId ?? DEFAULT_STEWARD_TENANT_ID,
    // Opt into the nonce-exchange flow: Steward redirects back with
    // `?code=<nonce>` (no tokens in the URL) and we trade the code for
    // tokens server-side via /api/auth/steward-nonce-exchange.
    response_type: "code",
  });

  const stewardApiUrl =
    options?.stewardApiUrl ?? resolveBrowserStewardApiUrl(origin);

  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}
