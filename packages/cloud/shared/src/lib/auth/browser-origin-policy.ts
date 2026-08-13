/**
 * Canonical browser-origin and CSRF policy for Steward session mutations. It
 * permits the exact Eliza-owned UI hosts, explicit redirect-era hosts, and
 * same-origin requests without trusting arbitrary eliza.app subdomains.
 */

import { ELIZA_DOMAIN_CONTRACTS, LEGACY_ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";

const ELIZA_BROWSER_ORIGIN_HOSTS: ReadonlySet<string> = new Set([
  ...Object.values(ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    new URL(contract.marketingOrigin).hostname,
    new URL(contract.cloudAppOrigin).hostname,
  ]),
  `www.${new URL(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin).hostname}`,
  ...Object.values(LEGACY_ELIZA_DOMAIN_CONTRACTS).flatMap((contract) => [
    ...contract.marketingHostnames,
    ...contract.cloudAppHostnames,
  ]),
  "elizaos.ai",
  "www.elizaos.ai",
]);

const LOCAL_DEV_ORIGIN_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

export interface RequestHeaderReader {
  header(name: string): string | undefined;
}

export type BrowserOriginCheck = { ok: true } | { ok: false; reason: string };

export function browserOriginHost(rawOrigin: string | undefined): string | null {
  if (!rawOrigin) return null;
  try {
    return new URL(rawOrigin).hostname.toLowerCase();
  } catch {
    // error-policy:J3 malformed browser origin is an explicit invalid result.
    return null;
  }
}

export function isPermittedElizaBrowserOrigin(
  origin: string | null,
  requestHost: string | null,
  isProduction: boolean,
): boolean {
  if (!origin) return false;
  if (ELIZA_BROWSER_ORIGIN_HOSTS.has(origin)) return true;
  if (requestHost && origin === requestHost) return true;
  return !isProduction && LOCAL_DEV_ORIGIN_HOSTS.has(origin);
}

export function checkElizaMutatingRequestOrigin(
  req: RequestHeaderReader,
  isProduction: boolean,
): BrowserOriginCheck {
  const origin = browserOriginHost(req.header("origin"));
  const referer = browserOriginHost(req.header("referer"));
  const requestHost = (req.header("host") ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (!origin && !referer) {
    return { ok: false, reason: "missing_origin_and_referer" };
  }
  if (origin && isPermittedElizaBrowserOrigin(origin, requestHost, isProduction)) {
    return { ok: true };
  }
  if (!origin && referer && isPermittedElizaBrowserOrigin(referer, requestHost, isProduction)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `origin=${origin ?? "null"} referer=${referer ?? "null"}`,
  };
}
