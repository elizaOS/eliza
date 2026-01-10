import {
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import {
  toolSelectionArgumentTemplate,
  toolSelectionNameTemplate,
} from "../templates/toolSelectionTemplate";
import type { McpProvider, McpProviderData, McpToolInfo } from "../types";
import type { ToolSelectionArgument, ToolSelectionName } from "./schemas";
import { validateToolSelectionArgument, validateToolSelectionName } from "./validation";
import { withModelRetry } from "./wrapper";

export interface CreateToolSelectionOptions {
  readonly runtime: IAgentRuntime;
  readonly state: State;
  readonly message: Memory;
  readonly callback?: HandlerCallback;
  readonly mcpProvider: McpProvider;
  readonly toolSelectionName?: ToolSelectionName;
}

/**
 * Creates a tool selection name based on the current state and MCP provider.
 * @returns A tool selection name object or null if the selection is invalid.
 */
export async function createToolSelectionName({
  runtime,
  state,
  message,
  callback,
  mcpProvider,
}: CreateToolSelectionOptions): Promise<ToolSelectionName | null> {
  const toolSelectionPrompt: string = composePromptFromState({
    state: { ...state, values: { ...state.values, mcpProvider } },
    template: toolSelectionNameTemplate,
  });
  logger.debug(`[SELECTION] Tool Selection Name Prompt:\n${toolSelectionPrompt}`);

  const toolSelectionName = (await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: toolSelectionPrompt,
  })) as string;
  logger.debug(`[SELECTION] Tool Selection Name Response:\n${toolSelectionName}`);

  return await withModelRetry<ToolSelectionName>({
    runtime,
    message,
    state,
    callback,
    input: toolSelectionName,
    validationFn: (parsed) => validateToolSelectionName(parsed, state),
    createFeedbackPromptFn: (originalResponse, errorMessage, composedState, userMessage) =>
      createToolSelectionFeedbackPrompt(
        typeof originalResponse === "string" ? originalResponse : JSON.stringify(originalResponse),
        errorMessage,
        composedState,
        userMessage
      ),
    failureMsg: "I'm having trouble figuring out the best way to help with your request.",
  });
}

/**
 * Creates a tool selection argument based on the current state and MCP provider.
 * @returns A tool selection argument object or null if the selection is invalid.
 */
export async function createToolSelectionArgument({
  runtime,
  state,
  message,
  callback,
  mcpProvider,
  toolSelectionName,
}: CreateToolSelectionOptions): Promise<ToolSelectionArgument | null> {
  if (!toolSelectionName) {
    throw new Error("Tool selection name is required to create tool selection argument");
  }

  const { serverName, toolName } = toolSelectionName;
  const serverData = mcpProvider.data.mcp[serverName];

  if (!serverData) {
    throw new Error(`Server "${serverName}" not found in MCP provider data`);
  }

  const toolData = serverData.tools[toolName];
  if (!toolData) {
    throw new Error(`Tool "${toolName}" not found on server "${serverName}"`);
  }

  const toolInputSchema = toolData.inputSchema ?? {};
  logger.trace(`[SELECTION] Tool Input Schema:\n${JSON.stringify({ toolInputSchema }, null, 2)}`);

  const toolSelectionArgumentPrompt: string = composePromptFromState({
    state: {
      ...state,
      values: {
        ...state.values,
        toolSelectionName,
        toolInputSchema: JSON.stringify(toolInputSchema),
      },
    },
    template: toolSelectionArgumentTemplate,
  });
  logger.debug(`[SELECTION] Tool Selection Prompt:\n${toolSelectionArgumentPrompt}`);

  const toolSelectionArgument = (await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: toolSelectionArgumentPrompt,
  })) as string;
  logger.debug(`[SELECTION] Tool Selection Argument Response:\n${toolSelectionArgument}`);

  return await withModelRetry<ToolSelectionArgument>({
    runtime,
    message,
    state,
    callback,
    input: toolSelectionArgument,
    validationFn: (parsed) => validateToolSelectionArgument(parsed, toolInputSchema),
    createFeedbackPromptFn: (originalResponse, errorMessage, composedState, userMessage) =>
      createToolSelectionFeedbackPrompt(
        typeof originalResponse === "string" ? originalResponse : JSON.stringify(originalResponse),
        errorMessage,
        composedState,
        userMessage
      ),
    failureMsg: "I'm having trouble figuring out the best way to help with your request.",
  });
}

function createToolSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  state: State,
  userMessage: string
): string {
  let toolsDescription = "";
  const mcpData = state.values.mcp as Record<string, McpProviderData[string]> | undefined;

  if (mcpData) {
    for (const [serverName, server] of Object.entries(mcpData)) {
      if (server.status !== "connected") continue;

      const tools = server.tools as Record<string, McpToolInfo> | undefined;
      if (tools) {
        for (const [toolName, tool] of Object.entries(tools)) {
          toolsDescription += `Tool: ${toolName} (Server: ${serverName})\n`;
          toolsDescription += `Description: ${tool.description ?? "No description available"}\n\n`;
        }
      }
    }
  }

  const feedbackPrompt = createFeedbackPrompt(
    originalResponse,
    errorMessage,
    "tool",
    toolsDescription,
    userMessage
  );
  logger.debug(`[SELECTION] Tool Selection Feedback Prompt:\n${feedbackPrompt}`);
  return feedbackPrompt;
}

function createFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  itemType: string,
  itemsDescription: string,
  userMessage: string
): string {
  return `Error parsing JSON: ${errorMessage}
  
  Your original response:
  ${originalResponse}
  
  Please try again with valid JSON for ${itemType} selection.
  Available ${itemType}s:
  ${itemsDescription}
  
  User request: ${userMessage}`;
}
