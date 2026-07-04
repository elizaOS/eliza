/**
 * SSRF guard for the completion-URL verifier.
 *
 * The verifier in `sub-agent-router.ts` GET-probes every http(s) URL it
 * extracts from *sub-agent narration* — model-controlled, untrusted text. A
 * prompt-injected or compromised sub-agent can therefore steer the parent
 * orchestrator into fetching arbitrary hosts: cloud metadata endpoints
 * (169.254.169.254), RFC1918 internal services, link-local addresses, etc.
 * That is server-side request forgery.
 *
 * This module rejects fetches whose target resolves to a non-public address,
 * with one deliberate carve-out: *loopback* (127.0.0.0/8, ::1, `localhost`) is
 * allowed. The verifier exists precisely to confirm a sub-agent's local build
 * is reachable, and those builds are served on loopback — blocking it would
 * break the feature. Everything else off the public Internet (private,
 * link-local, ULA, carrier-grade NAT, multicast, the cloud-metadata IP) is
 * blocked.
 *
 * Two attack vectors are closed:
 *   1. Direct fetch of an internal host — `assertUrlAllowed` resolves the
 *      hostname and rejects if *any* resolved address is in a blocked range
 *      (so DNS rebinding to an internal IP cannot slip through).
 *   2. Redirect-based bypass — `safeFetch` uses `redirect: "manual"` and
 *      re-validates each hop's Location host before following it, so a public
 *      page cannot 302 the verifier into an internal/metadata endpoint.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const MAX_REDIRECTS = 5;

/**
 * Resolves a hostname to its addresses. Injectable so tests (which probe
 * unresolvable reserved hostnames like `*.test` against an injected `fetch`) can
 * supply a deterministic resolver without real DNS. Defaults to the system
 * resolver. Production code never overrides this.
 */
export type HostResolver = (host: string) => Promise<{ address: string }[]>;

let hostResolver: HostResolver = (host) => dnsLookup(host, { all: true });

/** Override the DNS resolver (test seam). Pass no argument to reset. */
export function setHostResolver(resolver?: HostResolver): void {
  hostResolver = resolver ?? ((host) => dnsLookup(host, { all: true }));
}

/** Reason a URL was rejected; surfaced as the probe "status" string. */
export class SsrfBlockedError extends Error {
  readonly host: string;
  constructor(host: string, detail: string) {
    super(`SSRF blocked: ${detail}`);
    this.name = "SsrfBlockedError";
    this.host = host;
  }
}

function parseIpv4Octets(addr: string): number[] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Is this IPv4 literal a loopback address (127.0.0.0/8)? Loopback is the one
 * non-public range the verifier is allowed to probe.
 */
function isLoopbackIpv4(octets: number[]): boolean {
  return octets[0] === 127;
}

/**
 * Is this IPv4 literal off the public Internet (and not loopback)? Covers the
 * IANA special-use ranges an SSRF would target: RFC1918 private, link-local
 * (incl. the 169.254.169.254 cloud-metadata IP), CGNAT, "this network",
 * benchmarking, documentation, multicast, and reserved/broadcast space.
 */
function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && octets[2] === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.* broadcast
  return false;
}

function normalizeIpv6(addr: string): string {
  // Strip zone id (e.g. fe80::1%eth0) and lowercase.
  return addr.split("%")[0].toLowerCase();
}

/**
 * Is this IPv6 literal a loopback address (::1)? Also treats IPv4-mapped
 * loopback (::ffff:127.x.x.x) as loopback.
 */
function isLoopbackIpv6(addr: string): boolean {
  const norm = normalizeIpv6(addr);
  if (norm === "::1") return true;
  const mapped = ipv4MappedAddress(norm);
  if (mapped) {
    const octets = parseIpv4Octets(mapped);
    return octets ? isLoopbackIpv4(octets) : false;
  }
  return false;
}

/**
 * Extract the embedded IPv4 (dotted-decimal) from an IPv4-mapped/compat IPv6
 * address, returning null when there is none.
 *
 * Critically, `new URL(...)` ALWAYS canonicalizes a dotted IPv4-mapped literal
 * to hex-group form — `[::ffff:169.254.169.254]` parses to hostname
 * `[::ffff:a9fe:a9fe]` — so matching only the dotted form leaves the entire
 * mapped branch dead on the real fetch path and lets metadata/RFC1918/loopback
 * through as `http://[::ffff:a9fe:a9fe]/`. We therefore match BOTH the dotted
 * form (direct literals) and the two-trailing-16-bit-hex-group form the URL
 * parser produces, reconstructing the embedded IPv4 from the hex groups.
 */
function ipv4MappedAddress(addr: string): string | null {
  const dotted = addr.match(
    /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (dotted) return dotted[1];

  const hex = addr.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return null;
}

/**
 * Is this IPv6 literal off the public Internet (and not loopback)? Covers the
 * unspecified address, ULA (fc00::/7), link-local (fe80::/10), the IPv6
 * cloud-metadata addresses (fd00:ec2::254), and IPv4-mapped addresses that
 * embed a blocked IPv4.
 */
function isBlockedIpv6(addr: string): boolean {
  const norm = normalizeIpv6(addr);
  if (norm === "::" || norm === "::0") return true; // unspecified
  // IPv4-mapped / -compatible: defer to the IPv4 classifier.
  const mapped = ipv4MappedAddress(norm);
  if (mapped) {
    const octets = parseIpv4Octets(mapped);
    if (octets) return isBlockedIpv4(octets);
  }
  const head = norm.replace(/^\[|\]$/g, "");
  // Unique local addresses fc00::/7 (fc.. and fd..).
  if (/^f[cd][0-9a-f]{0,2}:/.test(head)) return true;
  // Link-local fe80::/10 (fe8.., fe9.., fea.., feb..).
  if (/^fe[89ab][0-9a-f]?:/.test(head)) return true;
  // Deprecated site-local fec0::/10 (fec.., fed.., fee.., fef..) — RFC 3879.
  if (/^fe[c-f][0-9a-f]?:/.test(head)) return true;
  // Multicast ff00::/8.
  if (/^ff[0-9a-f]{2}:/.test(head)) return true;
  return false;
}

/** Classify an IP literal. Returns "loopback", "blocked", or "allowed". */
export function classifyIpLiteral(
  addr: string,
): "loopback" | "blocked" | "allowed" {
  const family = isIP(addr);
  if (family === 4) {
    const octets = parseIpv4Octets(addr);
    if (!octets) return "blocked";
    if (isLoopbackIpv4(octets)) return "loopback";
    return isBlockedIpv4(octets) ? "blocked" : "allowed";
  }
  if (family === 6) {
    if (isLoopbackIpv6(addr)) return "loopback";
    return isBlockedIpv6(addr) ? "blocked" : "allowed";
  }
  return "blocked";
}

/**
 * Resolve `hostname` and assert every resolved address is fetch-safe
 * (loopback or public). Throws `SsrfBlockedError` if the host is, or resolves
 * to, a blocked (non-public, non-loopback) address. Checking *all* resolved
 * addresses defeats a rebinding answer that mixes public and internal IPs.
 *
 * Returns the vetted addresses for DNS hostnames so the caller can PIN the
 * connection to them (#11028): validating here and letting `fetch` resolve
 * again leaves a rebinding window where the second lookup answers with an
 * internal IP. Returns `null` for `localhost` and IP literals — their
 * "resolution" is local/static, so there is nothing to rebind.
 */
export async function assertHostAllowed(
  hostname: string,
): Promise<string[] | null> {
  const host = hostname.replace(/^\[|\]$/g, "");
  // `localhost` is loopback by convention; allow without a DNS round-trip.
  if (host.toLowerCase() === "localhost") return null;

  // IP literal: classify directly, no DNS.
  if (isIP(host) !== 0) {
    const verdict = classifyIpLiteral(host);
    if (verdict === "blocked") {
      throw new SsrfBlockedError(host, `non-public address ${host}`);
    }
    return null;
  }

  // Hostname: resolve to all addresses and reject if any is blocked.
  let records: { address: string }[];
  try {
    records = await hostResolver(host);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SsrfBlockedError(
      host,
      `DNS resolution failed for ${host}: ${reason}`,
    );
  }
  const addresses = records
    .map((record) => record.address)
    .filter((address) => typeof address === "string" && address.length > 0);
  if (addresses.length === 0) {
    throw new SsrfBlockedError(host, `no addresses resolved for ${host}`);
  }
  for (const address of addresses) {
    if (classifyIpLiteral(address) === "blocked") {
      throw new SsrfBlockedError(
        host,
        `${host} resolves to non-public address ${address}`,
      );
    }
  }
  return addresses;
}

/**
 * Assert the full URL's host is fetch-safe. Returns the vetted addresses to
 * pin the connection to (`null` when the host is an IP literal/localhost).
 */
export async function assertUrlAllowed(
  url: string | URL,
): Promise<string[] | null> {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    throw new SsrfBlockedError(String(url), `unparseable URL ${String(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(
      parsed.hostname,
      `unsupported protocol ${parsed.protocol}`,
    );
  }
  return assertHostAllowed(parsed.hostname);
}

/** Node-style lookup callback signature (`net.connect`/`tls.connect`). */
type NodeLookupCallback = (
  err: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * Build a `lookup` implementation for `http(s).request` that only ever
 * answers with the addresses vetted by `assertHostAllowed`. The socket layer
 * never consults real DNS, so a rebinding resolver cannot swap in an internal
 * address between validation and connection.
 */
function createPinnedLookup(
  addresses: string[],
): (
  host: string,
  options: { all?: boolean } | NodeLookupCallback,
  callback?: NodeLookupCallback,
) => void {
  const records = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  return (_host, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    if (!cb) return;
    const all = typeof options === "object" && options.all === true;
    if (all) {
      cb(null, records);
      return;
    }
    cb(null, records[0].address, records[0].family);
  };
}

/**
 * One redirect-free request with the connection pinned to the vetted
 * addresses, wrapped back into a standard `Response`. Injectable so tests can
 * observe the pinned path without opening sockets.
 */
export type PinnedTransport = (
  url: string,
  init: Omit<RequestInit, "redirect">,
  addresses: string[],
) => Promise<Response>;

function nodePinnedTransport(
  url: string,
  init: Omit<RequestInit, "redirect">,
  addresses: string[],
): Promise<Response> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? "443" : "80"),
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
        // The pin: TLS SNI + certificate verification still use the original
        // hostname, but the socket connects to a vetted address only.
        lookup: createPinnedLookup(addresses),
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const entry of value) headers.append(name, entry);
          } else if (typeof value === "string") {
            headers.set(name, value);
          }
        }
        // Statuses that forbid a body in the Response constructor.
        const body =
          status === 204 || status === 205 || status === 304
            ? null
            : (Readable.toWeb(res) as unknown as BodyInit);
        resolve(new Response(body, { status, headers }));
      },
    );
    const signal = init.signal;
    if (signal) {
      const onAbort = () =>
        req.destroy(
          signal.reason instanceof Error ? signal.reason : new Error("aborted"),
        );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", reject);
    req.end();
  });
}

let pinnedTransport: PinnedTransport = nodePinnedTransport;

/** Override the pinned transport (test seam). Pass no argument to reset. */
export function setPinnedTransport(transport?: PinnedTransport): void {
  pinnedTransport = transport ?? nodePinnedTransport;
}

/**
 * SSRF-safe replacement for `fetch(url, { redirect: "follow" })`.
 *
 * Validates the host before the initial request, then follows redirects
 * *manually* — re-validating each hop's Location host with `assertUrlAllowed`
 * before fetching it — so a public page cannot redirect the verifier into an
 * internal or cloud-metadata endpoint. Caps redirects at `MAX_REDIRECTS`.
 *
 * For DNS hostnames the connection is PINNED to the addresses the validation
 * step resolved (#11028): `fetch` resolves DNS a second time, and a rebinding
 * resolver could answer that second lookup with an internal address. IP
 * literals and `localhost` connect through plain `fetch` — there is no DNS to
 * rebind.
 *
 * Throws `SsrfBlockedError` if any hop targets a blocked host; otherwise
 * behaves like `fetch` and returns the final `Response`.
 */
export async function safeFetch(
  url: string,
  init: Omit<RequestInit, "redirect"> = {},
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const pinned = await assertUrlAllowed(current);
    const res = pinned
      ? await pinnedTransport(current, init, pinned)
      : await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) {
      return res;
    }
    const location = res.headers.get("location");
    if (!location) {
      // A 3xx with no Location — nothing to follow; hand it back as-is.
      return res;
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SsrfBlockedError(
        current,
        `unparseable redirect target ${location}`,
      );
    }
    // Drain the redirect body so the socket can be reused.
    // error-policy:J6 best-effort teardown; a failed drain only forgoes socket
    // reuse and never affects the redirect-following result.
    await res.body?.cancel().catch(() => {});
    current = next.toString();
  }
  throw new SsrfBlockedError(url, `too many redirects (> ${MAX_REDIRECTS})`);
}
