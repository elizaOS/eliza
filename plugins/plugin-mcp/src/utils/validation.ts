import type { State } from "@elizaos/core";
import {
  type McpProviderData,
  type McpServerInfo,
  ResourceSelectionSchema,
  type ValidationResult,
} from "../types";
import { validateJsonSchema } from "./json";
import {
  type ResourceSelection,
  type ToolSelectionArgument,
  type ToolSelectionName,
  toolSelectionArgumentSchema,
  toolSelectionNameSchema,
} from "./schemas";

export type { ResourceSelection } from "./schemas";

export interface ToolSelection {
  readonly serverName: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reasoning?: string;
  readonly noToolAvailable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalReasoning(parsed: Record<string, unknown>): { readonly reasoning?: string } {
  return typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {};
}

export function validateToolSelectionName(
  parsed: unknown,
  state: State
): ValidationResult<ToolSelectionName> {
  if (isRecord(parsed) && parsed.noToolAvailable === true) {
    return {
      success: true,
      data: {
        serverName: "",
        toolName: "",
        noToolAvailable: true,
        ...optionalReasoning(parsed),
      },
    };
  }

  const basicResult = validateJsonSchema<ToolSelectionName>(parsed, toolSelectionNameSchema);
  if (basicResult.success === false) {
    return { success: false, error: basicResult.error };
  }

  const data = basicResult.data;
  const mcpData = (state.values.mcp ?? {}) as Record<string, McpServerInfo>;
  const server = mcpData[data.serverName];

  if (!server || server.status !== "connected") {
    return {
      success: false,
      error: `Server "${data.serverName}" not found or not connected`,
    };
  }

  const toolInfo = server.tools?.[data.toolName];
  if (!toolInfo) {
    return {
      success: false,
      error: `Tool "${data.toolName}" not found on server "${data.serverName}"`,
    };
  }

  return { success: true, data };
}

export function validateToolSelectionArgument(
  parsed: unknown,
  toolInputSchema: Readonly<Record<string, unknown>>
): ValidationResult<ToolSelectionArgument> {
  const normalizedParsed =
    isRecord(parsed) &&
    typeof parsed.toolArguments === "string" &&
    ["", "{}"].includes(parsed.toolArguments.trim())
      ? { ...parsed, toolArguments: {} }
      : parsed;

  const basicResult = validateJsonSchema<ToolSelectionArgument>(
    normalizedParsed,
    toolSelectionArgumentSchema
  );
  if (basicResult.success === false) {
    return { success: false, error: basicResult.error };
  }

  const data = basicResult.data;
  const validationResult = validateJsonSchema(data.toolArguments, toolInputSchema);

  if (validationResult.success === false) {
    return {
      success: false,
      error: `Invalid arguments: ${validationResult.error}`,
    };
  }

  return { success: true, data };
}

export function validateResourceSelection(selection: unknown): ValidationResult<ResourceSelection> {
  if (isRecord(selection) && selection.noResourceAvailable === true) {
    return {
      success: true,
      data: {
        serverName: "",
        uri: "",
        noResourceAvailable: true,
        ...optionalReasoning(selection),
      },
    };
  }

  return validateJsonSchema<ResourceSelection>(selection, ResourceSelectionSchema);
}

interface ToolDescription {
  readonly description?: string;
}

export function createToolSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  composedState: State,
  userMessage: string
): string {
  let toolsDescription = "";
  const mcpData = composedState.values.mcp as Record<string, McpProviderData[string]> | undefined;

  if (mcpData) {
    for (const [serverName, server] of Object.entries(mcpData)) {
      if (server.status !== "connected") continue;

      const tools = server.tools as Record<string, ToolDescription> | undefined;
      if (tools) {
        for (const [toolName, tool] of Object.entries(tools)) {
          toolsDescription += `Tool: ${toolName} (Server: ${serverName})\n`;
          toolsDescription += `Description: ${tool.description ?? "No description available"}\n\n`;
        }
      }
    }
  }

  return createFeedbackPrompt(
    originalResponse,
    errorMessage,
    "tool",
    toolsDescription,
    userMessage
  );
}

interface ResourceDescription {
  readonly description?: string;
  readonly name?: string;
}

export function createResourceSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  composedState: State,
  userMessage: string
): string {
  let resourcesDescription = "";
  const mcpData = composedState.values.mcp as Record<string, McpProviderData[string]> | undefined;

  if (mcpData) {
    for (const [serverName, server] of Object.entries(mcpData)) {
      if (server.status !== "connected") continue;

      const resources = server.resources as Record<string, ResourceDescription> | undefined;
      if (resources) {
        for (const [uri, resource] of Object.entries(resources)) {
          resourcesDescription += `Resource: ${uri} (Server: ${serverName})\n`;
          resourcesDescription += `Name: ${resource.name ?? "No name available"}\n`;
          resourcesDescription += `Description: ${
            resource.description ?? "No description available"
          }\n\n`;
        }
      }
    }
  }

  return createFeedbackPrompt(
    originalResponse,
    errorMessage,
    "resource",
    resourcesDescription,
    userMessage
  );
}

function createFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  itemType: string,
  itemsDescription: string,
  userMessage: string
): string {
  return `The previous ${itemType} selection could not be parsed or validated: ${errorMessage}

Your original response:
${originalResponse}

Reply again as compact JSON for ${itemType} selection.
Available ${itemType}s:
${itemsDescription}

User request: ${userMessage}

Use exact names from the list. For tools, return a JSON object with serverName, toolName, reasoning, and noToolAvailable. For resources, return a JSON object with serverName, uri, reasoning, and noResourceAvailable.`;
}
