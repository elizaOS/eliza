/**
 * Per-app public URL derivation (Apps / Product 2).
 *
 * Apps are provisioned via the SSH `AppContainerProvider` path, which branches
 * around the Hetzner client — so they never pass through the client's
 * hostname/URL stamping. This reuses the SAME shared `derivePublicHostname`
 * (the ingress map's source of truth) so an app container gets a public URL
 * identical in shape to an agent container's, without rebuilding ingress and
 * without editing the hot `hetzner-client/client.ts`.
 *
 * Returns null when `CONTAINERS_PUBLIC_BASE_DOMAIN` isn't configured (e.g. local
 * dev), so callers simply skip URL stamping rather than writing a bogus value.
 */

import { derivePublicHostname } from "./containers/hetzner-client/paths";

export interface AppPublicEndpoint {
  /** `<shortid>.<base-domain>` — written to containers.public_hostname. */
  hostname: string;
  /** `https://<hostname>` — written to containers.load_balancer_url + apps.production_url. */
  url: string;
}

/** Derive the app's public endpoint from its container id, or null if unconfigured. */
export function deriveAppPublicUrl(containerId: string): AppPublicEndpoint | null {
  const hostname = derivePublicHostname(containerId);
  if (!hostname) return null;
  return { hostname, url: `https://${hostname}` };
}
