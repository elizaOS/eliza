/** Selects the model-specific MCP tool compatibility policy for hosted runtimes. */
export {
  McpToolCompatibility,
  type ModelInfo,
  type ModelProvider,
} from "./base";

import type { IAgentRuntime } from "@elizaos/core";
import { detectMcpModelProvider } from "@elizaos/shared/mcp";
import type { ModelInfo } from "./base";
import { AnthropicMcpCompatibility } from "./providers/anthropic";
import { GoogleMcpCompatibility } from "./providers/google";
import { OpenAIMcpCompatibility, OpenAIReasoningMcpCompatibility } from "./providers/openai";

export function detectModelProvider(runtime: IAgentRuntime): ModelInfo {
  const detected = detectMcpModelProvider(runtime);
  return {
    ...detected,
    // OpenRouter was not a distinct Cloud compatibility policy before the
    // shared detector existed, so preserve the facade's unknown fallback.
    provider: detected.provider === "openrouter" ? "unknown" : detected.provider,
  };
}

export function createMcpToolCompatibilitySync(runtime: IAgentRuntime) {
  const info = detectModelProvider(runtime);

  switch (info.provider) {
    case "openai":
      return info.isReasoningModel
        ? new OpenAIReasoningMcpCompatibility(info)
        : new OpenAIMcpCompatibility(info);
    case "anthropic":
      return new AnthropicMcpCompatibility(info);
    case "google":
      return new GoogleMcpCompatibility(info);
    default:
      return null;
  }
}
