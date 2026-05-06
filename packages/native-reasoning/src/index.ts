/**
 * @elizaos/native-reasoning — public surface.
 *
 * Wave 1.A exposes the loop, the tool-schema types, and the system-prompt
 * assembler. Concrete tools (bash, file ops, web, recall, spawn_codex) and
 * the discord interceptor land in subsequent waves.
 */

import type { Plugin } from "@elizaos/core";

export {
  type AnthropicClientLike,
  type RunOptions,
  runNativeReasoningLoop,
} from "./loop.js";

export {
  assembleSystemPrompt,
  clearSystemPromptCache,
} from "./system-prompt.js";

export {
  buildToolsArray,
  type JSONSchema,
  type NativeTool,
  type NativeToolHandler,
  registerTool,
  type ToolEntry,
  type ToolHandlerResult,
  type ToolRegistry,
} from "./tool-schema.js";

export { buildDefaultRegistry } from "./tools/registry.js";

/**
 * Plugin manifest. The native-reasoning loop is invoked directly by the
 * discord interceptor (Wave 1.D) — not through the eliza Action pipeline —
 * so this manifest is intentionally minimal: a name, description, and a
 * noop init for registration symmetry with the rest of the plugin system.
 */
export const nativeReasoningPlugin: Plugin = {
  name: "native-reasoning",
  description:
    "Single-call multi-tool reasoning loop using native Anthropic tool use.",
  init: async () => {
    // No runtime services to register at this stage. Wave 1.D wires the
    // discord interceptor; Wave 1.B registers concrete tools.
  },
};

export default nativeReasoningPlugin;
