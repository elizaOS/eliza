/**
 * Browser-target entry for the Instagram plugin: a stub whose `init()` only
 * warns that Instagram is unsupported in-browser. The real connector (private
 * API + Meta Graph API) needs a server; browser bundles resolve this export
 * instead of `src/index.ts` so the app builds without pulling in server-only code.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "instagram";

export const instagramPlugin: Plugin = {
  name: pluginName,
  description: "Instagram plugin (unsupported browser export; use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default instagramPlugin;
