import { type Action, type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { MCP_ACTION_CONTEXT, mcpAction } from "./actions/mcp";
import { provider } from "./provider";
import { McpService } from "./service";

function withMcpContext(action: Action): Action {
  return {
    ...action,
    contexts: [
      ...new Set([
        ...(action.contexts ?? []),
        "general",
        "automation",
        "knowledge",
        MCP_ACTION_CONTEXT,
      ]),
    ],
  };
}

const mcpPlugin: Plugin = {
  name: "mcp",
  description: "Plugin for connecting to MCP (Model Context Protocol) servers",

  init: async (_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing MCP plugin...");
  },

  services: [McpService],
  actions: [withMcpContext(mcpAction)],
  providers: [provider],
};

export default mcpPlugin;

export { handleMcpRoutes, type McpRouteContext } from "./routes-mcp.js";
