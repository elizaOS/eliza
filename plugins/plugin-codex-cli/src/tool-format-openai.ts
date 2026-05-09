import type { ToolDefinition } from "@elizaos/core";

export interface OpenAITool {
  type: "function";
  name: string;
  description: string;
  parameters: object;
  strict?: boolean;
}

export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.parameters ?? { type: "object", properties: {} }) as object,
    strict: tool.strict ?? false,
  };
}

export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map(toOpenAITool);
}
