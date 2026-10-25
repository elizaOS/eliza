/**
 * Canonical allowlist for inbound Blooio media URLs. The gateway's Blooio
 * adapter keeps a runtime-local copy (it must not depend on cloud-shared at
 * runtime); its parity test pins that copy to this module, so edit the domain
 * set here first. Dependency-free on purpose so the gateway test can import it
 * without pulling the provider stack.
 */

export const ALLOWED_BLOOIO_MEDIA_DOMAINS = [
  "blooio.com",
  "backend.blooio.com",
  "api.blooio.com",
  "media.blooio.com",
] as const;

/** True only for an https URL on a Blooio-owned media domain. */
export function isAllowedBlooioMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 an unparsable URL is explicitly disallowed, never a default.
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return ALLOWED_BLOOIO_MEDIA_DOMAINS.some(
    (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
  );
}
