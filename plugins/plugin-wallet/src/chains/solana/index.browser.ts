/**
 * Browser build entry for the Solana sub-plugin: a no-op facade that warns
 * and does nothing, since Solana signing/RPC is server-only. Resolved in
 * place of `index.ts` when bundling for a browser target.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "chain_solana";

export const solanaPlugin: Plugin = {
  name: pluginName,
  description: "Solana plugin browser facade; use a server proxy",
  async init(_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default solanaPlugin;
