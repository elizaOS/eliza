import type { Plugin } from "@elizaos/core";

export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud browser facade. Node-only routes and services are exported from the node entry.",
};

// Browser-side no-op stubs for the named exports that ship from the Node
// entry. The renderer needs the names to statically resolve so the bundler
// doesn't fail with MISSING_EXPORT. These functions are never executed in
// the browser since the consumers are server-side routes; in milady local-mode
// the bundled `app-core/dist/api/server.js` imports them at module-load time.
const _noop = (): undefined => undefined;

export function getCloudSecret(
  _key?: "ELIZAOS_CLOUD_API_KEY" | "ELIZAOS_CLOUD_ENABLED",
): string | undefined {
  return undefined;
}

export function clearCloudSecrets(): void {}

export const ensureCloudTtsApiKeyAlias = _noop;
export const handleCloudTtsPreviewRoute = _noop;
export const mirrorCompatHeaders = _noop;
export const normalizeCloudSiteUrl = _noop;
export const scrubCloudSecretsFromEnv = _noop;
export const __resetCloudBaseUrlCache = _noop;
export const resolveCloudTtsBaseUrl = _noop;
export const resolveElevenLabsApiKeyForCloudMode = _noop;

export * from "./types";
export default elizaOSCloudPlugin;
