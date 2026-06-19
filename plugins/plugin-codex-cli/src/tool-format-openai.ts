import type { ToolDefinition } from "@elizaos/core";

export interface OpenAITool {
  type: "function";
  name: string;
  description: string;
  parameters: object;
  strict?: boolean;
}

type JsonSchema = Record<string, unknown>;

/**
 * The ChatGPT codex backend enforces OpenAI strict-function-schema rules whenever
 * a tool is marked `strict: true`: every object schema MUST set
 * `additionalProperties: false` and list ALL of its `properties` keys in
 * `required`. elizaOS action tools (core's to-tool.ts) set `strict: true` but
 * author schemas with partial `required` and no `additionalProperties`, so the
 * backend rejects them with 400 "Invalid schema for function '<name>'". Other
 * providers tolerate this; the codex backend does not.
 *
 * `makeStrictSchema` normalizes a schema to be strict-compliant: `required`
 * becomes every property key, `additionalProperties` becomes false, and keys that
 * were NOT originally required are made nullable (a `null` union member) so the
 * now-required keys keep their optional semantics — the model may emit `null`
 * instead of being forced to invent a value.
 */
function makeNullable(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = schema as JsonSchema;
  if (Array.isArray(s.type)) {
    return (s.type as unknown[]).includes("null")
      ? s
      : { ...s, type: [...(s.type as unknown[]), "null"] };
  }
  if (typeof s.type === "string") return { ...s, type: [s.type, "null"] };
  return s;
}

function makeStrictSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(makeStrictSchema);
  const out = { ...(schema as JsonSchema) };
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as JsonSchema;
    const keys = Object.keys(props);
    const origRequired = new Set(
      Array.isArray(out.required) ? (out.required as string[]) : [],
    );
    const next: JsonSchema = {};
    for (const key of keys) {
      let prop = makeStrictSchema(props[key]);
      if (!origRequired.has(key)) prop = makeNullable(prop);
      next[key] = prop;
    }
    out.properties = next;
    out.required = keys;
    out.additionalProperties = false;
  }
  if (out.items) out.items = makeStrictSchema(out.items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(makeStrictSchema);
  }
  return out;
}

export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  const strict = tool.strict ?? false;
  const parameters = (tool.parameters ?? { type: "object", properties: {} }) as object;
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? "",
    // Only strict tools need normalization; the backend accepts loose schemas
    // verbatim when strict is false.
    parameters: strict ? (makeStrictSchema(parameters) as object) : parameters,
    strict,
  };
}

export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map(toOpenAITool);
}
