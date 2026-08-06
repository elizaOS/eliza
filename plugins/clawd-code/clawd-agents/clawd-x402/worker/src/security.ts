import type { Context, Next } from "hono";
import type { Env } from "./types";

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const PAYMENT_HEADERS = new Set([
  "authorization",
  "payment-signature",
  "x-payment",
  "x-ap2-mandate",
  "x-payer",
]);

export async function securityHeaders(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
  c.header("cross-origin-resource-policy", "cross-origin");
}

export function buildUpstreamUrl(endpoint: string, incomingUrl: string, agentId: string): URL {
  const base = new URL(endpoint);
  validateAgentEndpoint(base);

  const incoming = new URL(incomingUrl);
  const prefix = `/agents/${agentId}`;
  const suffix = incoming.pathname.startsWith(prefix)
    ? incoming.pathname.slice(prefix.length)
    : "/";

  const upstream = new URL(base.toString());
  upstream.pathname = joinPath(base.pathname, suffix);
  upstream.search = incoming.search;
  return upstream;
}

export function forwardHeaders(input: Headers, extra: Record<string, string>): Headers {
  const out = new Headers();
  for (const [key, value] of input) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || PAYMENT_HEADERS.has(lower)) continue;
    if (lower === "host" || lower === "content-length") continue;
    out.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) out.set(key, value);
  return out;
}

function validateAgentEndpoint(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("agent endpoint must use https");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local")) {
    throw new Error("agent endpoint host is not allowed");
  }
  if (isPrivateIpv4(host)) {
    throw new Error("agent endpoint cannot target a private IPv4 address");
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function joinPath(basePath: string, suffix: string): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const tail = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${base}${tail}` || "/";
}
