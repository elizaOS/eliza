import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { mcpAction } from "./actions/mcp";
import { provider } from "./provider";
import { McpService } from "./service";

// Re-export dynamic action utilities
export {
  createMcpToolAction,
  createMcpToolActions,
  getMcpToolActionsForServer,
  isMcpToolAction,
  type McpToolAction,
} from "./actions/dynamic-tool-actions";
// Re-export schema cache
export { getSchemaCache, McpSchemaCache } from "./cache/schema-cache";
// Re-export service
export { McpService } from "./service";

// Re-export tool compatibility
export {
  createMcpToolCompatibility,
  createMcpToolCompatibilitySync,
  detectModelProvider,
  McpToolCompatibility,
  type ModelInfo,
  type ModelProvider,
} from "./tool-compatibility";
// Re-export types
export * from "./types";

const mcpPlugin: Plugin = {
  name: "mcp",
  description: "Plugin for connecting to MCP (Model Context Protocol) servers",

  init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    logger.info("Initializing MCP plugin...");
  },

  services: [McpService],
  actions: [mcpAction],
  providers: [provider],
};

export default mcpPlugin;
