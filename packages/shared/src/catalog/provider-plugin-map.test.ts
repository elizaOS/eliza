/** Preserves the published provider environment-key contract in the generated registry artifact. */
import { describe, expect, it } from "vitest";
import providerPluginMap from "./provider-plugin-map.json" with {
  type: "json",
};

const expectedProviderPluginMap = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  CEREBRAS_API_KEY: "@elizaos/plugin-openai",
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
  ELIZA_CHAT_VIA_CLI: "@elizaos/plugin-cli-inference",
  GEMINI_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
  NEARAI_API_KEY: "@elizaos/plugin-nearai",
  OLLAMA_API_ENDPOINT: "@elizaos/plugin-zerollama",
  OLLAMA_API_URL: "@elizaos/plugin-zerollama",
  OLLAMA_BASE_URL: "@elizaos/plugin-zerollama",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  ZAI_API_KEY: "@elizaos/plugin-zai",
  Z_AI_API_KEY: "@elizaos/plugin-zai",
};

describe("provider plugin map generation", () => {
  it("keeps the provider env contract in the generated artifact", () => {
    expect(providerPluginMap).toEqual(expectedProviderPluginMap);
  });
});
