// Scope steward cookies to the parent zone so they're sent on both
// www.elizacloud.ai (Pages SPA same-origin /api/* proxy) and api.elizacloud.ai
// (Worker direct calls). Unknown hosts (localhost, *.pages.dev) stay host-scoped.
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
