/** Adapts shared MCP resource-selection validation to Cloud plugin result types. */
import { createMcpResourceSelectionFeedback } from "@elizaos/shared";
import { type McpProviderData } from "../types";
import { type State } from "@elizaos/core";
import { type ValidationResult } from "../types";
import { validateMcpResourceSelection } from "@elizaos/shared";
export interface ResourceSelection {
    serverName?: string;
    uri?: string;
    reasoning?: string;
    noResourceAvailable?: boolean;
}
export function validateResourceSelection(selection: unknown): ValidationResult<ResourceSelection> {
    return validateMcpResourceSelection(selection) as ValidationResult<ResourceSelection>;
}
export function createResourceSelectionFeedbackPrompt(originalResponse: string, errorMessage: string, composedState: State, userMessage: string): string {
    return createMcpResourceSelectionFeedback({
        originalResponse,
        errorMessage,
        providerData: (composedState.values.mcp ?? {}) as McpProviderData,
        userMessage,
    });
}
