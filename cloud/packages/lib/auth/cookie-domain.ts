/**
 * Returns the Domain attribute to scope steward auth cookies to so they are
 * accessible from both www.elizacloud.ai (Pages SPA, same-origin /api/* proxy)
 * and api.elizacloud.ai (Worker host, direct cross-origin calls). Without an
 * explicit Domain the cookie is scoped to the response host only, breaking the
 * proxy path. Returns undefined for unknown hosts (localhost dev, *.pages.dev
 * previews) so cookies stay host-scoped there.
 */
export function cookieDomainForHost(
  host: string | undefined,
): string | undefined {
  const hostname = host?.split(":")[0]?.toLowerCase();
  if (!hostname) return undefined;
  if (hostname === "elizacloud.ai" || hostname.endsWith(".elizacloud.ai")) {
    return "elizacloud.ai";
  }
  return undefined;
}
