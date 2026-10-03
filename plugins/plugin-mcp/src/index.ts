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
  actionNamesCollide,
  generateSimiles,
  makeUniqueActionName,
  parseActionName,
  toActionName,
} from "./protocol-utils/action-naming.js";
export {
  assertJsonObject,
  parseJSON,
  parseStructuredModelOutput,
  stringifyJSON,
  validateJsonSchema,
} from "./protocol-utils/json.js";
export {
  detectMcpModelProvider,
  type McpModelInfo,
  type McpModelProvider,
  type McpRuntimeModelProjection,
} from "./protocol-utils/model-provider.js";
export {
  ERROR_ANALYSIS_TEMPLATE,
  errorAnalysisTemplate,
  FEEDBACK_TEMPLATE,
  feedbackTemplate,
  RESOURCE_ANALYSIS_TEMPLATE,
  RESOURCE_SELECTION_TEMPLATE,
  resourceAnalysisTemplate,
  resourceSelectionTemplate,
  TOOL_REASONING_TEMPLATE,
  TOOL_SELECTION_ARGUMENT_TEMPLATE,
  TOOL_SELECTION_NAME_TEMPLATE,
  toolReasoningTemplate,
  toolSelectionArgumentTemplate,
  toolSelectionNameTemplate,
} from "./protocol-utils/prompts.js";
export type {
  McpKernelProviderData,
  McpKernelProviderProjection,
  McpKernelResource,
  McpKernelServer,
  McpKernelTool,
} from "./protocol-utils/protocol.js";
export {
  buildMcpProviderProjection,
  formatMcpProviderForPrompt,
} from "./protocol-utils/provider-projection.js";
export {
  createMcpResourceSelectionFeedback,
  describeMcpResources,
  type McpResourceSelection,
  type McpSelectionValidation,
  validateMcpResourceSelection,
} from "./protocol-utils/resource-selection.js";
export {
  assertMcpJsonSchemaBudget,
  getMcpJsonSchemaBudgetError,
  MAX_MCP_SCHEMA_DEPTH,
  MAX_MCP_SCHEMA_JSON_BYTES,
  MAX_MCP_SCHEMA_NODES,
  MCP_TOOL_SCHEMA_UNBOUNDED,
} from "./protocol-utils/schema-budget.js";
export {
  type ActionParameter,
  convertJsonSchemaToActionParams,
  type McpInputSchema,
  validateParamsAgainstSchema,
} from "./protocol-utils/schema-converter.js";
export {
  type McpJsonSchema,
  type McpSchemaCompatibilityPolicy,
  transformMcpToolSchema,
} from "./protocol-utils/tool-schema-compatibility.js";
export { handleMcpRoutes, type McpRouteConfig, type McpRouteContext } from "./routes-mcp.js";
export { McpService } from "./service.js";
export {
  type HttpMcpServerConfig,
  isMcpSettings,
  MCP_SERVICE_NAME,
  type McpServerConfig,
  type McpSettings,
  type StdioMcpServerConfig,
} from "./types.js";
