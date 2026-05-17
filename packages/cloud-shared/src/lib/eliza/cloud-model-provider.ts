import type { Plugin } from "@elizaos/core";
import { elizaOSCloudPlugin } from "@elizaos/plugin-elizacloud";

/**
 * Cloud runtime infrastructure needs the Eliza Cloud model handlers, but not
 * the full plugin's cloud actions, providers, routes, or services.
 */
export const cloudModelProviderPlugin: Plugin = {
  name: "eliza-cloud-model-provider",
  description: "Eliza Cloud model handlers for cloud-hosted runtimes",
  config: elizaOSCloudPlugin.config,
  init: elizaOSCloudPlugin.init,
  // The elizaOSCloudPlugin.models property has a concrete internal type that
  // doesn't satisfy the generic Plugin["models"] signature exactly, despite
  // being structurally compatible at runtime.
  models: elizaOSCloudPlugin.models as unknown as Plugin["models"],
};

export default cloudModelProviderPlugin;
