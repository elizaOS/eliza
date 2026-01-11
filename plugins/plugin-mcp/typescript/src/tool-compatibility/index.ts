import type { IAgentRuntime } from "@elizaos/core";
import { detectModelProvider, type McpToolCompatibility } from "./base";

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
      const { OpenAIMcpCompatibility } = await import("./providers/openai.js");
      return new OpenAIMcpCompatibility(modelInfo);
    }
    case "anthropic": {
      const { AnthropicMcpCompatibility } = await import("./providers/anthropic.js");
      return new AnthropicMcpCompatibility(modelInfo);
    }
    case "google": {
      const { GoogleMcpCompatibility } = await import("./providers/google.js");
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
      const { OpenAIMcpCompatibility } = require("./providers/openai");
      return new OpenAIMcpCompatibility(modelInfo);
    }
    case "anthropic": {
      const { AnthropicMcpCompatibility } = require("./providers/anthropic");
      return new AnthropicMcpCompatibility(modelInfo);
    }
    case "google": {
      const { GoogleMcpCompatibility } = require("./providers/google");
      return new GoogleMcpCompatibility(modelInfo);
    }
    default:
      return null;
  }
}
