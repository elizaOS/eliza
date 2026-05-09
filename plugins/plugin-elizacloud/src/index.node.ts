import pluginDefault from "./index";

export * from "./index";
export default pluginDefault;

// Node-only route handlers (depend on node:os and other node built-ins).
export { handleCloudBillingRoute } from "./routes/cloud-billing-routes";
export { handleCloudCompatRoute } from "./routes/cloud-compat-routes";
export { handleCloudRelayRoute } from "./routes/cloud-relay-routes";
export { type CloudRouteState, handleCloudRoute } from "./routes/cloud-routes";
export type { CloudConfigLike } from "./routes/cloud-routes-autonomous";
export { handleCloudStatusRoutes } from "./routes/cloud-status-routes";
export {
  getOrCreateClientAddressKey,
  persistCloudWalletCache,
  provisionCloudWalletsBestEffort,
} from "./cloud/cloud-wallet";
