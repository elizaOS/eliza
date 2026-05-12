/**
 * Cloud route registry — inverts the agent ↔ plugin-elizacloud dependency.
 *
 * plugin-elizacloud (or any other cloud provider) calls registerCloudRoutes()
 * during plugin init. The agent's API server reads from this registry instead
 * of importing plugin-elizacloud directly.
 *
 * This breaks the cycle: agent no longer needs plugin-elizacloud as a
 * compile-time dependency; the registry is filled at runtime.
 */

export interface CloudRouteHandlers {
  handleCloudBillingRoute?: (...args: unknown[]) => unknown;
  handleCloudCompatRoute?: (...args: unknown[]) => unknown;
  handleCloudRelayRoute?: (...args: unknown[]) => unknown;
  handleCloudStatusRoutes?: (...args: unknown[]) => unknown;
  handleCloudFeaturesRoute?: (...args: unknown[]) => unknown;
  isCloudProvisionedContainer?: () => boolean;
  // extend as more cloud route handlers are migrated
}

let registered: CloudRouteHandlers = {};

export function registerCloudRoutes(handlers: CloudRouteHandlers): void {
  registered = { ...registered, ...handlers };
}

export function getCloudRoutes(): CloudRouteHandlers {
  return registered;
}

export function clearCloudRoutes(): void {
  registered = {};
}
