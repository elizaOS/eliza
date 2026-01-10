import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { callToolAction } from "./actions/callToolAction";
import { readResourceAction } from "./actions/readResourceAction";
import { provider } from "./provider";
import { McpService } from "./service";

// Re-export McpService class
export { McpService } from "./service";

// Re-export tool compatibility utilities
export {
  type ArrayConstraints,
  createMcpToolCompatibility,
  createMcpToolCompatibilitySync,
  detectModelProvider,
  McpToolCompatibility,
  type ModelInfo,
  type ModelProvider,
  type NumberConstraints,
  type ObjectConstraints,
  type SchemaConstraints,
  type StringConstraints,
} from "./tool-compatibility";

// Re-export all types for consumers
export * from "./types";

const mcpPlugin: Plugin = {
  name: "mcp",
  description: "Plugin for connecting to MCP (Model Context Protocol) servers",

  init: async (_config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing MCP plugin...");
  },

  services: [McpService],
  actions: [callToolAction, readResourceAction],
  providers: [provider],
};

export default mcpPlugin;
