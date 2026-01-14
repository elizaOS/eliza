import type { Plugin } from "@elizaos/core";

/**
 * Browser entrypoint.
 *
 * The auto-trader plugin is intended for Node/server runtimes (wallet access,
 * RPC, persistence). This stub exists to keep browser bundling tests passing.
 */
export const autoTraderPlugin: Plugin = {
  name: "@elizaos/plugin-auto-trader",
  description: "Autonomous trading plugin (Node-only; browser stub)",
};

export default autoTraderPlugin;

