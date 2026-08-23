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
import { handleCloudBillingRoute as handleCloudBillingRouteImpl } from "./routes/cloud-billing-routes.js";
import { handleCloudCompatRoute as handleCloudCompatRouteImpl } from "./routes/cloud-compat-routes.js";
import { handleCloudRelayRoute as handleCloudRelayRouteImpl } from "./routes/cloud-relay-routes.js";
import { handleCloudRoute as handleCloudRouteImpl } from "./routes/cloud-routes.js";

export const handleCloudBillingRoute = handleCloudBillingRouteImpl;
export const handleCloudCompatRoute = handleCloudCompatRouteImpl;
export const handleCloudRelayRoute = handleCloudRelayRouteImpl;
export const handleCloudRoute = handleCloudRouteImpl;

export type { CloudBillingRouteState } from "./routes/cloud-billing-routes";
export type { CloudCompatRouteState } from "./routes/cloud-compat-routes";
export type { CloudRelayRouteState } from "./routes/cloud-relay-routes";
export type { CloudRouteState } from "./routes/cloud-routes";
export type { CloudManager } from "./cloud/cloud-manager";
