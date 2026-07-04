// Coordinates cloud service index behavior behind route handlers.
export { applyPooledCredentialsToBootstrapEnv } from "./bootstrap-env";
export { DrizzleAccountPoolDeps } from "./pool-deps";
export { type PooledApiProbeResult, probePooledApiKey } from "./probe";
export {
  isPooledDirectProvider,
  isSubscriptionProviderId,
  keyLast4,
  POOLED_DIRECT_PROVIDERS,
  POOLED_PROVIDER_ENV_KEYS,
  POOLED_PROVIDER_SECRET_PROVIDER,
  type PooledDirectProvider,
} from "./provider-map";
export {
  getTeamPoolRegistry,
  type SelectedPooledCredential,
  TeamPoolRegistry,
} from "./registry";
