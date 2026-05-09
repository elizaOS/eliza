// @ts-nocheck — depends on @elizaos/core types currently bundled with the
// rest of plugin-local-ai under nocheck pending a core-types pass.
import type { JSONSchema, ToolDefinition } from "@elizaos/core";
import {
  defineChatSessionFunction,
  type GbnfJsonSchema,
  type ChatSessionModelFunctions,
  type ChatModelFunctionCall,
  type Llama,
  LlamaGrammar,
  LlamaJsonSchemaGrammar,
} from "node-llama-cpp";

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  type: "function";
}

export interface StructuredOutputContext {
  llama: Llama;
}

/**
 * Convert an elizaOS-shaped JSON schema to the Gbnf variant accepted by
 * node-llama-cpp's grammar / function-calling APIs. The two schema dialects
 * overlap heavily — node-llama-cpp tolerates `type: "object"` with
 * `properties` / `required` plus the standard scalar types — so we forward
 * the schema as-is. We narrow the type with a runtime check.
 */
export function toGbnfJsonSchema(schema: JSONSchema | undefined): GbnfJsonSchema | undefined {
  if (schema == null) return undefined;
  if (typeof schema !== "object") {
    throw new Error("[plugin-local-ai] JSON schema must be an object");
  }
  return schema as unknown as GbnfJsonSchema;
}

/**
 * Build a `functions` map for `LlamaChatSession.prompt({ functions })` from
 * the elizaOS `ToolDefinition[]` shape. The handler is a no-op: we want the
 * raw call objects back from `promptWithMeta`, not in-loop tool execution.
 * The runtime is responsible for executing the tool and looping back.
 */
export function buildLlamaFunctions(
  tools: readonly ToolDefinition[]
): ChatSessionModelFunctions {
  const out: Record<string, ReturnType<typeof defineChatSessionFunction>> = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    out[tool.name] = defineChatSessionFunction({
      description: tool.description,
      params: toGbnfJsonSchema(tool.parameters) as never,
      // The handler intentionally returns a sentinel. We collect the parsed
      // call from `promptWithMeta`'s response array; we do not execute the
      // tool in-process. node-llama-cpp requires a handler to be defined.
      handler: () => "[deferred to runtime]",
    });
  }
  return out;
}

/**
 * Pull parsed function calls out of a `promptWithMeta` response array.
 * Mirrors the OpenAI/Anthropic provider shape: `{ id, name, arguments }`.
 */
export function extractToolCalls(
  response: ReadonlyArray<string | ChatModelFunctionCall | unknown>
): ToolCallResult[] {
  const calls: ToolCallResult[] = [];
  let i = 0;
  for (const entry of response) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: string }).type === "functionCall"
    ) {
      const fc = entry as ChatModelFunctionCall;
      calls.push({
        id: `call_${i++}`,
        name: fc.name,
        arguments: (fc.params ?? {}) as Record<string, unknown>,
        type: "function",
      });
    }
  }
  return calls;
}

/**
 * Build a `LlamaJsonSchemaGrammar` for a caller-supplied JSON Schema. The
 * grammar constrains the model's output so it always parses as valid JSON
 * matching the schema.
 */
export function buildJsonSchemaGrammar(
  llama: Llama,
  schema: JSONSchema
): LlamaJsonSchemaGrammar<GbnfJsonSchema> {
  const gbnf = toGbnfJsonSchema(schema);
  if (gbnf == null) {
    throw new Error("[plugin-local-ai] responseSchema is required to build a JSON schema grammar");
  }
  return new LlamaJsonSchemaGrammar(llama, gbnf as GbnfJsonSchema);
}

/**
 * Get the canonical JSON grammar shipped with node-llama-cpp. Used when the
 * caller passes `responseFormat: { type: "json_object" }` without a specific
 * schema — output is constrained to be any valid JSON value.
 */
export async function buildGenericJsonGrammar(llama: Llama): Promise<LlamaGrammar> {
  return await LlamaGrammar.getFor(llama, "json");
}

export interface StructuredRequestPlan {
  kind: "text" | "tools" | "schema" | "json_object";
  functions?: ChatSessionModelFunctions;
  grammar?: LlamaGrammar;
}

/**
 * Decide which structured-output mode applies to a single generation call.
 * Tools take priority over schema; schema takes priority over generic JSON.
 */
export async function planStructuredRequest(
  ctx: StructuredOutputContext,
  params: {
    tools?: readonly ToolDefinition[];
    responseSchema?: JSONSchema;
    responseFormat?: { type: "json_object" | "text" } | string | undefined;
  }
): Promise<StructuredRequestPlan> {
  if (params.tools && params.tools.length > 0) {
    return { kind: "tools", functions: buildLlamaFunctions(params.tools) };
  }
  if (params.responseSchema) {
    const grammar = buildJsonSchemaGrammar(ctx.llama, params.responseSchema);
    return { kind: "schema", grammar };
  }
  if (params.responseFormat && typeof params.responseFormat === "object" && params.responseFormat.type === "json_object") {
    const grammar = await buildGenericJsonGrammar(ctx.llama);
    return { kind: "json_object", grammar };
  }
  return { kind: "text" };
}
