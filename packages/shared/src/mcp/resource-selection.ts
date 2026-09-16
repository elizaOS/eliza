/** Validates and describes model-selected MCP resources without host dependencies. */

import type { McpKernelProviderData } from "./protocol.js";

export interface McpResourceSelection {
  readonly serverName?: string;
  readonly uri?: string;
  readonly reasoning?: string;
  readonly noResourceAvailable?: boolean;
}

export type McpSelectionValidation<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMcpResourceSelection(
  selection: unknown,
): McpSelectionValidation<McpResourceSelection> {
  if (!isRecord(selection)) {
    return { success: false, error: "Resource selection must be an object" };
  }
  const reasoning =
    typeof selection.reasoning === "string"
      ? { reasoning: selection.reasoning }
      : {};
  if (selection.noResourceAvailable === true) {
    return {
      success: true,
      data: { noResourceAvailable: true, ...reasoning },
    };
  }
  if (
    typeof selection.serverName !== "string" ||
    selection.serverName.length === 0 ||
    typeof selection.uri !== "string" ||
    selection.uri.length === 0
  ) {
    return {
      success: false,
      error: "Resource selection requires non-empty serverName and uri",
    };
  }
  return {
    success: true,
    data: {
      serverName: selection.serverName,
      uri: selection.uri,
      noResourceAvailable: false,
      ...reasoning,
    },
  };
}

export function describeMcpResources(data: McpKernelProviderData): string {
  const lines: string[] = [];
  for (const [serverName, server] of Object.entries(data)) {
    if (server.status !== "connected") continue;
    for (const [uri, resource] of Object.entries(server.resources)) {
      lines.push(
        `Resource: ${uri} (Server: ${serverName})`,
        `Name: ${resource.name || "No name available"}`,
        `Description: ${resource.description || "No description available"}`,
        "",
      );
    }
  }
  return lines.join("\n");
}

export function createMcpResourceSelectionFeedback(input: {
  readonly originalResponse: string;
  readonly errorMessage: string;
  readonly providerData: McpKernelProviderData;
  readonly userMessage: string;
}): string {
  return `The previous resource selection could not be parsed or validated: ${input.errorMessage}

Your original response:
${input.originalResponse}

Reply again as compact JSON for resource selection.
Available resources:
${describeMcpResources(input.providerData)}
User request: ${input.userMessage}`;
}
