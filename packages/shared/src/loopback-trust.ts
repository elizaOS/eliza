/**
 * Same-machine ("loopback") request trust evaluation.
 *
 * This is a SECURITY BOUNDARY: it decides whether an unauthenticated HTTP
 * request is allowed to act as the local dashboard owner. Previously the exact
 * same logic was triplicated across `@elizaos/app-core` (`compat-route-shared`)
 * and `@elizaos/agent` (`server-helpers-auth`), with subtly divergent env-policy
 * gates and a non-equivalent `isLoopbackBindHost`. The divergence was a parity
 * hazard, so the logic is unified here and parameterised so each consumer keeps
 * its EXACT prior trust decisions.
 *
 * The two consumers differ ONLY in their policy gates, expressed via
 * {@link LoopbackTrustOptions}:
 *  - app-core: requireLocalAuthEnv + devAuthBypassEnv, cloudCheck "env"
 *    (`ELIZA_CLOUD_PROVISIONED === "1"` through the boot alias table).
 *  - agent:    requireLocalAuthEnv (no dev bypass), cloudCheck "container"
 *    (`isCloudProvisionedContainer()` — flag AND a provisioning token).
 *
 * The host/origin classification (`isLoopbackBindHost`) is the canonical strict
 * implementation from `runtime-env.ts` for BOTH consumers. For app-core this is
 * byte-identical (it already imported the shared helper). For the agent this is
 * a strict tightening in the safe direction: the agent's hand-rolled copy
 * accepted any `127.*`-prefixed host string (e.g. the DNS-rebinding host
 * `127.0.0.1.evil.com`), which the strict parser correctly rejects. The change
 * can only ever turn a previously-trusted request into an untrusted one, never
 * the reverse.
 *
 * Browser HTTP(S) origins and referrers must match the request Host authority,
 * including an explicit non-default port. This prevents another loopback web
 * server from inheriting owner trust merely because it also uses localhost.
 * Native application schemes remain eligible for the same-machine policy.
 */

import type http from "node:http";
import { BlockList, isIP } from "node:net";
import { isCloudProvisionedContainer } from "./elizacloud/cloud-provisioning.js";
import { isLoopbackBindHost } from "./runtime-env.js";
import { readAliasedEnv } from "./utils/env.js";

export interface LoopbackTrustOptions {
  /**
   * When true, deny local trust if `ELIZA_REQUIRE_LOCAL_AUTH === "1"`. On-device
   * local agents (Android) set this flag alongside a per-boot API token because
   * the loopback interface is shared with every other app on the device, so
   * loopback alone is NOT a trust signal there.
   */
  requireLocalAuthEnv: boolean;
  /**
   * When true, `ELIZA_DEV_AUTH_BYPASS === "1"` in a development `NODE_ENV`
   * overrides {@link requireLocalAuthEnv}, restoring local trust for the dev
   * dashboard. Only app-core honours this; the agent never does.
   */
  devAuthBypassEnv: boolean;
  /**
   * Cloud-container detection strategy. `"env"` trusts the raw
   * `ELIZA_CLOUD_PROVISIONED` flag; `"container"` requires the flag AND a
   * provisioning token (see {@link isCloudProvisionedContainer}). These are
   * DIFFERENT semantics — do not swap them between consumers.
   */
  cloudCheck: "env" | "container";
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

const CLIENT_IP_PROXY_HEADERS = new Set([
  "forwarded",
  "forwarded-for",
  "x-forwarded",
  "x-forwarded-for",
  "x-original-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "x-forwarded-client-ip",
  "x-cluster-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-appengine-user-ip",
  "x-azure-clientip",
]);

function headerValues(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function isClientIpProxyHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    CLIENT_IP_PROXY_HEADERS.has(normalized) ||
    normalized.endsWith("-client-ip") ||
    normalized.endsWith("-connecting-ip") ||
    normalized.endsWith("-real-ip")
  );
}

function extractForwardedForCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const pattern = /(?:^|[;,])\s*for=(?:"([^"]*)"|([^;,]*))/gi;
  for (const match of raw.matchAll(pattern)) {
    candidates.push(match[1] ?? match[2] ?? "");
  }
  return candidates;
}

function extractProxyClientAddressCandidates(
  headerName: string,
  raw: string,
): string[] {
  if (headerName === "forwarded") {
    return extractForwardedForCandidates(raw);
  }

  const forwardedCandidates = raw.toLowerCase().includes("for=")
    ? extractForwardedForCandidates(raw)
    : [];
  if (forwardedCandidates.length > 0) return forwardedCandidates;

  return raw.split(",");
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isNeutralProxyClientAddress(raw: string): boolean {
  const normalized = stripMatchingQuotes(raw).trim().toLowerCase();
  return (
    !normalized ||
    normalized === "unknown" ||
    normalized === "null" ||
    normalized.startsWith("_")
  );
}

function normalizeProxyClientIp(raw: string): string | null {
  let normalized = stripMatchingQuotes(raw).trim();
  if (!normalized) return null;

  if (normalized.startsWith("[")) {
    const close = normalized.indexOf("]");
    if (close > 0) {
      normalized = normalized.slice(1, close);
    }
  } else {
    const ipv4HostPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)$/.exec(normalized);
    if (ipv4HostPort?.[1]) {
      normalized = ipv4HostPort[1];
    }
  }

  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }

  normalized = normalized.trim().toLowerCase();
  return isIP(normalized) ? normalized : null;
}

function isLoopbackProxyClientIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:0:127.")
  );
}

/**
 * True when any proxy-style client-IP header carries a non-loopback (or
 * unparseable) address. A request that reaches a same-machine listener but
 * advertises a remote client behind a proxy must NOT be granted local trust.
 */
export function proxyClientHeaderBlocksLocalTrust(
  headers: http.IncomingHttpHeaders,
): boolean {
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const headerName = rawName.toLowerCase();
    if (!isClientIpProxyHeaderName(headerName)) continue;

    for (const value of headerValues(rawValue)) {
      for (const candidate of extractProxyClientAddressCandidates(
        headerName,
        value,
      )) {
        if (isNeutralProxyClientAddress(candidate)) continue;
        const ip = normalizeProxyClientIp(candidate);
        if (!ip || !isLoopbackProxyClientIp(ip)) return true;
      }
    }
  }

  return false;
}

/**
 * True when the TCP peer address is a loopback address. Note this is stricter
 * than {@link isLoopbackBindHost}: it matches only fully-normalised loopback
 * addresses (no host:port or URL forms), since `socket.remoteAddress` is always
 * a bare IP.
 */
export function isLoopbackRemoteAddress(
  remoteAddress: string | null | undefined,
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  if (isIP(normalized) === 0) return false;
  return (
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:0:127.")
  );
}

/**
 * True when the TCP peer address falls inside an operator-supplied CIDR
 * allowlist: a comma-separated list of `ip[/prefix]` entries (IPv4 or IPv6; a
 * bare IP means an exact host match). The Cloud-pair relay uses this to admit
 * the local-Docker bridge gateway without opening the gate to every
 * private-range LAN/VPC peer (W5-016). Fail-closed by construction: empty
 * lists, unparseable peers, and malformed entries admit nothing. IPv4-mapped
 * IPv6 peer spellings (`::ffff:a.b.c.d`, as dual-stack sockets report them)
 * are matched against the IPv4 entries.
 */
export function isRemoteAddressInCidrList(
  remoteAddress: string | null | undefined,
  cidrList: string | null | undefined,
): boolean {
  if (!remoteAddress || !cidrList) return false;
  const entries = cidrList
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;

  const blockList = new BlockList();
  let added = 0;
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    const ip = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(ip);
    if (family === 0) continue;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (slash === -1) {
      // Bare IP = exact host. Expressed as a full-prefix subnet because not
      // every runtime's BlockList implements `add`.
      blockList.addSubnet(ip, family === 4 ? 32 : 128, type);
      added += 1;
      continue;
    }
    // Require a plain decimal prefix: Number("") parses a trailing slash as
    // 0, which would turn a malformed entry into a /0 admit-all, and Number
    // also accepts spellings like "0x10" or "+16" that operators did not
    // mean. Malformed entries must admit nothing.
    const prefixText = entry.slice(slash + 1);
    if (!/^\d+$/.test(prefixText)) continue;
    const prefix = Number(prefixText);
    const maxPrefix = family === 4 ? 32 : 128;
    if (prefix > maxPrefix) continue;
    try {
      blockList.addSubnet(ip, prefix, type);
      added += 1;
    } catch {
      // error-policy:J3 malformed operator CIDR entries admit nothing.
    }
  }
  if (added === 0) return false;

  let peer = remoteAddress.trim().toLowerCase();
  if (isIP(peer) === 6) {
    for (const mappedPrefix of ["::ffff:", "::ffff:0:"]) {
      const mapped = peer.slice(mappedPrefix.length);
      if (peer.startsWith(mappedPrefix) && isIP(mapped) === 4) {
        peer = mapped;
        break;
      }
    }
  }
  const peerFamily = isIP(peer);
  if (peerFamily === 0) return false;
  try {
    return blockList.check(peer, peerFamily === 4 ? "ipv4" : "ipv6");
  } catch {
    // error-policy:J3 an exotic-but-unmatchable peer spelling (e.g. a zoned
    // link-local address on a runtime that rejects it) admits nothing.
    return false;
  }
}

const LOCAL_APP_PROTOCOLS = new Set([
  "file:",
  "app:",
  "tauri:",
  "capacitor:",
  "capacitor-electron:",
  "electrobun:",
]);

type LocalHttpAuthority = {
  hostname: string;
  port: number | null;
};

function normalizeAuthorityHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function parseLoopbackHostAuthority(raw: string): LocalHttpAuthority | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /[/\\?#@]/.test(trimmed)) return null;

  let hostname: string;
  let portText: string | null = null;
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    if (closingBracket < 0) return null;
    hostname = trimmed.slice(1, closingBracket);
    const suffix = trimmed.slice(closingBracket + 1);
    if (suffix) {
      if (!/^:\d+$/.test(suffix)) return null;
      portText = suffix.slice(1);
    }
  } else {
    const match = /^([^:]+)(?::(\d+))?$/.exec(trimmed);
    if (!match?.[1]) return null;
    hostname = match[1];
    portText = match[2] ?? null;
  }

  if (!isLoopbackBindHost(hostname)) return null;
  if (portText === null) return { hostname, port: null };
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname, port };
}

function isTrustedLocalBrowserUrl(
  raw: string,
  host: string | null,
  allowPath: boolean,
): boolean {
  if (!host) return false;
  const hostAuthority = parseLoopbackHostAuthority(host);
  if (!hostAuthority) return false;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    if (
      !allowPath &&
      (parsed.pathname !== "/" || parsed.search || parsed.hash)
    ) {
      return false;
    }

    const originHostname = normalizeAuthorityHostname(parsed.hostname);
    if (
      !isLoopbackBindHost(originHostname) ||
      originHostname !== hostAuthority.hostname
    ) {
      return false;
    }

    const explicitOriginPort = parsed.port ? Number(parsed.port) : null;
    if (hostAuthority.port === null) return explicitOriginPort === null;
    const effectiveOriginPort =
      explicitOriginPort ?? (parsed.protocol === "https:" ? 443 : 80);
    return effectiveOriginPort === hostAuthority.port;
  } catch {
    // error-policy:J3 untrusted browser URL metadata is invalid unless its
    // authority can be parsed and proven to match the request Host.
    return false;
  }
}

function isTrustedLocalOrigin(raw: string, host: string | null): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return true;
  try {
    const parsed = new URL(trimmed);
    if (LOCAL_APP_PROTOCOLS.has(parsed.protocol)) {
      return true;
    }
    return isTrustedLocalBrowserUrl(trimmed, host, false);
  } catch {
    // error-policy:J3 untrusted Origin metadata with an invalid URL is denied.
    return false;
  }
}

function isTrustedLocalReferer(raw: string, host: string | null): boolean {
  return isTrustedLocalBrowserUrl(raw.trim(), host, true);
}

function cloudBlocksLocalTrust(cloudCheck: "env" | "container"): boolean {
  if (cloudCheck === "container") return isCloudProvisionedContainer();
  return readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1";
}

function localAuthRequired(options: LoopbackTrustOptions): boolean {
  if (!options.requireLocalAuthEnv) return false;
  if (
    options.devAuthBypassEnv &&
    process.env.ELIZA_DEV_AUTH_BYPASS === "1" &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev")
  ) {
    return false;
  }
  return process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1";
}

/**
 * Same-machine dashboard access. Intentionally stricter than a bare
 * `remoteAddress` check: the browser must also target a loopback Host and must
 * not present cross-site browser metadata or proxy client-IP headers.
 *
 * Each consumer supplies {@link LoopbackTrustOptions} matching its historical
 * policy gates; the host/origin/proxy classification is identical for all.
 */
export function isTrustedLocalRequest(
  // `socket` is declared optional because it genuinely can be absent: Node nulls
  // it once a connection is destroyed, and in-process route dispatch (tests, the
  // embedded mobile transport) invokes handlers with a synthetic request that
  // never had one. The type used to promise a socket, so the access below threw
  // a TypeError instead of reaching a trust decision.
  req: Pick<http.IncomingMessage, "headers"> & {
    socket?: Pick<http.IncomingMessage["socket"], "remoteAddress"> | null;
  },
  options: LoopbackTrustOptions,
): boolean {
  if (localAuthRequired(options)) return false;
  if (cloudBlocksLocalTrust(options.cloudCheck)) return false;
  // No socket means the peer address cannot be established, so loopback cannot
  // be PROVEN — fail closed and treat the request as untrusted. This is an
  // explicit deny, not a defaulted success: isLoopbackRemoteAddress(undefined)
  // is already false, and granting local trust on an unverifiable peer would
  // hand out the no-password local bypass to any synthetic request.
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false;
  if (proxyClientHeaderBlocksLocalTrust(req.headers)) return false;

  const host = firstHeaderValue(req.headers.host);
  if (host && !isLoopbackBindHost(host)) return false;

  const secFetchSite = firstHeaderValue(
    req.headers["sec-fetch-site"],
  )?.toLowerCase();
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return false;
  }

  const origin = firstHeaderValue(req.headers.origin);
  if (origin && !isTrustedLocalOrigin(origin, host)) return false;

  const referer = firstHeaderValue(req.headers.referer);
  if (!origin && referer && !isTrustedLocalReferer(referer, host)) return false;

  return true;
}
