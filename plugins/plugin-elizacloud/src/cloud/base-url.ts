/**
 * Cloud site/API URL normalizer. The implementation moved to
 * `@elizaos/shared/elizacloud/base-url` so host-layer packages can normalize
 * URLs without reverse-importing this plugin.
 */
export { normalizeCloudSiteUrl, resolveCloudApiBaseUrl } from "@elizaos/shared";
