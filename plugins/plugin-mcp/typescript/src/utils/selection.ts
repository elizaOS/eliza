import {
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import {
  toolSelectionArgumentTemplate,
  toolSelectionNameTemplate,
} from "../templates/toolSelectionTemplate";
import type { McpProvider } from "../types";
import type { ToolSelectionArgument, ToolSelectionName } from "./schemas";
import {
  createToolSelectionFeedbackPrompt,
  validateToolSelectionArgument,
  validateToolSelectionName,
} from "./validation";
import { withModelRetry } from "./wrapper";

export interface CreateToolSelectionOptions {
  readonly runtime: IAgentRuntime;
  readonly state: State;
  readonly message: Memory;
  readonly callback?: HandlerCallback;
  readonly mcpProvider: McpProvider;
  readonly toolSelectionName?: ToolSelectionName;
}

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

  const toolSelectionName = (await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: toolSelectionPrompt,
  })) as string;

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

  const toolSelectionArgument = (await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: toolSelectionArgumentPrompt,
  })) as string;

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
