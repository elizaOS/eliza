/**
 * Plugin entry for @elizaos/plugin-mcp: registers McpService, the unified MCP
 * action (widened with the connector/automation/knowledge contexts), and the MCP
 * provider. Also re-exports handleMcpRoutes for host servers wiring /api/mcp/*.
 */
import {
  type Action,
  type IAgentRuntime,
  logger,
  type Plugin,
  promoteSubactionsToActions,
} from "@elizaos/core";
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

  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<McpService>(McpService.serviceType);
    await svc?.stop();
  },

  services: [McpService],
  actions: [...promoteSubactionsToActions(withMcpContext(mcpAction))],
  providers: [provider],
};

export default mcpPlugin;

export {
  DEFAULT_MCP_MARKETPLACE_MAX_RESPONSE_BYTES,
  DEFAULT_MCP_MARKETPLACE_TIMEOUT_MS,
  getMcpServerDetails,
  McpMarketplaceError,
  type McpMarketplaceErrorCode,
  type McpMarketplaceRequestOptions,
  type McpMarketplaceSearchItem,
  type McpRegistryServer,
  searchMcpMarketplace,
} from "./mcp-marketplace.js";
export {
  handleMcpRoutes,
  type McpRouteConfig,
  type McpRouteContext,
} from "./routes-mcp.js";
