/**
 * Sealed in-process secret store for cloud credentials.
 *
 * The implementation moved to `@elizaos/plugin-elizacloud/cloud-config/cloud-secrets` so
 * app and other host-layer packages can read sealed cloud secrets without
 * reverse-importing this plugin. This module remains for backwards
 * compatibility with plugin-internal callers.
 */
export { clearCloudSecrets, getCloudSecret, scrubCloudSecretsFromEnv, _resetCloudSecretsForTesting } from "@elizaos/plugin-elizacloud/cloud-config/cloud-secrets";
