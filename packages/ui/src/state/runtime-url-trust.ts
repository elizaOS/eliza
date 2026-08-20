/**
 * Canonical trust gates for persisted/user-entered runtime API bases.
 *
 * Remote runtime records are localStorage-backed and can also be created from
 * connect events. Only dial — and attach a bearer token to — loopback,
 * same-origin, private/LAN, CGNAT/Tailscale, or the mobile IPC pseudo-base.
 * Cloud records are restricted to canonical Eliza Cloud agent/control-plane
 * shapes or strict loopback, so changing only the persisted `kind` cannot turn
 * an arbitrary public host into a Steward-token target.
 */
import {
  isCloudPairAgentId,
  isCloudPairLoopbackOrigin,
} from "@elizaos/shared/contracts";
import { classifyElizaHostname } from "@elizaos/shared/elizacloud";
import { isMobileLocalAgentIpcBase } from "../first-run/mobile-runtime-mode";
import {
  ELIZA_CLOUD_CONTROL_PLANE_HOSTS,
  isPersonalSharedElizaId,
} from "../utils/cloud-agent-base";

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

export function isTrustedRestoreApiBaseUrl(
  apiBase: string | undefined,
): boolean {
  if (!apiBase) return false;
  // The bundled on-device agent's IPC pseudo-base (eliza-local-agent://ipc) is
  // in-process: no network dial, no attacker-choosable host, no bearer-token
  // exfiltration surface.
  if (isMobileLocalAgentIpcBase(apiBase)) return true;
  // First-party relay pseudo-base: no network address or token is embedded;
  // requests are translated into account-authorized, signed E2E envelopes.
  if (/^eliza-remote:\/\/session\/[A-Za-z0-9%._~-]+$/.test(apiBase))
    return true;

  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(host) || host === "0.0.0.0") return true;
  if (
    typeof window !== "undefined" &&
    host === window.location.hostname.toLowerCase()
  ) {
    return true;
  }
  // IPv6 ULA (fc00::/7) / link-local (fe80::/10).
  if (
    host.includes(":") &&
    (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))
  ) {
    return true;
  }

  // RFC1918 / CGNAT (Tailscale) / link-local IPv4 + private name suffixes.
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "local" ||
    host === "internal" ||
    host === "lan" ||
    host === "ts.net" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  );
}

function decodedPathAgentId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim().toLowerCase();
    return isCloudPairAgentId(decoded) || isPersonalSharedElizaId(decoded)
      ? decoded
      : null;
  } catch {
    // error-policy:J3 malformed URL encoding is an untrusted Cloud target.
    return null;
  }
}

function agentIdMatches(
  candidate: string,
  expectedAgentId: string | null,
): boolean {
  return expectedAgentId === null || candidate === expectedAgentId;
}

/**
 * Validate a persisted Cloud API base before any owner or agent bearer is
 * attached. Canonical dedicated hosts bind one DNS label to the expected agent;
 * shared adapters bind the path agent on a known control-plane host; local
 * Docker is the only non-HTTPS exception.
 */
export function isTrustedCloudApiBaseUrl(
  apiBase: string | undefined,
  expectedAgentId?: string | null,
): boolean {
  if (!apiBase) return false;

  const hasExpectedAgentId =
    expectedAgentId !== undefined && expectedAgentId !== null;
  const normalizedExpectedAgentId = expectedAgentId?.trim().toLowerCase() ?? "";
  if (
    hasExpectedAgentId &&
    !isCloudPairAgentId(normalizedExpectedAgentId) &&
    !isPersonalSharedElizaId(normalizedExpectedAgentId)
  ) {
    return false;
  }
  const expected = hasExpectedAgentId ? normalizedExpectedAgentId : null;

  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    // error-policy:J3 malformed persisted URL input is untrusted.
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (isCloudPairLoopbackOrigin(url.origin)) {
    return normalizedPath === "";
  }
  if (url.protocol !== "https:" || url.port) return false;

  const host = url.hostname.toLowerCase();
  if (ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(host)) {
    if (normalizedPath === "" || normalizedPath === "/api/v1/eliza/agents") {
      return expected === null;
    }
    const match = /^\/api\/v1\/eliza\/agents\/([^/]+)(?:\/bridge)?$/.exec(
      normalizedPath,
    );
    if (!match) return false;
    const candidate = decodedPathAgentId(match[1]);
    return candidate !== null && agentIdMatches(candidate, expected);
  }

  const classified = classifyElizaHostname(host);
  if (
    (classified.role !== "dedicated-agent" &&
      classified.role !== "legacy-dedicated-agent") ||
    !classified.agentId ||
    normalizedPath !== ""
  ) {
    return false;
  }
  const candidate = classified.agentId;
  if (!isCloudPairAgentId(candidate)) return false;
  return agentIdMatches(candidate, expected);
}
