import type { Plugin } from "@elizaos/core";

export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud browser facade. Node-only routes and services are exported from the node entry.",
};

export * from "./types";
export default elizaOSCloudPlugin;

// Browser-side no-op stubs for the named exports that ship from the Node
// entry. The renderer needs the names to statically resolve so the bundler
// doesn't fail with MISSING_EXPORT; these functions are never executed in
// the browser since the consumers are server-side routes.
const _noop = (): undefined => undefined;
export const clearCloudSecrets = _noop;
export const ensureCloudTtsApiKeyAlias = _noop;
export const getCloudSecret = _noop;
export const handleCloudTtsPreviewRoute = _noop;
export const mirrorCompatHeaders = _noop;
export const normalizeCloudSiteUrl = _noop;
export const scrubCloudSecretsFromEnv = _noop;
export const __resetCloudBaseUrlCache = _noop;
export const resolveCloudTtsBaseUrl = _noop;
export const resolveElevenLabsApiKeyForCloudMode = _noop;
