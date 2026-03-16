/**
 * MCP Response Helpers
 */

import type { Content, Metadata } from "@elizaos/core";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Content
  | Metadata
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

type JsonObject = { [key: string]: JsonValue | undefined };

export function jsonResponse(data: JsonValue) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResponse(message: string, details?: JsonObject) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: message, ...(details ?? {}) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}
