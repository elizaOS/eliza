import type { Plugin } from "@elizaos/core";

/**
 * Browser entrypoint.
 *
 * The Minecraft plugin is Node-only (Mineflayer/WebSocket/process access). This
 * stub exists so the monorepo can still be bundled in browser contexts without
 * pulling in Node-only dependencies at import time.
 */
export const minecraftPlugin: Plugin = {
  name: "@elizaos/plugin-minecraft",
  description: "Minecraft automation plugin (Node-only; browser stub)",
};

export default minecraftPlugin;
