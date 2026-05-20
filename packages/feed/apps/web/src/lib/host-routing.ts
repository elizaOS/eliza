const LEGACY_CANONICAL_HOSTS: Record<string, string> = {
  "feed.social": "feed.market",
  "www.feed.social": "feed.market",
};

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

export function isAssetRequest(pathname: string): boolean {
  return (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/assets") ||
    pathname.startsWith("/static") ||
    pathname.startsWith("/images") ||
    pathname.startsWith("/fonts") ||
    pathname.startsWith("/.well-known") ||
    pathname.startsWith("/_vercel") ||
    pathname.startsWith("/monitoring") ||
    /\.[^/]+$/.test(pathname)
  );
}

export function isLegacyCanonicalHostname(hostname: string): boolean {
  return normalizeHostname(hostname) in LEGACY_CANONICAL_HOSTS;
}

export function getLegacyCanonicalOrigin(
  hostname: string,
  protocol: string,
): string | null {
  const target = LEGACY_CANONICAL_HOSTS[normalizeHostname(hostname)];
  if (!target) return null;

  return `${protocol}//${target}`;
}
