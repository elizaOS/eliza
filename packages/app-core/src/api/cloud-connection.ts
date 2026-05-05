/**
 * Re-export shim. The canonical implementation now lives in
 * `@elizaos/plugin-elizacloud/lib/cloud-connection`. Keeps app-core's
 * existing relative imports (wallet-market-overview-route, etc.) working
 * without churn while the plugin owns the implementation.
 */
export {
  CLOUD_BILLING_URL,
  CloudCreditsAuthRejectedError,
  type CloudAuthLike,
  type CloudConnectionSnapshot,
  clearCloudAuthService,
  disconnectCloudConnection,
  disconnectUnifiedCloudConnection,
  fetchCloudCredits,
  getCloudAuth,
  isCloudStatusReasonApiKeyOnly,
  resolveCloudApiBaseUrl,
  resolveCloudApiKey,
  resolveCloudConnectionSnapshot,
  type RuntimeCloudLike,
} from "@elizaos/plugin-elizacloud/lib/cloud-connection";
