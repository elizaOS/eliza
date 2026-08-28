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

const REMOTE_FALLBACK_API_BASE_ENV_KEY = "VITE_ELIZA_REMOTE_FALLBACK_API_BASE";
const REMOTE_FALLBACK_RUNTIME_GLOBAL =
  "__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__";

type RemoteFallbackRuntimeGlobal = typeof globalThis & {
  __ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__?: unknown;
};

function configuredRemoteFallbackApiBase(): string | undefined {
  // `@elizaos/ui` can be consumed as a pre-built package. In that shape Vite
  // does not necessarily rewrite `import.meta.env` inside this module even
  // though the app entrypoint sees the build variable. The app therefore
  // installs the already-validated origin here before React renders, keeping
  // every runtime trust/persistence gate on the same immutable build target.
  const runtimeValue = (globalThis as RemoteFallbackRuntimeGlobal)[
    REMOTE_FALLBACK_RUNTIME_GLOBAL
  ];
  if (typeof runtimeValue === "string") return runtimeValue;

  const env =
    typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, unknown> }).env
      : undefined;
  const value = env?.[REMOTE_FALLBACK_API_BASE_ENV_KEY];
  return typeof value === "string" ? value : undefined;
}

/**
 * Publish the app-entrypoint's validated remote origin to pre-built UI code.
 * A second, different target is rejected so late runtime code cannot repoint a
 * dedicated build after its bootstrap contract has been established.
 */
export function installBuildConfiguredRemoteApiBaseUrl(apiBase: string): void {
  const resolved = getBuildConfiguredRemoteApiBaseUrl(apiBase);
  if (!resolved) {
    throw new Error(
      "[runtime-url-trust] build-configured remote target must be a root HTTPS origin",
    );
  }

  const runtime = globalThis as RemoteFallbackRuntimeGlobal;
  const current = runtime[REMOTE_FALLBACK_RUNTIME_GLOBAL];
  if (typeof current === "string" && current !== resolved) {
    throw new Error(
      "[runtime-url-trust] build-configured remote target is already locked",
    );
  }
  runtime[REMOTE_FALLBACK_RUNTIME_GLOBAL] = resolved;
}

/**
 * Return the exact root HTTPS origin compiled into a dedicated remote build.
 * Invalid build input fails closed so callers can use a non-null result as the
 * runtime-lock contract, not merely as a restore allow-list entry.
 */
export function getBuildConfiguredRemoteApiBaseUrl(
  configuredBase = configuredRemoteFallbackApiBase(),
): string | null {
  if (!configuredBase?.trim()) return null;

  try {
    const configured = new URL(configuredBase.trim());
    if (
      configured.protocol !== "https:" ||
      configured.username ||
      configured.password ||
      configured.port ||
      configured.search ||
      configured.hash ||
      configured.pathname.replace(/\/+$/, "") !== ""
    ) {
      return null;
    }
    return configured.origin;
  } catch {
    // error-policy:J3 malformed build input cannot authorize or pin a target.
    return null;
  }
}

/**
 * Trust one exact HTTPS origin compiled into a dedicated remote-fallback app.
 * The configured value is a root origin only: credentials, custom ports,
 * query/fragment state, and path-scoped targets are rejected.
 */
export function isTrustedBuildConfiguredRemoteApiBaseUrl(
  apiBase: string | undefined,
  configuredBase = configuredRemoteFallbackApiBase(),
): boolean {
  if (!apiBase) return false;

  const configuredOrigin = getBuildConfiguredRemoteApiBaseUrl(configuredBase);
  if (!configuredOrigin) return false;

  try {
    const candidate = new URL(apiBase);
    return (
      candidate.protocol === "https:" &&
      !candidate.username &&
      !candidate.password &&
      !candidate.port &&
      !candidate.search &&
      !candidate.hash &&
      candidate.pathname.replace(/\/+$/, "") === "" &&
      candidate.origin === configuredOrigin
    );
  } catch {
    // error-policy:J3 malformed build/runtime URL input is never trusted.
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // RFC 1122 reserves the entire 127.0.0.0/8 block for IPv4 loopback, not
  // only 127.0.0.1. Packaged external-runtime tests bind an alternate address
  // in that block so they exercise the HTTP path without exposing a fixture.
  return /^127(?:\.\d{1,3}){3}$/.test(h) || h === "localhost" || h === "::1";
}

export function isTrustedRestoreApiBaseUrl(
  apiBase: string | undefined,
): boolean {
  if (!apiBase) return false;
  // The bundled on-device agent's IPC pseudo-base (eliza-local-agent://ipc) is
  // in-process: no network dial, no attacker-choosable host, no bearer-token
  // exfiltration surface.
  if (isMobileLocalAgentIpcBase(apiBase)) return true;

  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (isTrustedBuildConfiguredRemoteApiBaseUrl(apiBase)) return true;

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
    if (normalizedPath === "") return true;
    // Local Cloud development serves the same account-scoped Shared adapter
    // shape as production, but from a loopback Worker. Keep this exception
    // bound to an explicitly expected agent identity: arbitrary loopback paths
    // remain untrusted and a persisted record cannot switch organizations by
    // changing only its path.
    const match = /^\/api\/v1\/eliza\/agents\/([^/]+)(?:\/bridge|\/api)?$/.exec(
      normalizedPath,
    );
    if (!match || expected === null) return false;
    const candidate = decodedPathAgentId(match[1]);
    return candidate !== null && agentIdMatches(candidate, expected);
  }
  if (url.protocol !== "https:" || url.port) return false;

  const host = url.hostname.toLowerCase();
  if (ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(host)) {
    if (normalizedPath === "" || normalizedPath === "/api/v1/eliza/agents") {
      return expected === null;
    }
    const match = /^\/api\/v1\/eliza\/agents\/([^/]+)(?:\/bridge|\/api)?$/.exec(
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
