import { resolveBrowserStewardApiUrl } from "@/lib/steward-url";

const DEFAULT_STEWARD_TENANT_ID = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID || "elizacloud";

export type StewardOAuthProvider = "google" | "discord" | "github";

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  origin: string,
  options?: {
    redirectSearch?: string;
    stewardApiUrl?: string;
    stewardTenantId?: string;
  },
): string {
  let redirectSearch = options?.redirectSearch ?? "";
  if (redirectSearch && !redirectSearch.startsWith("?")) {
    redirectSearch = `?${redirectSearch}`;
  }
  const redirectUri = `${origin}/login${redirectSearch}`;
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    tenant_id: options?.stewardTenantId ?? DEFAULT_STEWARD_TENANT_ID,
  });

  const stewardApiUrl = options?.stewardApiUrl ?? resolveBrowserStewardApiUrl(origin);

  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}
