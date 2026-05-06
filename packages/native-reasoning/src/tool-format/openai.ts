/**
 * NativeTool → OpenAI function tool converter (codex stealth backend).
 *
 * The chatgpt `/backend-api/codex/responses` endpoint accepts tools in
 * OpenAI's "responses" function-tool format. Our `NativeTool` already
 * carries a JSON-Schema `input_schema`, so this is a near-1:1 rename
 * with the discriminator flipped from `"custom"` to `"function"`.
 *
 * Strict mode is intentionally OFF: many tools in our default registry
 * (bash, file_ops, web, memory) attach `description` to nested property
 * objects, which OpenAI strict mode rejects (it requires every property
 * to be `required` and `additionalProperties:false` recursively). We
 * keep relaxed parsing — the model still gets the schema as a hint and
 * we already validate inside each handler.
 *
 * Pure / referentially transparent: no I/O, no globals, no mutation of
 * the inputs. Same input → same output, always.
 */

import type { NativeTool } from "../tool-schema.js";

/**
 * OpenAI Responses-API "function" tool. Mirrors the wire format used by
 * `https://chatgpt.com/backend-api/codex/responses` (and the public
 * `api.openai.com/v1/responses` endpoint, though we don't talk there).
 */
export interface OpenAITool {
  type: "function";
  name: string;
  description: string;
  /** JSON Schema. We forward `NativeTool.input_schema` verbatim. */
  parameters: object;
  /**
   * Whether the model must produce arguments matching the schema
   * exactly (no extra keys, every property required). Default: false.
   */
  strict?: boolean;
}

/** Convert a single NativeTool to an OpenAI function tool. */
export function toOpenAITool(tool: NativeTool): OpenAITool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  };
}

/** Convert an array of NativeTool to OpenAI function tools. */
export function toOpenAITools(tools: NativeTool[]): OpenAITool[] {
  return tools.map(toOpenAITool);
}
