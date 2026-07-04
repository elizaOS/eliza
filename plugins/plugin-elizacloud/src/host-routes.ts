/**
 * Typed host-route contract for the `@elizaos/agent` server-route dispatcher.
 *
 * The four handlers below run host-side and must work while `runtime === null`
 * (cloud login provisions/restarts the runtime), so they cannot live in
 * `Plugin.routes`. The agent lazily imports this module and dispatches through
 * these real, exported signatures — no type-erased `unknown[]` shims. Because
 * agent types against the exports here, changing a handler's signature (or its
 * state type) is a compile error in `@elizaos/agent`.
 */
export { handleCloudBillingRoute } from "./routes/cloud-billing-routes";
export { handleCloudCompatRoute } from "./routes/cloud-compat-routes";
export { handleCloudRelayRoute } from "./routes/cloud-relay-routes";
export { handleCloudRoute } from "./routes/cloud-routes";

export type { CloudBillingRouteState } from "./routes/cloud-billing-routes";
export type { CloudCompatRouteState } from "./routes/cloud-compat-routes";
export type { CloudRelayRouteState } from "./routes/cloud-relay-routes";
export type { CloudRouteState } from "./routes/cloud-routes";
export type { CloudManager } from "./cloud/cloud-manager";
