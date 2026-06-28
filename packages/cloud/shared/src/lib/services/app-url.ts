/**
 * Per-app public URL derivation (Apps / Product 2).
 *
 * An app container's public URL is `<shortid>.<apps-base-domain>` — the same
 * shape as an agent container's, but resolved from an APPS-specific base domain
 * (`containersEnv.appsPublicBaseDomain()` = `CONTAINERS_PUBLIC_BASE_DOMAIN`, set
 * to e.g. `apps.elizacloud.ai` on the apps data plane by terraform). It
 * deliberately does NOT use the shared `publicBaseDomain()`, which falls back to
 * the agent sandbox domain (`ELIZA_CLOUD_AGENT_BASE_DOMAIN`) — apps must live on
 * their own domain and never silently inherit the agent sandbox domain.
 *
 * Returns null when the apps base domain isn't configured (e.g. local dev, or a
 * host that only has the agent domain), so callers skip URL stamping rather than
 * writing a wrong-domain value. The 8-hex shortid matches the agent ingress
 * derivation, so the `*.apps.elizacloud.ai` wildcard routes identically.
 */

import { containersEnv } from "../config/containers-env";

export interface AppPublicEndpoint {
  /** `<shortid>.<base-domain>` — written to containers.public_hostname. */
  hostname: string;
  /** `https://<hostname>` — written to containers.load_balancer_url + apps.production_url. */
  url: string;
}

/** Derive the app's public endpoint from its container id, or null if unconfigured. */
export function deriveAppPublicUrl(containerId: string): AppPublicEndpoint | null {
  const baseDomain = containersEnv.appsPublicBaseDomain();
  if (!baseDomain) return null;
  // 8 hex chars from the (UUID v4) container id — matches the agent ingress
  // shortid scheme so the wildcard DNS routes the same way.
  const shortId = containerId.replace(/-/g, "").slice(0, 8);
  const hostname = `${shortId}.${baseDomain}`;
  return { hostname, url: `https://${hostname}` };
}
