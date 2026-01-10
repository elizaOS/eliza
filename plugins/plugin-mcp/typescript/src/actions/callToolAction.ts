import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { McpService } from "../service";
import { MCP_SERVICE_NAME, type McpServer } from "../types";
import { handleMcpError } from "../utils/error";
import { handleNoToolAvailable } from "../utils/handler";
import { handleToolResponse, processToolResult } from "../utils/processing";
import { createToolSelectionArgument, createToolSelectionName } from "../utils/selection";

export const callToolAction: Action = {
  name: "CALL_MCP_TOOL",
  similes: [
    "CALL_TOOL",
    "CALL_MCP_TOOL",
    "USE_TOOL",
    "USE_MCP_TOOL",
    "EXECUTE_TOOL",
    "EXECUTE_MCP_TOOL",
    "RUN_TOOL",
    "RUN_MCP_TOOL",
    "INVOKE_TOOL",
    "INVOKE_MCP_TOOL",
  ],
  description: "Calls a tool from an MCP server to perform a specific task",

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!mcpService) return false;

    const servers = mcpService.getServers();
    return (
      servers.length > 0 &&
      servers.some(
        (server: McpServer) =>
          server.status === "connected" && server.tools && server.tools.length > 0
      )
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const composedState = await runtime.composeState(message, ["RECENT_MESSAGES", "MCP"]);
    const mcpService = runtime.getService<McpService>(MCP_SERVICE_NAME);
    if (!mcpService) {
      throw new Error("MCP service not available");
    }
    const mcpProvider = mcpService.getProviderData();

    try {
      const toolSelectionName = await createToolSelectionName({
        runtime,
        state: composedState,
        message,
        callback,
        mcpProvider,
      });
      if (!toolSelectionName || toolSelectionName.noToolAvailable) {
        logger.warn("[NO_TOOL_AVAILABLE] No appropriate tool available for the request");
        return await handleNoToolAvailable(callback, toolSelectionName);
      }
      const { serverName, toolName, reasoning } = toolSelectionName;
      logger.info(
        `[CALLING] Calling tool "${serverName}/${toolName}" on server with reasoning: "${reasoning}"`
      );

      const toolSelectionArgument = await createToolSelectionArgument({
        runtime,
        state: composedState,
        message,
        callback,
        mcpProvider,
        toolSelectionName,
      });
      if (!toolSelectionArgument) {
        logger.warn(
          "[NO_TOOL_SELECTION_ARGUMENT] No appropriate tool selection argument available"
        );
        return await handleNoToolAvailable(callback, toolSelectionName);
      }
      logger.info(
        `[SELECTED] Tool Selection result:\n${JSON.stringify(toolSelectionArgument, null, 2)}`
      );

      const result = await mcpService.callTool(
        serverName,
        toolName,
        toolSelectionArgument.toolArguments
      );

      const { toolOutput, hasAttachments, attachments } = processToolResult(
        result,
        serverName,
        toolName,
        runtime,
        message.entityId
      );

      const replyMemory = await handleToolResponse(
        runtime,
        message,
        serverName,
        toolName,
        toolSelectionArgument.toolArguments,
        toolOutput,
        hasAttachments,
        attachments,
        composedState,
        mcpProvider,
        callback
      );

      return {
        text: `Successfully called tool: ${serverName}/${toolName}. Reasoned response: ${replyMemory.content.text}`,
        values: {
          success: true,
          toolExecuted: true,
          serverName,
          toolName,
          hasAttachments,
          output: toolOutput,
        },
        data: {
          actionName: "CALL_MCP_TOOL",
          serverName,
          toolName,
          toolArguments: toolSelectionArgument.toolArguments,
          reasoning: toolSelectionName.reasoning,
          output: toolOutput,
          attachments: attachments ?? [],
        },
        success: true,
      };
    } catch (error) {
      return await handleMcpError(
        composedState,
        mcpProvider,
        error,
        runtime,
        message,
        "tool",
        callback
      );
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Can you search for information about climate change?",
        },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I'll help you with that request. Let me access the right tool...",
          actions: ["CALL_MCP_TOOL"],
        },
      },
      {
        name: "{{assistant}}",
        content: {
          text: "I found the following information about climate change:\n\nClimate change refers to long-term shifts in temperatures and weather patterns. These shifts may be natural, but since the 1800s, human activities have been the main driver of climate change, primarily due to the burning of fossil fuels like coal, oil, and gas, which produces heat-trapping gases.",
          actions: ["CALL_MCP_TOOL"],
        },
      },
    ],
  ],
};
