/**
 * Factory that selects the MCP tool-compatibility implementation for the
 * runtime's model provider. Provider implementations are imported statically so
 * source-based ESM test and development execution has the same resolution
 * contract as built output. Returns null for providers needing no schema fixup.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { detectModelProvider, type McpToolCompatibility } from "./base";
import { AnthropicMcpCompatibility } from "./providers/anthropic";
import { GoogleMcpCompatibility } from "./providers/google";
import { OpenAIMcpCompatibility } from "./providers/openai";

export {
  type ArrayConstraints,
  McpToolCompatibility,
  type ModelInfo,
  type ModelProvider,
  type NumberConstraints,
  type ObjectConstraints,
  type SchemaConstraints,
  type StringConstraints,
} from "./base";

export { detectModelProvider };

export async function createMcpToolCompatibility(
  runtime: IAgentRuntime
): Promise<McpToolCompatibility | null> {
  const modelInfo = detectModelProvider(runtime);

  switch (modelInfo.provider) {
    case "openai": {
      return new OpenAIMcpCompatibility(modelInfo);
    }
    case "anthropic": {
      return new AnthropicMcpCompatibility(modelInfo);
    }
    case "google": {
      return new GoogleMcpCompatibility(modelInfo);
    }
    default:
      return null;
  }
}

export function createMcpToolCompatibilitySync(
  runtime: IAgentRuntime
): McpToolCompatibility | null {
  const modelInfo = detectModelProvider(runtime);

  switch (modelInfo.provider) {
    case "openai": {
      return new OpenAIMcpCompatibility(modelInfo);
    }
    case "anthropic": {
      return new AnthropicMcpCompatibility(modelInfo);
    }
    case "google": {
      return new GoogleMcpCompatibility(modelInfo);
    }
    default:
      return null;
  }
}
