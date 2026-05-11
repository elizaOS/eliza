import type { Plugin } from "@elizaos/core";

export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud browser facade. Node-only routes and services are exported from the node entry.",
};

// Browser-safe stubs for cloud secret helpers — the renderer has no
// sealed-env store. app-core/dist/api/server.js is bundled into the
// browser surface (milady local-mode) and imports these names; in the
// browser they simply have no secrets to surface.
export function getCloudSecret(
  _key: "ELIZAOS_CLOUD_API_KEY" | "ELIZAOS_CLOUD_ENABLED",
): string | undefined {
  return undefined;
}

export function clearCloudSecrets(): void {}

export * from "./types";
export default elizaOSCloudPlugin;
