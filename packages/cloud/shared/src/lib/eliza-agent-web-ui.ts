// Defines cloud shared eliza agent web ui behavior for backend service consumers.
import type { AgentSandbox } from "../db/schemas/agent-sandboxes";

const DEFAULT_AGENT_BASE_DOMAIN = "cloud.eliza.app";

type ElizaAgentWebUiTarget = Pick<
  AgentSandbox,
  "id" | "headscale_ip" | "web_ui_port" | "bridge_port"
>;

type ElizaClientWebUiTarget = ElizaAgentWebUiTarget & {
  canonicalWebUiUrl?: string | null;
};

export interface ElizaAgentWebUiUrlOptions {
  baseDomain?: string | null;
  path?: string;
}

const INTERNAL_HOSTNAME_SUFFIXES = [
  ".corp",
  ".home",
  ".internal",
  ".lan",
  ".local",
  ".localhost",
  ".private",
] as const;

/** Resolved base domain for the current deployment (e.g. "cloud.eliza.app"). */
export function getAgentBaseDomain(): string {
  return (
    normalizeAgentBaseDomain(process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ?? DEFAULT_AGENT_BASE_DOMAIN
  );
}

function normalizeAgentBaseDomain(baseDomain?: string | null): string | null {
  if (!baseDomain) {
    return null;
  }

  const normalizedDomain = baseDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "");

  return normalizedDomain || null;
}

function normalizeConfiguredPublicBaseDomain(baseDomain: string | null | undefined): string | null {
  const raw = baseDomain?.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    // error-policy:J3 deployment configuration is untrusted at the response boundary.
    return null;
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const hostname = parsed.hostname.replace(/\.+$/, "").toLowerCase();
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    hostname.length > 253 ||
    hostname.includes(":") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    INTERNAL_HOSTNAME_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    ) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }

  return hostname;
}

function isAgentHostnameLabel(agentId: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(agentId);
}

function applyPath(baseUrl: string, path = "/"): string {
  if (!path || path === "/") {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  const normalizedPath = new URL(path, "https://agent.local");

  url.pathname = normalizedPath.pathname;
  url.search = normalizedPath.search;
  url.hash = normalizedPath.hash;

  return url.toString();
}

// Server-only: reads process.env. Do not import in client components.
// For client use, pass canonical_web_ui_url from the server and call
// getClientSafeElizaAgentWebUiUrl instead.
/**
 * Public HTTPS URL `{sandbox.id}.{domain}`.
 *
 * **Omit `baseDomain` or set it to `undefined`:** resolve from `ELIZA_CLOUD_AGENT_BASE_DOMAIN`,
 * then the built-in default domain (`cloud.eliza.app`). Empty env is treated like unset (same as
 * {@link getAgentBaseDomain}).
 *
 * **Pass any other `baseDomain` (including `null` or `""`):** use only that value after
 * normalization. If it does not yield a valid hostname, returns **`null`** — no silent fallback to
 * the default domain (callers use `null` to mean “no public URL for this override”).
 */
export function getElizaAgentPublicWebUiUrl(
  sandbox: Pick<AgentSandbox, "id" | "headscale_ip">,
  options: ElizaAgentWebUiUrlOptions = {},
): string | null {
  const rawOpt = options.baseDomain;
  const baseDomainOptionSupplied = Object.hasOwn(options, "baseDomain") && rawOpt !== undefined;

  if (baseDomainOptionSupplied) {
    const explicit = normalizeAgentBaseDomain(rawOpt);
    if (explicit === null) {
      return null;
    }
    return applyPath(`https://${sandbox.id}.${explicit}`, options.path);
  }

  const normalizedDomain =
    normalizeAgentBaseDomain(process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN) ??
    DEFAULT_AGENT_BASE_DOMAIN;

  return applyPath(`https://${sandbox.id}.${normalizedDomain}`, options.path);
}

/**
 * Canonical ownership-scoped HTTPS gateway for a deployment-provided domain.
 *
 * Unlike {@link getElizaAgentPublicWebUiUrl}, this response-boundary helper has
 * no environment or production-domain fallback. It also rejects IP literals,
 * internal DNS suffixes, ports, credentials, paths, and invalid agent labels so
 * persisted infrastructure coordinates cannot become browser-visible URLs.
 */
export function getConfiguredElizaAgentPublicWebUiUrl(
  sandbox: Pick<AgentSandbox, "id">,
  baseDomain: string | null | undefined,
  options: Pick<ElizaAgentWebUiUrlOptions, "path"> = {},
): string | null {
  const normalizedDomain = normalizeConfiguredPublicBaseDomain(baseDomain);
  if (!normalizedDomain || !isAgentHostnameLabel(sandbox.id)) return null;
  return applyPath(`https://${sandbox.id}.${normalizedDomain}`, options.path);
}

export function getElizaAgentDirectWebUiUrl(
  sandbox: ElizaAgentWebUiTarget,
  options: Pick<ElizaAgentWebUiUrlOptions, "path"> = {},
): string | null {
  if (!sandbox.headscale_ip) {
    return null;
  }

  const port = sandbox.web_ui_port ?? sandbox.bridge_port;
  if (!port) {
    return null;
  }

  return applyPath(`http://${sandbox.headscale_ip}:${port}`, options.path);
}

export function getPreferredElizaAgentWebUiUrl(
  sandbox: ElizaAgentWebUiTarget,
  options: ElizaAgentWebUiUrlOptions = {},
): string | null {
  return (
    getElizaAgentPublicWebUiUrl(sandbox, options) ?? getElizaAgentDirectWebUiUrl(sandbox, options)
  );
}

export function getClientSafeElizaAgentWebUiUrl(
  sandbox: ElizaClientWebUiTarget,
  options: Pick<ElizaAgentWebUiUrlOptions, "path"> = {},
): string | null {
  if (sandbox.canonicalWebUiUrl) {
    return applyPath(sandbox.canonicalWebUiUrl, options.path);
  }

  return null;
}
