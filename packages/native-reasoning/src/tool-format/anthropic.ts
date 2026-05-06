/**
 * Tool format adapter for Anthropic's `advanced-tool-use-2025-11-20` beta.
 *
 * NativeTool is already shaped for Anthropic (`type:"custom", input_schema`),
 * so this is mostly a passthrough. The adapter keeps the loop from importing
 * backend-specific wire shapes directly.
 */

import type { NativeTool } from "../tool-schema.js";

/** Anthropic beta tool wire shape. */
export interface AnthropicTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: NativeTool["input_schema"];
}

/** Convert NativeTool[] → Anthropic tool array. */
export function toAnthropicTools(tools: NativeTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    type: "custom",
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
