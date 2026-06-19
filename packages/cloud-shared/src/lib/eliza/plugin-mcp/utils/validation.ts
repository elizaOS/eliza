import type { State } from "@elizaos/core";
import { type McpProviderData, ResourceSelectionSchema, type ValidationResult } from "../types";
import { validateJsonSchema } from "./json";

export interface ResourceSelection {
  serverName?: string;
  uri?: string;
  reasoning?: string;
  noResourceAvailable?: boolean;
}

export function validateResourceSelection(selection: unknown): ValidationResult<ResourceSelection> {
  return validateJsonSchema<ResourceSelection>(selection, ResourceSelectionSchema);
}

export function createResourceSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  composedState: State,
  userMessage: string,
): string {
  let description = "";

  for (const [serverName, server] of Object.entries(composedState.values.mcp || {}) as [
    string,
    McpProviderData[string],
  ][]) {
    if (server.status !== "connected") continue;

    for (const [uri, resource] of Object.entries(server.resources || {}) as [
      string,
      { description?: string; name?: string },
    ][]) {
      description += `Resource: ${uri} (Server: ${serverName})\n`;
      description += `Name: ${resource.name || "No name"}\n`;
      description += `Description: ${resource.description || "No description"}\n\n`;
    }
  }

  return `Error parsing JSON: ${errorMessage}

Your original response:
${originalResponse}

Please try again with valid JSON for resource selection.
Available resources:
${description}

User request: ${userMessage}`;
}
