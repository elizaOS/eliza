/**
 * Cloud MCP compatibility facade over the shared schema traversal kernel;
 * the shared preflight rejects malformed or oversized schemas before rewriting.
 */
import { McpSchemaCompatibility } from "@elizaos/plugin-mcp/protocol-utils";
export type ModelProvider = "openai" | "anthropic" | "google" | "bitrouter" | "unknown";
export interface ModelInfo {
  provider: ModelProvider;
  modelId: string;
  supportsStructuredOutputs?: boolean;
  isReasoningModel?: boolean;
}
export abstract class McpToolCompatibility extends McpSchemaCompatibility<ModelInfo> {}
