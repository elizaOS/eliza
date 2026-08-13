/**
 * Steward cookies are always host-only. The unified Pages artifact proxies
 * auth requests same-origin, while the one-time SSO bridge transfers sessions
 * between eliza.app and cloud.eliza.app without exposing cookies to dedicated
 * managed-agent or user-content subdomains.
 */
export function cookieDomainForHost(_host: string | undefined): string | undefined {
  return undefined;
}
