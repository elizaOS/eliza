/**
 * elizaOS Plugin Ollama - Local LLM integration via Ollama
 *
 * This package provides Ollama integration for elizaOS,
 * supporting text generation, object generation, and embeddings
 * using locally-hosted models.
 *
 * @example
 * ```typescript
 * import { ollamaPlugin } from '@elizaos/plugin-ollama';
 *
 * // Add to your agent's plugins
 * const agent = createAgent({
 *   plugins: [ollamaPlugin],
 * });
 * ```
 */

export { ollamaPlugin, ollamaPlugin as default } from "./plugin";
export * from "./types";
export * from "./utils/config";
