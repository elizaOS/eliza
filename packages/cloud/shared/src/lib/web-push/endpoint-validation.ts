/**
 * Web Push endpoint validation — SSRF guard for the subscription store.
 *
 * The cloud sender later POSTs to whatever endpoint is persisted, so an
 * unconstrained endpoint would be a blind server-side-request primitive. We
 * only ever persist an HTTPS URL to a PUBLIC host: reject http, localhost,
 * loopback/private/link-local IPv4 (incl. the 169.254.169.254 cloud-metadata
 * address), IPv6 literals, and internal TLDs. A stored endpoint can then only
 * be an third-party push service, never an internal service the Worker can reach.
 */

/** True when `value` is a safe, third-party HTTPS Web Push endpoint. */
export function isValidPushEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  // Bracketed IPv6 literals — push services use hostnames; reject outright.
  if (host.startsWith("[")) return false;

  // Block IPv4 literals in loopback / private / link-local / reserved ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
      a >= 224 // multicast / reserved
    ) {
      return false;
    }
  }

  return true;
}
