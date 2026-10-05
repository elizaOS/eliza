import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicInternetAddress } from "@elizaos/core";

const ALLOW_INSECURE_WEBHOOK_URLS =
  process.env.STEWARD_ALLOW_INSECURE_WEBHOOK_URLS === "true";

export function validateWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password)
      return "url must not include credentials";

    if (parsed.protocol !== "https:") {
      if (!ALLOW_INSECURE_WEBHOOK_URLS || parsed.protocol !== "http:") {
        return "url must use https";
      }
    }

    const hostname = parsed.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/g, "")
      .toLowerCase();
    if (!hostname) return "url must include a host";
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return "url host must be public";
    }
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      return "url host must be public";
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4 && !isPublicInternetAddress(hostname, 4))
      return "url host must be public";
    if (
      ipVersion === 6 &&
      !isPublicInternetAddress(hostname, 6, { allowTranslatedIpv4: true })
    )
      return "url host must be public";

    return null;
  } catch {
    return "url must be a valid HTTPS URL";
  }
}

// ─── DNS-resolving validation (SEC-017) ──────────────────────────────────────

export type DnsAnswer = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<DnsAnswer[]>;

const defaultResolver: DnsResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function isNonPublicAddress(address: string, family?: number): boolean {
  const normalized = address.toLowerCase();
  const version = isIP(normalized);
  if (version === 0 || (family !== undefined && family !== version))
    return true;
  if (version === 4) return !isPublicInternetAddress(normalized, 4);
  if (version === 6)
    return !isPublicInternetAddress(normalized, 6, {
      allowTranslatedIpv4: true,
    });
  // Kept as an explicit fail-closed fallback if Node adds another family.
  return true;
}

/**
 * SEC-017: `validateWebhookUrl` only inspects the hostname STRING, so a name
 * like `169.254.169.254.nip.io` (public DNS → link-local) or a DNS rebinding
 * (public A record at config time, private at fetch time) passes it. This
 * async variant additionally resolves the hostname and rejects when ANY
 * answer is a non-public address, failing closed on resolution errors. Use it
 * at registration time AND at delivery time (fresh answers close the
 * config→fetch rebinding window). The resolver is injectable for tests.
 */
export async function validateWebhookUrlResolved(
  url: string,
  resolver: DnsResolver = defaultResolver,
): Promise<string | null> {
  const stringError = validateWebhookUrl(url);
  if (stringError) return stringError;

  let hostname: string;
  try {
    hostname = new URL(url).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/g, "")
      .toLowerCase();
  } catch {
    return "url must be a valid HTTPS URL";
  }
  // IP literals are fully covered by the string-level checks above.
  if (isIP(hostname)) return null;

  let answers: DnsAnswer[];
  try {
    answers = await resolver(hostname);
  } catch {
    return "url host could not be resolved";
  }
  if (answers.length === 0) return "url host could not be resolved";
  for (const answer of answers) {
    if (isNonPublicAddress(answer.address, answer.family)) {
      return "url host must resolve to a public address";
    }
  }
  return null;
}
