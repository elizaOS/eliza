import { jsonSchema } from "ai";

export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/** Preserve each caller's explicit tool strictness; schema policy belongs to the caller. */
export function convertTools(tools: ChatCompletionTool[] | undefined) {
  if (!tools?.length) return undefined;
  return Object.fromEntries(
    tools.map((tool) => [
      tool.function.name,
      {
        ...(tool.function.description ? { description: tool.function.description } : {}),
        ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {}),
        inputSchema: jsonSchema(tool.function.parameters ?? { type: "object" }),
        outputSchema: jsonSchema({ type: "object", additionalProperties: true }),
      },
    ]),
  );
}
