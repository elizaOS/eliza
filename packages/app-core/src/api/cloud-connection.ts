/**
 * Re-export shim. The canonical implementation now lives in
 * `@elizaos/plugin-elizacloud/lib/cloud-connection`. Keeps app-core's
 * existing relative imports (wallet-market-overview-route, etc.) working
 * without churn while the plugin owns the implementation.
 */
export {
  CLOUD_BILLING_URL,
  type CloudAuthLike,
  type CloudConnectionSnapshot,
  CloudCreditsAuthRejectedError,
  clearCloudAuthService,
  disconnectCloudConnection,
  disconnectUnifiedCloudConnection,
  fetchCloudCredits,
  getCloudAuth,
  isCloudStatusReasonApiKeyOnly,
  type RuntimeCloudLike,
  resolveCloudApiBaseUrl,
  resolveCloudApiKey,
  resolveCloudConnectionSnapshot,
} from "@elizaos/plugin-elizacloud/lib/cloud-connection";
