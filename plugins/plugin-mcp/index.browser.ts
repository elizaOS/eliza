/**
 * Browser build entry: MCP clients need Node stdio/SSE transports, so this warns
 * and registers a no-op plugin. Use a server-side proxy to reach MCP servers.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "mcp";

export const mcpPlugin: Plugin = {
  name: pluginName,
  description: "MCP plugin (browser-unavailable entry; use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
};

export default mcpPlugin;
