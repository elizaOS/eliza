import pluginDefault from "./index.js";

export * from "./index.js";
export default pluginDefault;

// Node-only route handlers (depend on node:os and other node built-ins).
export { handleCloudBillingRoute } from "./routes/cloud-billing-routes";
export { handleCloudCompatRoute } from "./routes/cloud-compat-routes";
export { handleCloudRelayRoute } from "./routes/cloud-relay-routes";
export {
  type CloudRouteState,
  handleCloudRoute,
} from "./routes/cloud-routes-autonomous";
export type { CloudConfigLike } from "./routes/cloud-routes-autonomous";
export { handleCloudStatusRoutes } from "./routes/cloud-status-routes";
export { runCloudOnboarding, type CloudOnboardingResult } from "./onboarding";
export { CloudManager, type CloudManagerCallbacks } from "./cloud/cloud-manager";
export {
  getOrCreateClientAddressKey,
  persistCloudWalletCache,
  provisionCloudWalletsBestEffort,
} from "./cloud/cloud-wallet";
export {
  normalizeCloudSecret,
  resolveCloudApiKey,
} from "./cloud/cloud-api-key";
export {
  clearCloudSecrets,
  getCloudSecret,
  scrubCloudSecretsFromEnv,
} from "./lib/cloud-secrets";
export {
  __resetCloudBaseUrlCache,
  ensureCloudTtsApiKeyAlias,
  handleCloudTtsPreviewRoute,
  mirrorCompatHeaders,
  resolveCloudTtsBaseUrl,
  resolveElevenLabsApiKeyForCloudMode,
} from "./lib/server-cloud-tts";
