import { asSchema } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import type { BatchFunctionTool } from "./batch";

export async function toolSetToBatchTools(tools: ToolSet): Promise<BatchFunctionTool[]> {
  const entries = Object.entries(tools);
  if (entries.length === 0) {
    return [];
  }

  const batchTools: BatchFunctionTool[] = [];
  for (const [name, tool] of entries) {
    if (tool.type === "provider") {
      throw new Error(`Batch mode does not support provider-defined tool "${name}".`);
    }

    batchTools.push({
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters: await asSchema(tool.inputSchema as never).jsonSchema,
        ...(tool.strict != null ? { strict: tool.strict } : {}),
      },
    });
  }

  return batchTools;
}
