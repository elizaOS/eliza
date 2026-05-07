import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVICE_NAME } from "../types";
import { generateSimiles, makeUniqueActionName } from "../utils/action-naming";
import { checkMcpOAuthAccess } from "../utils/mcp";
import { processToolResult } from "../utils/processing";
import {
  type ActionParameter,
  convertJsonSchemaToActionParams,
  validateParamsAgainstSchema,
} from "../utils/schema-converter";

export interface McpToolAction extends Omit<Action, "parameters"> {
  parameters?: ActionParameter[];
  _mcpMeta: {
    serverName: string;
    toolName: string;
    originalSchema: Tool["inputSchema"];
  };
}

interface McpToolActionService {
  isLazyConnection(serverName: string): boolean;
  getServers(): { name: string; status?: string; tools?: Tool[] }[];
  callTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

function extractParams(message: Memory, state?: State): Record<string, unknown> {
  const content = message.content as Record<string, unknown>;
  return (
    (content.actionParams as Record<string, unknown>) ||
    (content.actionInput as Record<string, unknown>) ||
    (state?.data?.actionParams as Record<string, unknown>) ||
    {}
  );
}

const MCP_ACTION_CONTEXTS = ["connectors", "automation", "knowledge"];

function hasSelectedContext(state: State | undefined): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  return selected.some((context) => MCP_ACTION_CONTEXTS.includes(String(context).toLowerCase()));
}

function collectText(message: Memory, state?: State): string {
  return [
    message.content?.text,
    state?.values?.conversationLog,
    state?.values?.recentMessages,
    state?.values?.mcp,
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join("\n")
    .toLowerCase();
}

export function createMcpToolAction(
  serverName: string,
  tool: Tool,
  existingNames: Set<string>,
): McpToolAction {
  const actionName = makeUniqueActionName(serverName, tool.name, existingNames);
  const description = `${tool.description || `Execute ${tool.name}`} (MCP: ${serverName}/${tool.name})`;

  return {
    name: actionName,
    description,
    similes: generateSimiles(serverName, tool.name),
    contexts: MCP_ACTION_CONTEXTS,
    contextGate: { anyOf: MCP_ACTION_CONTEXTS },
    parameters: convertJsonSchemaToActionParams(tool.inputSchema),

    validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
      const svc = runtime.getService(MCP_SERVICE_NAME) as McpToolActionService | null;
      if (!svc) return false;

      // Check if the current user has OAuth access to this server.
      // MCP_ENABLED_SERVERS is set per-request in the request context by
      // RuntimeFactory.applyUserContext() based on the user's OAuth connections.
      // When not set (CLI, non-cloud contexts), filtering is skipped (fail-open by design).
      if (!checkMcpOAuthAccess(runtime, serverName)) return false;

      const text = collectText(message, state);
      const actionTerms = [
        actionName,
        serverName,
        tool.name,
        tool.description || "",
        ...generateSimiles(serverName, tool.name),
      ]
        .flatMap((term) =>
          String(term)
            .toLowerCase()
            .split(/[^a-z0-9_\-\p{L}\p{N}]+/u),
        )
        .filter((term) => term.length >= 3);
      const relevant = actionTerms.some((term) => text.includes(term.toLowerCase()));
      if (!hasSelectedContext(state) && !relevant) return false;

      if (svc.isLazyConnection(serverName)) return true;

      const server = svc.getServers().find((s) => s.name === serverName);
      return server?.status === "connected" && !!server.tools?.some((t) => t.name === tool.name);
    },

    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State | undefined,
      _options: HandlerOptions | undefined,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const svc = runtime.getService(MCP_SERVICE_NAME) as McpToolActionService | null;
      if (!svc) {
        return {
          success: false,
          error: "MCP service not available",
          data: { actionName, serverName, toolName: tool.name },
        };
      }

      const params = extractParams(message, state);
      logger.info({ serverName, toolName: tool.name, params }, `[MCP] Executing ${actionName}`);

      const errors = validateParamsAgainstSchema(params, tool.inputSchema);
      const missing = errors.filter((e) => e.startsWith("Missing required"));
      if (missing.length > 0) {
        logger.error({ missing, params }, `[MCP] Missing required params for ${actionName}`);
        return {
          success: false,
          error: missing.join(", "),
          data: { actionName, serverName, toolName: tool.name },
        };
      }

      const warnings = errors.filter((e) => !e.startsWith("Missing required"));
      if (warnings.length > 0) {
        logger.warn({ warnings, params }, `[MCP] Type warnings for ${actionName}`);
      }

      let result: CallToolResult;
      try {
        result = await svc.callTool(serverName, tool.name, params);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          { serverName, toolName: tool.name, error: errorMessage },
          "[MCP] Tool call failed",
        );
        return {
          success: false,
          error: errorMessage,
          text: `Failed to execute ${serverName}/${tool.name}: ${errorMessage}`,
          data: {
            actionName,
            serverName,
            toolName: tool.name,
            toolArguments: params,
          },
        };
      }
      const { toolOutput, hasAttachments, attachments } = processToolResult(
        result,
        serverName,
        tool.name,
        runtime,
        String(message.entityId ?? ""),
      );

      if (result.isError) {
        logger.error({ serverName, toolName: tool.name, output: toolOutput }, "[MCP] Tool error");
        return {
          success: false,
          error: toolOutput || "Tool execution failed",
          text: toolOutput,
          data: {
            actionName,
            serverName,
            toolName: tool.name,
            toolArguments: params,
            isError: true,
          },
        };
      }

      if (callback && hasAttachments && attachments.length > 0) {
        await callback({
          text: `Executed ${serverName}/${tool.name}`,
          attachments,
        });
      }

      return {
        success: true,
        text: toolOutput,
        values: {
          success: true,
          serverName,
          toolName: tool.name,
          hasAttachments,
          output: toolOutput,
        },
        data: {
          actionName,
          serverName,
          toolName: tool.name,
          toolArguments: params,
          output: toolOutput,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      };
    },

    examples: [
      [
        { name: "{{user}}", content: { text: `Can you use ${tool.name}?` } },
        {
          name: "{{assistant}}",
          content: {
            text: `I'll execute ${tool.name} for you.`,
            actions: [actionName],
          },
        },
      ],
    ],

    _mcpMeta: {
      serverName,
      toolName: tool.name,
      originalSchema: tool.inputSchema,
    },
  };
}

export function createMcpToolActions(
  serverName: string,
  tools: Tool[],
  existingNames: Set<string>,
): McpToolAction[] {
  const actions = tools.map((tool) => {
    const action = createMcpToolAction(serverName, tool, existingNames);
    existingNames.add(String(action.name));
    logger.debug(
      { actionName: action.name, serverName, toolName: tool.name },
      "[MCP] Created action",
    );
    return action;
  });

  logger.info(
    { serverName, toolCount: actions.length },
    `[MCP] Created ${actions.length} actions for ${serverName}`,
  );
  return actions;
}

export function isMcpToolAction(action: Action | McpToolAction): action is McpToolAction {
  return "_mcpMeta" in action && typeof (action as McpToolAction)._mcpMeta === "object";
}

export function getMcpToolActionsForServer(
  actions: (Action | McpToolAction)[],
  serverName: string,
): McpToolAction[] {
  return actions.filter(
    (a): a is McpToolAction => isMcpToolAction(a) && a._mcpMeta.serverName === serverName,
  );
}
