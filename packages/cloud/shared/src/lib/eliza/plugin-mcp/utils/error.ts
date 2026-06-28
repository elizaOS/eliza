import {
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { errorAnalysisPrompt } from "../templates/errorAnalysisPrompt";
import type { McpProvider } from "../types";

export async function handleMcpError(
  state: State,
  mcpProvider: McpProvider,
  error: unknown,
  runtime: IAgentRuntime,
  message: Memory,
  type: "tool" | "resource",
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error({ error, mcpType: type }, `MCP ${type} error: ${errorMessage}`);

  const fallbackText = `I wasn't able to complete that request. There's an issue with the ${type}. Can I help with something else?`;
  let responseText = fallbackText;

  if (callback) {
    try {
      const prompt = composePromptFromState({
        state: {
          ...state,
          values: {
            ...state.values,
            mcpProvider,
            userMessage: message.content.text || "",
            error: errorMessage,
          },
        },
        template: errorAnalysisPrompt,
      });
      responseText = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    } catch {
      // Use fallback
    }

    await callback({
      thought: `MCP ${type} error: ${errorMessage}`,
      text: responseText,
      actions: ["REPLY"],
    });
  }

  return {
    text: `Failed to execute MCP ${type}`,
    values: { success: false, error: errorMessage, errorType: type },
    data: {
      actionName: type === "tool" ? "CALL_MCP_TOOL" : "READ_MCP_RESOURCE",
      error: errorMessage,
    },
    success: false,
    error: error instanceof Error ? error : new Error(errorMessage),
  };
}
