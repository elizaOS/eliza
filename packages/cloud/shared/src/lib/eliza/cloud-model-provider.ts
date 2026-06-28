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
  models: elizaOSCloudPlugin.models,
};

export default cloudModelProviderPlugin;
