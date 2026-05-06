/**
 * Tool schema types and helpers for the native-reasoning loop.
 *
 * These types intentionally mirror Anthropic's `advanced-tool-use-2025-11-20`
 * beta wire format: every tool is `{type:"custom", name, description,
 * input_schema}`. We keep our own minimal types (rather than re-exporting
 * `BetaTool` from the SDK) so that handler/registry contracts stay stable
 * even as the SDK shifts beta surfaces.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";

/**
 * Minimal JSON Schema subset supported by Anthropic's tool input_schema.
 * Loose by design — Anthropic accepts most JSON Schema dialects; we just
 * ensure the top-level "type":"object" shape is encoded.
 */
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/**
 * Native Anthropic tool definition (advanced-tool-use-2025-11-20 beta).
 * `type: "custom"` distinguishes user-defined tools from server-side
 * Anthropic-managed tools (computer_use_*, bash_*, text_editor_*).
 */
export interface NativeTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: JSONSchema;
}

/** Tool execution result, matching Anthropic `tool_result` block content. */
export interface ToolHandlerResult {
  content: string;
  is_error?: boolean;
}

/**
 * Implementation of a tool. Receives the parsed input (already JSON, may be
 * unknown shape — handlers MUST validate), the agent runtime, and the
 * triggering message for context (room/entity/etc).
 */
export type NativeToolHandler = (
  input: unknown,
  runtime: IAgentRuntime,
  message: Memory,
) => Promise<ToolHandlerResult>;

export interface ToolEntry {
  tool: NativeTool;
  handler: NativeToolHandler;
}

export type ToolRegistry = Map<string, ToolEntry>;

/** Build the Anthropic-shaped tools[] array from a registry. */
export function buildToolsArray(registry: ToolRegistry): NativeTool[] {
  const out: NativeTool[] = [];
  for (const { tool } of registry.values()) {
    out.push(tool);
  }
  return out;
}

/** Convenience: register a tool, returning the same registry for chaining. */
export function registerTool(
  registry: ToolRegistry,
  tool: NativeTool,
  handler: NativeToolHandler,
): ToolRegistry {
  registry.set(tool.name, { tool, handler });
  return registry;
}
