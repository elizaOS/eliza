/** Adapts shared MCP resource-selection validation to Cloud plugin result types. */
import type { State } from "@elizaos/core";
import {
  createMcpResourceSelectionFeedback,
  validateMcpResourceSelection,
} from "@elizaos/shared/mcp";
import { type McpProviderData, type ValidationResult } from "../types";

export interface ResourceSelection {
  serverName?: string;
  uri?: string;
  reasoning?: string;
  noResourceAvailable?: boolean;
}

export function validateResourceSelection(selection: unknown): ValidationResult<ResourceSelection> {
  return validateMcpResourceSelection(selection) as ValidationResult<ResourceSelection>;
}

export function createResourceSelectionFeedbackPrompt(
  originalResponse: string,
  errorMessage: string,
  composedState: State,
  userMessage: string,
): string {
  return createMcpResourceSelectionFeedback({
    originalResponse,
    errorMessage,
    providerData: (composedState.values.mcp ?? {}) as McpProviderData,
    userMessage,
  });
}
