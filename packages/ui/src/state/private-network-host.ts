/**
 * Canonical "is this host on a private / loopback / LAN network" test.
 *
 * Single source of truth for the protocol-selection and cloud-login-backend
 * decisions that branch on whether the agent backend lives on the local
 * machine or LAN (`useCloudState`, `useOnboardingCallbacks`). Covers
 * loopback, RFC1918 ranges, the Tailscale CGNAT range (100.64.0.0/10), and
 * the `.local` / `.internal` mDNS / private suffixes.
 */
export function isPrivateNetworkHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }
  if (
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(normalized)
  ) {
    return true;
  }
  return false;
}
